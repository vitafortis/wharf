import { indexTotals, searchImages, searchRepos } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const q = url.searchParams.get('q')?.slice(0, 500) ?? '';
	const registry = url.searchParams.get('registry') ?? '';
	// One row per image by default; every matching tag with ?view=tags.
	const view = url.searchParams.get('view') === 'tags' ? 'tags' : 'images';
	const opts = { q, registryId: registry || undefined, limit: 100 };
	const totals = indexTotals();
	if (view === 'tags') return { q, registry, view, ...searchImages(opts), repos: [], totals };
	const { repos, total } = searchRepos(opts);
	return { q, registry, view, repos, rows: [], total, totals };
};
