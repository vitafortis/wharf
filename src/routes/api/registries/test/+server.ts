import { json } from '@sveltejs/kit';
import { body, handler, NotFound, requireAdmin, str } from '#lib/server/http.ts';
import { draftSource, repositoriesOf } from '#lib/server/registry/index.ts';
import { readRegistry, resolveScheme } from '#lib/server/registry-input.ts';
import { getRegistry, getRegistrySecrets } from '#lib/server/store.ts';
import { registryHost } from '#lib/registries.ts';
import type { Registry } from '#lib/types.ts';
import type { RequestHandler } from './$types';

/** Checks the form's settings before saving: signs in, and counts the repositories it would index. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	requireAdmin(locals);
	const b = await body(request);
	const id = str(b, 'id');
	const existing = id ? getRegistry(id) : undefined;
	if (id && !existing) throw new NotFound('No such registry');
	const input = readRegistry(b, existing?.kind);
	input.config = await resolveScheme(input.kind, input.config);
	// Secrets not typed again come from what's stored.
	const stored = existing ? getRegistrySecrets(existing.id) : {};
	const secrets = { ...stored, ...Object.fromEntries(Object.entries(input.secrets).filter(([, v]) => v !== undefined)) };
	const draft: Registry = {
		...(existing ?? { id: 'draft', status: 'unknown', lastError: null, syncedAt: null, createdAt: '', repoCount: 0, tagCount: 0, syncing: false, secrets: [] }),
		name: input.name,
		kind: input.kind,
		config: input.config,
		host: registryHost(input.kind, input.config)
	};
	const source = draftSource(draft, () => secrets);
	const fill = await source.test();
	draft.config = { ...draft.config, ...fill };
	const repos = draft.kind === 'docker' ? [] : await repositoriesOf(draft, source);
	return json({ ok: true, repositories: repos.length, sample: repos.slice(0, 8), config: fill });
});
