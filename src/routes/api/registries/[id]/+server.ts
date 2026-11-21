import { json } from '@sveltejs/kit';
import { body, handler, NotFound, requireAdmin } from '#lib/server/http.ts';
import { forgetSource } from '#lib/server/registry/index.ts';
import { readRegistry, resolveScheme } from '#lib/server/registry-input.ts';
import { deleteRegistry, getRegistry, logActivity, updateRegistry } from '#lib/server/store.ts';
import { syncRegistry } from '#lib/server/sync.ts';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = handler(async ({ params, request, locals }) => {
	requireAdmin(locals);
	const r = getRegistry(params.id);
	if (!r) throw new NotFound('No such registry');
	const input = readRegistry(await body(request), r.kind);
	input.config = await resolveScheme(input.kind, input.config);
	updateRegistry(r.id, { name: input.name, config: input.config, secrets: input.secrets });
	forgetSource(r.id);
	logActivity('registry.update', { actor: locals.user?.email, target: input.name });
	syncRegistry(r.id, locals.user?.email).catch(() => {});
	return json({ registry: getRegistry(r.id) });
});

/** Removes the registry from Wharf (its index and share links), never anything in the registry itself. */
export const DELETE: RequestHandler = handler(async ({ params, locals }) => {
	requireAdmin(locals);
	const r = getRegistry(params.id);
	if (!r) throw new NotFound('No such registry');
	deleteRegistry(r.id);
	forgetSource(r.id);
	logActivity('registry.remove', { actor: locals.user?.email, target: r.name });
	return json({ ok: true });
});
