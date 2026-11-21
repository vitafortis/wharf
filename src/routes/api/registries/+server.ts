import { json } from '@sveltejs/kit';
import { body, handler, requireAdmin } from '#lib/server/http.ts';
import { readRegistry, resolveScheme } from '#lib/server/registry-input.ts';
import { createRegistry, listRegistries, logActivity } from '#lib/server/store.ts';
import { syncRegistry } from '#lib/server/sync.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json({ registries: listRegistries() });

/** Adds a registry and starts its first sync in the background. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	requireAdmin(locals);
	const input = readRegistry(await body(request));
	input.config = await resolveScheme(input.kind, input.config);
	const r = createRegistry(input);
	logActivity('registry.add', { actor: locals.user?.email, target: r.name, detail: r.kind });
	syncRegistry(r.id, locals.user?.email).catch(() => {});
	return json({ registry: r });
});
