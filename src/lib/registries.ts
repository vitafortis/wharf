import type { RegistryConfig, RegistryKind } from './types.ts';

export type KindMeta = {
	label: string;
	/** One line under the name in the picker. */
	blurb: string;
	/** Whether it can delete tags. */
	canDelete: boolean;
};

export const KINDS: Record<RegistryKind, KindMeta> = {
	registry: {
		label: 'Registry',
		blurb: 'Anything with the registry API: registry:2 on localhost, Harbor, GitLab, Gitea, Quay, Nexus, Artifactory, Azure, Google Artifact Registry.',
		canDelete: true
	},
	ecr: { label: 'Amazon ECR', blurb: 'Private repositories in one account and region, with access keys or the instance role.', canDelete: true },
	dockerhub: { label: 'Docker Hub', blurb: 'Your namespaces (users or orgs), plus any public repositories you name.', canDelete: false },
	ghcr: { label: 'GitHub Packages', blurb: 'ghcr.io container packages of a user or organization, with a token that can read packages.', canDelete: false },
	docker: { label: 'Docker host', blurb: 'The images on the Docker Engine Wharf runs on, through its socket.', canDelete: true }
};

export const KIND_ORDER: RegistryKind[] = ['registry', 'ecr', 'dockerhub', 'ghcr', 'docker'];

/** The registry API base URL. */
export function registryUrl(kind: RegistryKind, c: RegistryConfig): string {
	switch (kind) {
		case 'ecr':
			return `https://${c.accountId || 'unknown'}.dkr.ecr.${c.region || 'us-east-1'}.amazonaws.com`;
		case 'dockerhub':
			return 'https://registry-1.docker.io';
		case 'ghcr':
			return 'https://ghcr.io';
		case 'docker':
			return '';
		default: {
			const u = (c.url ?? '').trim().replace(/\/+$/, '');
			if (!u) return '';
			// localhost:5000 → http, anything else without a scheme → https.
			if (!/^https?:\/\//i.test(u)) return `${/^(localhost|127\.|\[::1\])/.test(u) ? 'http' : 'https'}://${u}`;
			return u;
		}
	}
}

/** What goes before the repository in an image reference (`docker pull <host>/<repo>:<tag>`). */
export function registryHost(kind: RegistryKind, c: RegistryConfig): string {
	if (kind === 'dockerhub') return 'docker.io';
	if (kind === 'docker') return '';
	const u = registryUrl(kind, c);
	try {
		return u ? new URL(u).host : '';
	} catch {
		return '';
	}
}

/** The reference `docker pull` takes: `host/repo:tag` or `host/repo@sha256:…`. Docker Hub's library/ images drop both. */
export function pullRef(host: string, repo: string, ref: string): string {
	const sep = ref.startsWith('sha256:') ? '@' : ':';
	if (!host) return `${repo}${sep}${ref}`;
	if (host === 'docker.io') return `${repo.replace(/^library\//, '')}${sep}${ref}`;
	return `${host}/${repo}${sep}${ref}`;
}

/** `/r/<registry>/<repo>` for a repository, and `…:<tag>` or `…@<digest>` for an image. */
export function repoHref(registryId: string, repo: string): string {
	return `/r/${registryId}/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

export function imageHref(registryId: string, repo: string, ref: string): string {
	return `${repoHref(registryId, repo)}${ref.startsWith('sha256:') ? '@' : ':'}${encodeURIComponent(ref)}`;
}

/** Shell-style globs: `team/*`, `*-api`. */
export function globMatch(glob: string, s: string): boolean {
	const re = new RegExp(`^${glob.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
	return re.test(s);
}

/** `linux/arm64/v8` from an OCI platform object. */
export function platformString(p: { os?: string; architecture?: string; variant?: string } | undefined): string {
	if (!p) return 'unknown';
	return [p.os ?? 'unknown', p.architecture ?? 'unknown', p.variant].filter(Boolean).join('/');
}

export const shortDigest = (d: string | null | undefined, n = 12) => (d ? d.replace(/^sha256:/, '').slice(0, n) : '');

/** The download URL for an image: a tar for `docker load`, of one platform. */
export function downloadHref(registryId: string, repo: string, ref: string, platform?: string | null): string {
	const p = new URLSearchParams({ registry: registryId, repo, ref });
	if (platform) p.set('platform', platform);
	return `/api/download?${p}`;
}

/**
 * /r/<registry>                  its repositories
 * /r/<registry>/<repo>           the repository's tags
 * /r/<registry>/<repo>:<tag>     one image (also …@sha256:<digest>)
 */
export function parsePath(path: string): { repo: string; ref: string | null } {
	const at = path.indexOf('@');
	if (at > 0) return { repo: path.slice(0, at), ref: path.slice(at + 1) };
	const slash = path.lastIndexOf('/');
	const colon = path.indexOf(':', slash + 1);
	if (colon > 0) return { repo: path.slice(0, colon), ref: path.slice(colon + 1) };
	return { repo: path.replace(/\/+$/, ''), ref: null };
}

/** Names people chose (latest, develop, v1.2) before generated ones (a 12-character commit hash). */
const generated = (tag: string) => /^[0-9a-f]{7,64}$/.test(tag) || /^sha256-/.test(tag);
export function tagOrder(a: string, b: string): number {
	if (a === 'latest' || b === 'latest') return a === 'latest' ? -1 : 1;
	if (generated(a) !== generated(b)) return generated(a) ? 1 : -1;
	return 0;
}

/**
 * Tags that point at the same digest are one version of the image: one row with its tags as
 * aliases. Keeps the rows' order (newest first) and puts chosen names before generated ones.
 */
export function groupByDigest<T extends { registryId: string; repo: string; tag: string; digest: string }>(rows: T[]): (T & { aliases: string[] })[] {
	const out = new Map<string, T & { aliases: string[] }>();
	for (const r of rows) {
		const key = `${r.registryId}/${r.repo}@${r.digest}`;
		const g = out.get(key);
		if (g) g.aliases.push(r.tag);
		else out.set(key, { ...r, aliases: [] });
	}
	return [...out.values()].map((g) => {
		const [tag, ...aliases] = [g.tag, ...g.aliases].sort(tagOrder);
		return { ...g, tag, aliases };
	});
}
