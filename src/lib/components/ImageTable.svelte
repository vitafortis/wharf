<script lang="ts">
	import { Download, Link2 } from '@lucide/svelte';
	import KindIcon from './KindIcon.svelte';
	import { copyText } from '#lib/client/clipboard.ts';
	import { ago, bytes, dateTime } from '#lib/client/format.ts';
	import { shareImage } from '#lib/client/state.svelte.ts';
	import { downloadHref, imageHref, pullRef, shortDigest } from '#lib/registries.ts';
	import type { ImageRow, Registry } from '#lib/types.ts';

	/**
	 * Tags as rows. `showRepo` for search results across repositories; off on a repository's own page.
	 * A row with `aliases` is one version: the other tags on its digest show under its tag.
	 */
	let { rows, registries, showRepo = true }: { rows: (ImageRow & { aliases?: string[] })[]; registries: Record<string, Registry>; showRepo?: boolean } = $props();

	const platformLabel = (p: string[]) => (p.length === 0 ? '—' : p.length === 1 ? p[0].replace(/^linux\//, '') : `${p.length} platforms`);
</script>

<div class="overflow-x-auto">
	<table class="w-full table-fixed text-[0.8125rem]">
		<thead>
			<tr class="border-b border-border text-left text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
				<th class="py-2 pr-3 pl-4 font-medium sm:pl-8">{showRepo ? 'Image' : 'Tag'}</th>
				<th class="w-36 px-3 py-2 font-medium max-sm:hidden">Digest</th>
				<th class="w-32 px-3 py-2 font-medium max-lg:hidden">Platform</th>
				<th class="w-24 px-3 py-2 text-right font-medium max-md:hidden">Size</th>
				<th class="w-28 px-3 py-2 font-medium max-md:hidden">Pushed</th>
				<th class="w-32 py-2 pr-4 pl-3 sm:w-36 sm:pr-8"><span class="sr-only">Actions</span></th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row (`${row.registryId}/${row.repo}:${row.tag}`)}
				{@const reg = registries[row.registryId]}
				{@const when = row.pushedAt ?? row.created}
				<tr class="group border-b border-border/60 transition-colors hover:bg-accent/40">
					<td class="py-2 pr-3 pl-4 sm:pl-8">
						<a href={imageHref(row.registryId, row.repo, row.tag)} class="block min-w-0">
							<span class="flex min-w-0 items-baseline gap-1">
								{#if showRepo}<span class="min-w-0 truncate font-medium" title={row.repo}>{row.repo}</span><span class="text-muted-foreground">:</span>{/if}
								<span class="max-w-[60%] shrink-0 truncate {showRepo ? 'text-primary' : 'font-medium'}" title={row.tag}>{row.tag}</span>
							</span>
							{#if showRepo && reg}
								<span class="mt-0.5 flex items-center gap-1 text-[0.6875rem] text-muted-foreground"><KindIcon kind={reg.kind} class="size-3" />{reg.name}</span>
							{/if}
						</a>
						{#if row.aliases?.length}
							<span class="mt-1 flex min-w-0 flex-wrap gap-1">
								{#each row.aliases as alias (alias)}
									<a href={imageHref(row.registryId, row.repo, alias)} class="badge h-5 max-w-full truncate px-1.5 font-mono text-[0.6875rem] hover:text-foreground" title="Also tagged {alias}">{alias}</a>
								{/each}
							</span>
						{/if}
					</td>
					<td class="px-3 py-2 max-sm:hidden">
						<button class="hash text-muted-foreground hover:text-foreground" title="Copy {row.digest}" onclick={() => copyText(row.digest, 'Digest copied')}>{shortDigest(row.digest)}</button>
					</td>
					<td class="px-3 py-2 whitespace-nowrap text-muted-foreground max-lg:hidden" title={row.platforms.join(', ')}>{platformLabel(row.platforms)}</td>
					<td class="px-3 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums max-md:hidden">{bytes(row.size)}</td>
					<td class="px-3 py-2 whitespace-nowrap text-muted-foreground max-md:hidden" title={dateTime(when)}>{when ? ago(when) : '—'}</td>
					<td class="py-2 pr-4 pl-3 sm:pr-8">
						<div class="flex justify-end gap-0.5">
							<button
								class="btn btn-ghost btn-icon btn-sm"
								title="Copy the pull command"
								aria-label="Copy the pull command"
								onclick={() => copyText(`docker pull ${pullRef(reg?.host ?? '', row.repo, row.tag)}`, 'Pull command copied')}
								><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg></button
							>
							<a class="btn btn-ghost btn-icon btn-sm" title="Download for docker load" aria-label="Download" href={downloadHref(row.registryId, row.repo, row.tag)} download><Download /></a>
							<button class="btn btn-ghost btn-icon btn-sm" title="Share a download link" aria-label="Share" onclick={() => shareImage(row.registryId, row.repo, row.tag, row.platforms)}><Link2 /></button>
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
