import { createHash } from 'node:crypto';
import { platformString } from '#lib/registries.ts';
import type { Descriptor, ImagePlatform } from '#lib/types.ts';
import type { ManifestInput } from '../store.ts';

/** Every manifest kind we read, most specific first; registries answer with the one they have. */
export const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
	'application/vnd.docker.distribution.manifest.v1+prettyjws;q=0.5'
].join(', ');

const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);

export class RegistryError extends Error {
	status: number;
	constructor(message: string, status = 502) {
		super(message);
		this.status = status;
	}
}

export type Credentials = { username: string; password: string } | null;

export type Challenge = { scheme: string; params: Record<string, string> };

/** Parses a WWW-Authenticate header: `Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header: string | null): Challenge | null {
	if (!header) return null;
	const m = /^\s*(\w+)\s*(.*)$/s.exec(header);
	if (!m) return null;
	const params: Record<string, string> = {};
	for (const p of m[2].matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
	return { scheme: m[1].toLowerCase(), params };
}

/** The `next` URL from a `Link: </v2/…?last=x>; rel="next"` header, resolved against the base. */
export function nextLink(header: string | null, base: string): string | null {
	const m = header && /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header);
	return m ? new URL(m[1], base).toString() : null;
}

const TIMEOUT = 30_000;

/**
 * A client for the registry API (the OCI distribution spec), with its token dance: ask, get a
 * 401 naming a token server and scope, fetch a token there (with Basic credentials when we have
 * them), ask again. Tokens are kept per scope until they expire.
 */
export class RegistryClient {
	private tokens = new Map<string, { token: string; expires: number }>();
	/** Once a registry has asked for Basic, send it up front. */
	private basic = false;

	readonly base: string;
	private credentials: () => Promise<Credentials>;

	constructor(base: string, credentials: () => Promise<Credentials>) {
		this.base = base;
		this.credentials = credentials;
	}

	async request(path: string, opts: { method?: string; headers?: Record<string, string>; scope?: string; timeout?: number } = {}): Promise<Response> {
		const url = /^https?:/.test(path) ? path : `${this.base}${path}`;
		const scope = opts.scope ?? '';
		const send = async (auth: string | null) => {
			const headers: Record<string, string> = { ...opts.headers };
			if (auth) headers.authorization = auth;
			try {
				return await fetch(url, { method: opts.method ?? 'GET', headers, signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT), redirect: 'follow' });
			} catch (err) {
				throw new RegistryError(`Can't reach ${new URL(url).host}: ${causeOf(err)}`);
			}
		};
		let res = await send(await this.authFor(scope));
		if (res.status !== 401) return res;
		const challenge = parseChallenge(res.headers.get('www-authenticate'));
		await res.body?.cancel();
		if (challenge?.scheme === 'basic') {
			this.basic = true;
			const auth = await this.basicHeader();
			if (!auth) throw new RegistryError('The registry wants a username and password', 401);
			res = await send(auth);
		} else if (challenge?.scheme === 'bearer' && challenge.params.realm) {
			const token = await this.fetchToken(challenge, scope);
			res = await send(`Bearer ${token}`);
		}
		if (res.status === 401) {
			await res.body?.cancel();
			throw new RegistryError('The registry refused these credentials', 401);
		}
		return res;
	}

	async json<T>(path: string, opts: { scope?: string; headers?: Record<string, string> } = {}): Promise<{ data: T; res: Response }> {
		const res = await this.request(path, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
		if (!res.ok) throw await errorFrom(res);
		return { data: (await res.json()) as T, res };
	}

	private async authFor(scope: string): Promise<string | null> {
		const t = this.tokens.get(scope);
		if (t && t.expires > Date.now()) return `Bearer ${t.token}`;
		return this.basic ? this.basicHeader() : null;
	}

	private async basicHeader(): Promise<string | null> {
		const c = await this.credentials();
		return c ? `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` : null;
	}

	private async fetchToken(ch: Challenge, scope: string): Promise<string> {
		const url = new URL(ch.params.realm);
		if (ch.params.service) url.searchParams.set('service', ch.params.service);
		// The challenge names the scope it wants; ours may ask for more (e.g. delete).
		for (const s of new Set([ch.params.scope, scope].filter(Boolean))) for (const part of s.split(' ')) url.searchParams.append('scope', part);
		const auth = await this.basicHeader();
		let res: Response;
		try {
			res = await fetch(url, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(TIMEOUT) });
		} catch (err) {
			throw new RegistryError(`Can't reach the token server at ${url.host}: ${causeOf(err)}`);
		}
		if (res.status === 401 || res.status === 403) throw new RegistryError('The registry refused these credentials', 401);
		if (!res.ok) throw await errorFrom(res, 'Token server');
		const body = (await res.json()) as { token?: string; access_token?: string; expires_in?: number };
		const token = body.token ?? body.access_token;
		if (!token) throw new RegistryError('The token server answered without a token');
		// Tokens default to 60 s; renew a little early.
		this.tokens.set(scope, { token, expires: Date.now() + Math.max(30, (body.expires_in ?? 60) - 15) * 1000 });
		return token;
	}

	/* ---------- the API ---------- */

	/** Checks the credentials work: GET /v2/ answers 200 once signed in. */
	async ping(): Promise<void> {
		try {
			const res = await this.request('/v2/');
			await res.body?.cancel();
			if (!res.ok && res.status !== 404) throw await errorFrom(res);
		} catch (err) {
			// Anonymous access is granted per repository (ghcr.io, Docker Hub): /v2/ itself stays closed.
			if (err instanceof RegistryError && err.status === 401 && !(await this.credentials())) return;
			throw err;
		}
	}

	/** The registry's repository list, where it allows that (registry:2, Harbor, GitLab…). */
	async catalog(limit = 10_000): Promise<string[]> {
		const out: string[] = [];
		let next: string | null = `${this.base}/v2/_catalog?n=1000`;
		while (next && out.length < limit) {
			const { data, res }: { data: { repositories?: string[] }; res: Response } = await this.json(next, { scope: 'registry:catalog:*' });
			out.push(...(data.repositories ?? []));
			next = nextLink(res.headers.get('link'), this.base);
		}
		return out;
	}

	async tags(repo: string): Promise<string[]> {
		const out: string[] = [];
		let next: string | null = `${this.base}/v2/${repo}/tags/list?n=1000`;
		while (next) {
			const { data, res }: { data: { tags?: string[] | null }; res: Response } = await this.json(next, { scope: pullScope(repo) });
			out.push(...(data.tags ?? []));
			next = nextLink(res.headers.get('link'), this.base);
			if (out.length > 100_000) break;
		}
		return out;
	}

	/** The digest a tag points at, from a HEAD (which doesn't count against Docker Hub's pull limit). */
	async resolve(repo: string, ref: string): Promise<{ digest: string; mediaType: string | null }> {
		const res = await this.request(`/v2/${repo}/manifests/${ref}`, { method: 'HEAD', headers: { accept: MANIFEST_ACCEPT }, scope: pullScope(repo) });
		if (res.ok && res.headers.get('docker-content-digest')) {
			return { digest: res.headers.get('docker-content-digest')!, mediaType: res.headers.get('content-type') };
		}
		if (!res.ok && res.status !== 405) throw await errorFrom(res, `${repo}:${ref}`);
		const m = await this.manifest(repo, ref);
		return { digest: m.digest, mediaType: m.mediaType };
	}

	async manifest(repo: string, ref: string): Promise<{ digest: string; mediaType: string; raw: Buffer; json: Manifest }> {
		const res = await this.request(`/v2/${repo}/manifests/${ref}`, { headers: { accept: MANIFEST_ACCEPT }, scope: pullScope(repo) });
		if (!res.ok) throw await errorFrom(res, `${repo}@${ref}`);
		const raw = Buffer.from(await res.arrayBuffer());
		const json = JSON.parse(raw.toString('utf8')) as Manifest;
		const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
		if (ref.startsWith('sha256:') && ref !== digest) throw new RegistryError(`The registry sent a manifest that doesn't match ${ref}`);
		const mediaType = json.mediaType ?? res.headers.get('content-type')?.split(';')[0] ?? 'application/vnd.oci.image.manifest.v1+json';
		return { digest, mediaType, raw, json };
	}

	/** A blob's body, streamed (registries usually redirect to storage; fetch follows, dropping our credentials). */
	async blob(repo: string, digest: string, timeout = 30 * 60_000): Promise<Response> {
		const res = await this.request(`/v2/${repo}/blobs/${digest}`, { scope: pullScope(repo), timeout });
		if (!res.ok) throw await errorFrom(res, digest);
		return res;
	}

	async blobJson<T>(repo: string, digest: string): Promise<T> {
		const res = await this.blob(repo, digest, TIMEOUT);
		const raw = Buffer.from(await res.arrayBuffer());
		if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== digest) throw new RegistryError(`Blob ${digest} didn't match its digest`);
		return JSON.parse(raw.toString('utf8')) as T;
	}

	async deleteManifest(repo: string, digest: string): Promise<void> {
		const res = await this.request(`/v2/${repo}/manifests/${digest}`, { method: 'DELETE', scope: `repository:${repo}:pull,push,delete`, headers: { accept: MANIFEST_ACCEPT } });
		await res.body?.cancel();
		if (res.status === 405) throw new RegistryError('This registry has deleting turned off (registry:2 needs REGISTRY_STORAGE_DELETE_ENABLED=true)', 405);
		if (!res.ok && res.status !== 202) throw await errorFrom(res, `${repo}@${digest}`);
	}

	/* ---------- reading images ---------- */

	/** What the index keeps for a digest: platforms, size, created, labels (from the first platform's config). */
	async summarize(repo: string, digest: string): Promise<ManifestInput> {
		const m = await this.manifest(repo, digest);
		if (isIndex(m)) {
			const children = imageManifests(m.json);
			const first = preferredPlatform(children);
			const base: ManifestInput = { digest, mediaType: m.mediaType, size: null, created: null, configDigest: null, platforms: children.map((c) => platformString(c.platform)), labels: {} };
			if (!first) return base;
			const child = await this.summarize(repo, first.digest);
			return { ...base, size: child.size, created: child.created, configDigest: child.configDigest, labels: child.labels };
		}
		const j = m.json;
		if (!j.config || !j.layers) return { digest, mediaType: m.mediaType, size: null, created: null, configDigest: null, platforms: [], labels: {} };
		const cfg = await this.blobJson<ImageConfig>(repo, j.config.digest).catch(() => null);
		return {
			digest,
			mediaType: m.mediaType,
			size: j.config.size + j.layers.reduce((n, l) => n + l.size, 0),
			created: cfg?.created ?? null,
			configDigest: j.config.digest,
			platforms: cfg ? [platformString(cfg)] : [],
			labels: cfg?.config?.Labels ?? {}
		};
	}

	/** Everything the image page shows, for every platform. */
	async inspect(repo: string, ref: string): Promise<{ digest: string; mediaType: string; manifest: string; platforms: ImagePlatform[] }> {
		const m = await this.manifest(repo, ref);
		const manifest = JSON.stringify(m.json, null, 2);
		if (isIndex(m)) {
			const platforms = await Promise.all(imageManifests(m.json).map((c) => this.inspectImage(repo, c.digest, platformString(c.platform))));
			return { digest: m.digest, mediaType: m.mediaType, manifest, platforms: platforms.filter((p): p is ImagePlatform => !!p) };
		}
		const p = await this.inspectImage(repo, m.digest, null, m);
		return { digest: m.digest, mediaType: m.mediaType, manifest, platforms: p ? [p] : [] };
	}

	private async inspectImage(repo: string, digest: string, platform: string | null, pre?: Awaited<ReturnType<RegistryClient['manifest']>>): Promise<ImagePlatform | null> {
		const m = pre ?? (await this.manifest(repo, digest));
		const j = m.json;
		if (!j.config || !j.layers) return null;
		const cfg = await this.blobJson<ImageConfig>(repo, j.config.digest).catch(() => null);
		return platformFromConfig(digest, j.config, j.layers, cfg, platform);
	}
}

export function platformFromConfig(digest: string, config: Descriptor, layers: Descriptor[], cfg: ImageConfig | null, platform: string | null): ImagePlatform {
	const c = cfg?.config ?? {};
	return {
		platform: platform ?? (cfg ? platformString(cfg) : 'unknown'),
		digest,
		configDigest: config.digest,
		size: config.size + layers.reduce((n, l) => n + l.size, 0),
		layers,
		created: cfg?.created ?? null,
		env: c.Env ?? [],
		entrypoint: c.Entrypoint ?? null,
		cmd: c.Cmd ?? null,
		workdir: c.WorkingDir || null,
		user: c.User || null,
		exposedPorts: Object.keys(c.ExposedPorts ?? {}),
		labels: c.Labels ?? {},
		history: (cfg?.history ?? []).map((h) => ({ created: h.created ?? null, createdBy: h.created_by ?? '', emptyLayer: !!h.empty_layer, comment: h.comment ?? null }))
	};
}

export type Manifest = {
	schemaVersion?: number;
	mediaType?: string;
	config?: Descriptor;
	layers?: Descriptor[];
	manifests?: Descriptor[];
	annotations?: Record<string, string>;
};

export type ImageConfig = {
	created?: string;
	architecture?: string;
	os?: string;
	variant?: string;
	config?: {
		Env?: string[];
		Entrypoint?: string[] | null;
		Cmd?: string[] | null;
		WorkingDir?: string;
		User?: string;
		ExposedPorts?: Record<string, object>;
		Labels?: Record<string, string> | null;
	};
	history?: { created?: string; created_by?: string; empty_layer?: boolean; comment?: string }[];
};

export const isIndex = (m: { mediaType: string; json: Manifest }) => INDEX_TYPES.has(m.mediaType) || !!m.json.manifests;

/** An index's images, without the build attestations BuildKit adds as `unknown/unknown` entries. */
export function imageManifests(index: Manifest): Descriptor[] {
	return (index.manifests ?? []).filter(
		(d) => d.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest' && !(d.platform?.os === 'unknown' && d.platform?.architecture === 'unknown')
	);
}

/** linux/amd64 when there is one, else the first. */
export function preferredPlatform(children: Descriptor[], want?: string | null): Descriptor | undefined {
	if (want) return children.find((c) => platformString(c.platform) === want || platformString(c.platform).startsWith(`${want}/`));
	return children.find((c) => c.platform?.os === 'linux' && c.platform.architecture === 'amd64') ?? children[0];
}

export const pullScope = (repo: string) => `repository:${repo}:pull`;

async function errorFrom(res: Response, what = 'Registry'): Promise<RegistryError> {
	let detail = '';
	try {
		const text = await res.text();
		const body = JSON.parse(text) as { errors?: { message?: string; code?: string }[]; message?: string };
		detail = body.errors?.map((e) => e.message || e.code).join('; ') || body.message || '';
	} catch {}
	const status = res.status;
	const msg = status === 404 ? `${what}: not found` : status === 403 ? `${what}: access denied` : status === 429 ? `${what}: rate limited, try again later` : `${what} answered ${status}`;
	return new RegistryError(detail ? `${msg} (${detail})` : msg, status);
}

/** The TLS errors a plain-HTTP server causes when spoken to over HTTPS. */
export const PLAIN_HTTP_CODES = new Set(['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ERR_SSL_HTTP_REQUEST']);

function causeOf(err: unknown): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	if (e?.name === 'TimeoutError') return 'timed out';
	if (PLAIN_HTTP_CODES.has(e?.cause?.code ?? '')) return 'it answers plain HTTP, not HTTPS. Enter the address with http:// in front';
	return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}
