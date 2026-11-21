<script lang="ts">
	import { ChevronRight, Package } from '@lucide/svelte';
	import KindIcon from './KindIcon.svelte';
	import { ago, bytes, dateTime, plural } from '#lib/client/format.ts';
	import { imageHref, repoHref, tagOrder } from '#lib/registries.ts';
	import type { Registry, RepoSummary } from '#lib/types.ts';

	/** Images as rows, one per repository: its newest tags, how many versions, and when it last changed. */
	let { repos, registries, searching = false }: { repos: RepoSummary[]; registries: Record<string, Registry>; searching?: boolean } = $props();

	const SHOWN = 3;
	// The newest tags, chosen names (latest, develop) ahead of generated ones (commit hashes).
	const shown = (r: RepoSummary) => [...r.tags].sort(tagOrder).slice(0, SHOWN);
	const platformLabel = (p: string[]) => (p.length === 0 ? '—' : p.length === 1 ? p[0].replace(/^linux\//, '') : `${p.length} platforms`);
</script>

<div class="overflow-x-auto">
	<table class="w-full table-fixed text-[0.8125rem]">
		<thead>
			<tr class="border-b border-border text-left text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
				<th class="w-[34%] py-2 pr-3 pl-4 font-medium sm:pl-8 max-md:w-auto">Image</th>
				<th class="px-3 py-2 font-medium max-md:hidden">Tags</th>
				<th class="w-24 px-3 py-2 text-right font-medium max-sm:hidden">Versions</th>
				<th class="w-28 px-3 py-2 font-medium max-lg:hidden">Platform</th>
				<th class="w-24 px-3 py-2 text-right font-medium max-lg:hidden">Size</th>
				<th class="w-28 px-3 py-2 font-medium max-sm:hidden">Updated</th>
				<th class="w-10 pr-4 sm:pr-8"><span class="sr-only">Open</span></th>
			</tr>
		</thead>
		<tbody>
			{#each repos as r (`${r.registryId}/${r.repo}`)}
				{@const reg = registries[r.registryId]}
				{@const tags = shown(r)}
				<tr class="group relative border-b border-border/60 transition-colors hover:bg-accent/40">
					<td class="py-2.5 pr-3 pl-4 sm:pl-8">
						<a href={repoHref(r.registryId, r.repo)} class="flex min-w-0 items-center gap-2.5 after:absolute after:inset-0">
							<span class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Package class="size-4" /></span>
							<span class="min-w-0">
								<span class="block truncate font-medium" title={r.repo}>{r.repo}</span>
								{#if reg}<span class="mt-0.5 flex items-center gap-1 text-[0.6875rem] text-muted-foreground"><KindIcon kind={reg.kind} class="size-3" />{reg.name}</span>{/if}
							</span>
						</a>
					</td>
					<td class="px-3 py-2.5 max-md:hidden">
						<span class="relative z-10 flex min-w-0 items-center gap-1 overflow-hidden">
							{#each tags as tag (tag)}
								<a href={imageHref(r.registryId, r.repo, tag)} class="badge h-5 max-w-36 min-w-0 shrink truncate px-1.5 font-mono text-[0.6875rem] hover:text-foreground" title={tag}>{tag}</a>
							{/each}
							{#if r.matches > tags.length}<span class="shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground">+{(r.matches - tags.length).toLocaleString()}{searching && r.matches < r.tagCount ? ' matching' : ''}</span>{/if}
						</span>
					</td>
					<td class="px-3 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden" title={plural(r.tagCount, 'tag')}>{r.versions.toLocaleString()}</td>
					<td class="px-3 py-2.5 whitespace-nowrap text-muted-foreground max-lg:hidden" title={r.latest.platforms.join(', ')}>{platformLabel(r.latest.platforms)}</td>
					<td class="px-3 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular-nums max-lg:hidden">{bytes(r.latest.size)}</td>
					<td class="px-3 py-2.5 whitespace-nowrap text-muted-foreground max-sm:hidden" title={dateTime(r.updatedAt)}>{r.updatedAt ? ago(r.updatedAt) : '—'}</td>
					<td class="pr-4 text-muted-foreground sm:pr-8"><ChevronRight class="ml-auto size-4" /></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
