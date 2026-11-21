import { KINDS, registryUrl } from '#lib/registries.ts';
import type { RegistryConfig, RegistryKind, RegistrySecrets } from '#lib/types.ts';
import { BadRequest, list, str } from './http.ts';
import { PLAIN_HTTP_CODES } from './registry/distribution.ts';

/**
 * Reads a registry from the add/edit form. Secrets left blank on an edit keep what's stored
 * (undefined); `clear: ["password"]` removes one.
 */
export function readRegistry(b: Record<string, unknown>, existingKind?: RegistryKind): { name: string; kind: RegistryKind; config: RegistryConfig; secrets: RegistrySecrets } {
	const kind = (existingKind ?? str(b, 'kind', { required: true })) as RegistryKind;
	if (!(kind in KINDS)) throw new BadRequest('Unknown registry kind');
	const name = str(b, 'name', { max: 80 }) ?? KINDS[kind].label;
	const config: RegistryConfig = {};
	const secret = (key: string) => {
		const clear = Array.isArray(b.clear) && b.clear.includes(key);
		if (clear) return '';
		return str(b, key, { max: 8000 }) ?? undefined;
	};
	const secrets: RegistrySecrets = {};
	const repos = list(b, 'repositories');
	const include = list(b, 'include');
	if (include.length) config.include = include;

	switch (kind) {
		case 'registry': {
			config.url = str(b, 'url', { required: true, max: 300 })!;
			if (!registryUrl('registry', config).match(/^https?:\/\/[^/\s]+/)) throw new BadRequest('Enter the registry address, e.g. registry.example.com or localhost:5000');
			try {
				new URL(registryUrl('registry', config));
			} catch {
				throw new BadRequest('That registry address is not a valid URL');
			}
			config.username = str(b, 'username', { max: 200 }) ?? undefined;
			secrets.password = secret('password');
			break;
		}
		case 'ecr': {
			config.region = str(b, 'region', { required: true, max: 40 })!;
			if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(config.region)) throw new BadRequest('Enter an AWS region such as us-east-1');
			const account = str(b, 'accountId', { max: 20 });
			if (account && !/^\d{12}$/.test(account)) throw new BadRequest('The account ID is 12 digits');
			config.accountId = account ?? undefined;
			config.awsAuth = b.awsAuth === 'environment' ? 'environment' : 'keys';
			if (config.awsAuth === 'keys') {
				secrets.accessKeyId = secret('accessKeyId');
				secrets.secretAccessKey = secret('secretAccessKey');
				secrets.sessionToken = secret('sessionToken');
			} else {
				secrets.accessKeyId = secrets.secretAccessKey = secrets.sessionToken = '';
			}
			break;
		}
		case 'dockerhub': {
			config.username = str(b, 'username', { max: 100 }) ?? undefined;
			config.namespaces = list(b, 'namespaces');
			secrets.password = secret('password');
			// Docker Hub's official images live under library/.
			for (let i = 0; i < repos.length; i++) if (!repos[i].includes('/')) repos[i] = `library/${repos[i]}`;
			if (!config.username && !config.namespaces.length && !repos.length) throw new BadRequest('Add a username, a namespace or some repositories to index');
			break;
		}
		case 'ghcr': {
			config.owner = str(b, 'owner', { max: 100 })?.replace(/^@/, '') ?? undefined;
			config.ownerType = b.ownerType === 'org' ? 'org' : 'user';
			config.username = str(b, 'username', { max: 100 }) ?? undefined;
			secrets.password = secret('password');
			break;
		}
		case 'docker':
			break;
	}
	// Repository names are lower case on every registry.
	if (repos.length) config.repositories = repos.map((r) => r.replace(/^\/+|\/+$/g, '').toLowerCase());
	return { name, kind, config, secrets };
}

/**
 * A registry address typed without a scheme defaults to HTTPS (except localhost). Registries on a LAN
 * often serve plain HTTP, so when the HTTPS handshake gets an HTTP answer instead, store the address
 * as http://. An address typed with its scheme is kept as typed.
 */
export async function resolveScheme(kind: RegistryKind, config: RegistryConfig): Promise<RegistryConfig> {
	if (kind !== 'registry' || !config.url || /^https?:\/\//i.test(config.url.trim())) return config;
	const url = registryUrl(kind, config);
	if (!url.startsWith('https://')) return config;
	try {
		await fetch(`${url}/v2/`, { method: 'GET', signal: AbortSignal.timeout(5000) });
	} catch (err) {
		const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
		if (PLAIN_HTTP_CODES.has(code)) return { ...config, url: url.replace(/^https:/, 'http:') };
	}
	return config;
}
