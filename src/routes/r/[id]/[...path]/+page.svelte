<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { ChevronRight, CircleAlert, Download, FolderOpen, Link2, LoaderCircle, RefreshCw, Search, Tag, Trash2 } from '@lucide/svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import ImageTable from '#lib/components/ImageTable.svelte';
	import KindIcon from '#lib/components/KindIcon.svelte';
	import CopyField from '#lib/components/CopyField.svelte';
	import StatusDot from '#lib/components/StatusDot.svelte';
	import { api, errorMessage } from '#lib/client/api.ts';
	import { copyText } from '#lib/client/clipboard.ts';
	import { ago, bytes, dateTime, plural } from '#lib/client/format.ts';
	import { confirmAction, shareImage, toast } from '#lib/client/state.svelte.ts';
	import { downloadHref, groupByDigest, imageHref, KINDS, repoHref, shortDigest } from '#lib/registries.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const r = $derived(data.registry);
	const registries = $derived({ [r.id]: r });
	const admin = $derived(!!data.viewer?.admin);

	let filter = $state('');
	let platformIndex = $state(0);
	let syncing = $state(false);

	$effect(() => {
		void data.ref;
		platformIndex = 0;
		filter = '';
	});

	const repos = $derived(data.view === 'registry' ? data.repos.filter((x) => x.name.toLowerCase().includes(filter.trim().toLowerCase())) : []);
	// One row per version: tags on the same digest are aliases of each other.
	const versions = $derived(data.view === 'repo' ? groupByDigest(data.tags) : []);
	const tags = $derived.by(() => {
		const f = filter.trim().toLowerCase();
		return f ? versions.filter((v) => [v.tag, ...v.aliases].some((t) => t.toLowerCase().includes(f)) || v.digest.includes(f)) : versions;
	});
	const detail = $derived(data.view === 'image' ? data.detail : null);
	const platform = $derived(detail?.platforms[platformIndex] ?? detail?.platforms[0] ?? null);
	const multi = $derived((detail?.platforms.length ?? 0) > 1);

	/** Breadcrumbs: registry › team › api › :tag, each linking to its level. */
	const crumbs = $derived.by(() => {
		if (data.view === 'registry') return [];
		const parts = data.repo.split('/');
		return parts.map((p, i) => ({ label: p, href: i === parts.length - 1 ? repoHref(r.id, data.repo) : null }));
	});

	async function sync() {
		syncing = true;
		try {
			const res = await api.post<{ result: { tags: number; errors: string[] } }>(`/api/registries/${r.id}/sync`);
			if (res.result.errors.length) toast('error', `Synced with ${plural(res.result.errors.length, 'error')}`, res.result.errors[0]);
			else toast('success', `Synced ${r.name}`, `${plural(res.result.tags, 'tag')}.`);
			await invalidateAll();
		} catch (err) {
			toast('error', "Couldn't sync", errorMessage(err));
		}
		syncing = false;
	}

	async function remove() {
		if (data.view !== 'image') return;
		const aliases = detail?.aliases ?? [];
		const allTags = r.kind === 'registry' && aliases.length;
		const ok = await confirmAction({
			title: `Delete ${data.repo}:${data.ref}?`,
			body: allTags
				? `This deletes the image's manifest from ${r.name}, so its other tags go too. It can't be undone.`
				: r.kind === 'docker'
					? 'This removes the tag from the Docker host (docker rmi). The image goes once no tag is left.'
					: `This deletes the tag from ${r.name}. It can't be undone.`,
			detail: allTags ? aliases.map((a) => `${data.repo}:${a}`).join('\n') : undefined,
			confirmLabel: 'Delete',
			danger: true
		});
		if (!ok) return;
		try {
			const res = await api.post<{ removed: string[] }>('/api/images/delete', { registryId: r.id, repo: data.repo, tag: data.ref });
			toast('success', `Deleted ${plural(res.removed.length, 'tag')}`);
			await goto(repoHref(r.id, data.repo), { invalidateAll: true });
		} catch (err) {
			toast('error', "Couldn't delete it", errorMessage(err));
		}
	}

	const fmtCmd = (c: string[] | null) => (c?.length ? c.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ') : '—');
	// BuildKit history lines are long shell commands with a "/bin/sh -c #(nop)" prefix; show what was run.
	const fmtHistory = (s: string) => s.replace(/^\/bin\/sh -c #\(nop\)\s*/, '').replace(/^\/bin\/sh -c /, 'RUN ').trim();
</script>

<svelte:head><title>{data.view === 'image' ? `${data.repo}:${data.ref}` : data.view === 'repo' ? data.repo : r.name} · Wharf</title></svelte:head>

<div class="h-full overflow-y-auto">
	<div class="relative">
		<div class="glow-top pointer-events-none absolute inset-x-0 -top-10 h-64"></div>
		<header class="relative px-4 pt-5 pb-4 sm:px-8 sm:pt-6">
			<nav class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
				<a href="/r/{r.id}" class="flex items-center gap-1.5 hover:text-foreground"><KindIcon kind={r.kind} class="size-3.5" />{r.name}</a>
				{#each crumbs as c, i (i)}
					<ChevronRight class="size-3" />
					{#if c.href && data.view === 'image'}<a href={c.href} class="hover:text-foreground">{c.label}</a>{:else}<span class={data.view === 'repo' && i === crumbs.length - 1 ? 'text-foreground' : ''}>{c.label}</span>{/if}
				{/each}
			</nav>

			<div class="mt-2 flex flex-wrap items-end justify-between gap-4">
				<div class="min-w-0">
					{#if data.view === 'registry'}
						<h1 class="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">{r.name}<StatusDot registry={r} /></h1>
						<p class="mt-1 text-sm text-muted-foreground">
							{KINDS[r.kind].label}{r.host ? ` · ${r.host}` : ''} · {plural(r.repoCount, 'repository', 'repositories')}, {plural(r.tagCount, 'tag')} · synced {ago(r.syncedAt)}
						</p>
					{:else if data.view === 'repo'}
						<h1 class="truncate text-2xl font-semibold tracking-tight">{data.repo}</h1>
						<p class="mt-1 text-sm text-muted-foreground">{plural(versions.length, 'version')}, {plural(data.tags.length, 'tag')} · {r.host || 'Docker host'}</p>
					{:else}
						<h1 class="truncate text-2xl font-semibold tracking-tight">{data.repo}<span class="text-muted-foreground">{data.ref.startsWith('sha256:') ? '@' : ':'}</span><span class="text-primary">{data.ref.startsWith('sha256:') ? shortDigest(data.ref) : data.ref}</span></h1>
						{#if detail}
							<p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
								<button class="hash hover:text-foreground" title="Copy the digest" onclick={() => copyText(detail.digest, 'Digest copied')}>{detail.digest.slice(0, 19)}…</button>
								<span>{multi ? plural(detail.platforms.length, 'platform') : (platform?.platform ?? '')}</span>
								{#if platform}<span>{bytes(platform.size)}</span>{/if}
								{#if platform?.created}<span title={dateTime(platform.created)}>built {ago(platform.created)}</span>{/if}
							</p>
						{/if}
					{/if}
				</div>
				<div class="flex items-center gap-2">
					{#if data.view === 'image'}
						{#if admin && KINDS[r.kind].canDelete && !data.ref.startsWith('sha256:')}
							<button class="btn btn-danger-outline btn-icon" title="Delete this tag" aria-label="Delete this tag" onclick={remove}><Trash2 /></button>
						{/if}
						<button class="btn btn-secondary" onclick={() => shareImage(r.id, data.repo, data.ref, detail?.platforms.map((p) => p.platform) ?? data.indexed?.platforms ?? [])}><Link2 />Share link</button>
						<a class="btn btn-primary" href={downloadHref(r.id, data.repo, data.ref, multi ? platform?.platform : null)} download><Download />Download{multi && platform ? ` ${platform.platform.replace(/^linux\//, '')}` : ''}</a>
					{:else}
						<button class="btn btn-secondary" disabled={syncing || r.syncing} onclick={sync}>
							{#if syncing || r.syncing}<LoaderCircle class="animate-spin" />Syncing{:else}<RefreshCw />Sync{/if}
						</button>
					{/if}
				</div>
			</div>
		</header>
	</div>

	{#if data.view === 'registry'}
		<div class="px-4 sm:px-8">
			<div class="relative max-w-sm">
				<Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<input class="input pl-9" placeholder="Filter repositories" bind:value={filter} />
			</div>
		</div>
		<div class="mt-4 pb-12">
			{#if repos.length}
				<ul class="border-t border-border">
					{#each repos as repo (repo.name)}
						<li>
							<a href={repoHref(r.id, repo.name)} class="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 transition-colors hover:bg-accent/40 sm:px-8">
								<FolderOpen class="size-4 shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{repo.name}</span>
								<span class="text-xs text-muted-foreground tabular-nums">{plural(repo.tagCount, 'tag')}</span>
								<span class="w-20 text-right text-xs text-muted-foreground max-sm:hidden" title={dateTime(repo.updatedAt)}>{repo.updatedAt ? ago(repo.updatedAt) : ''}</span>
								<ChevronRight class="size-4 text-muted-foreground" />
							</a>
						</li>
					{/each}
				</ul>
			{:else if data.repos.length}
				<EmptyState icon={Search} title="No repositories match" />
			{:else}
				<EmptyState
					icon={r.status === 'error' ? CircleAlert : FolderOpen}
					title={r.status === 'error' ? 'The last sync failed' : r.syncedAt ? 'No repositories' : 'Not synced yet'}
					body={r.lastError ?? (r.syncedAt ? 'The registry has none Wharf can see. Name some in the registry settings if it can’t list them.' : 'Sync to index its images.')}
				/>
			{/if}
		</div>
	{:else if data.view === 'repo'}
		<div class="px-4 sm:px-8">
			<div class="relative max-w-sm">
				<Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<input class="input pl-9" placeholder="Filter by tag or digest" bind:value={filter} />
			</div>
		</div>
		<div class="mt-4 pb-12">
			{#if tags.length}
				<ImageTable rows={tags} {registries} showRepo={false} />
			{:else}
				<EmptyState icon={Tag} title={data.tags.length ? 'No versions match' : 'No tags indexed'} body={data.tags.length ? undefined : 'Sync the registry, or check the repository name.'} />
			{/if}
		</div>
	{:else}
		<div class="max-w-6xl space-y-6 px-4 pb-12 sm:px-8">
			{#if data.error}
				<div class="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-[0.8125rem] text-danger">
					<CircleAlert class="mt-0.5 size-4 shrink-0" />
					<div>
						<p class="font-medium">Couldn't read this image from {r.name}</p>
						<p class="mt-0.5 text-xs">{data.error}</p>
					</div>
				</div>
			{/if}

			{#if detail}
				<div class="grid gap-3 lg:grid-cols-2">
					<CopyField label="Pull" value="docker pull {detail.pullRef}" />
					<CopyField label="Digest" value={detail.digest} />
				</div>

				{#if detail.aliases.length}
					<div class="flex flex-wrap items-center gap-1.5 text-xs">
						<span class="text-muted-foreground">Same image as</span>
						{#each detail.aliases as a (a)}
							<a class="badge hover:text-foreground" href={r.kind === 'docker' ? '#' : imageHref(r.id, data.repo, a)}><Tag />{a}</a>
						{/each}
					</div>
				{/if}

				{#if multi}
					<div class="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Platforms">
						{#each detail.platforms as p, i (p.digest)}
							<button role="tab" aria-selected={i === platformIndex} class="rounded-md px-3 py-1.5 text-[0.8125rem] {i === platformIndex ? 'bg-card font-medium shadow-surface' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (platformIndex = i)}>{p.platform}</button>
						{/each}
					</div>
				{/if}

				{#if platform}
					<section class="card divide-y divide-border">
						{#each [['Platform', platform.platform], ['Size', `${bytes(platform.size)}${r.kind === 'docker' ? ' (uncompressed)' : ' compressed'}`], ['Built', platform.created ? dateTime(platform.created) : '—'], ['Image ID', platform.configDigest], ['Entrypoint', fmtCmd(platform.entrypoint)], ['Command', fmtCmd(platform.cmd)], ['Working directory', platform.workdir ?? '—'], ['User', platform.user ?? 'root'], ['Ports', platform.exposedPorts.join(', ') || '—']] as [k, v] (k)}
							<div class="grid gap-1 px-4 py-2.5 sm:grid-cols-[10rem_1fr]">
								<span class="text-xs text-muted-foreground">{k}</span>
								<span class="min-w-0 text-[0.8125rem] break-all {['Image ID', 'Entrypoint', 'Command', 'Working directory'].includes(k) ? 'hash' : ''}">{v}</span>
							</div>
						{/each}
					</section>

					<div class="grid gap-6 lg:grid-cols-2">
						<section>
							<h2 class="mb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Labels</h2>
							<div class="card divide-y divide-border">
								{#each Object.entries(platform.labels) as [k, v] (k)}
									<div class="px-4 py-2">
										<p class="hash text-muted-foreground">{k}</p>
										<p class="text-[0.8125rem] break-all">{#if /^https?:\/\//.test(v)}<a href={v} class="text-primary hover:underline" target="_blank" rel="noreferrer noopener">{v}</a>{:else}{v}{/if}</p>
									</div>
								{:else}
									<p class="px-4 py-3 text-xs text-muted-foreground">No labels.</p>
								{/each}
							</div>
						</section>
						<section>
							<h2 class="mb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Environment</h2>
							<div class="card divide-y divide-border">
								{#each platform.env as e (e)}
									{@const eq = e.indexOf('=')}
									<p class="hash px-4 py-2 break-all"><span class="text-muted-foreground">{e.slice(0, eq)}=</span>{e.slice(eq + 1)}</p>
								{:else}
									<p class="px-4 py-3 text-xs text-muted-foreground">No environment variables.</p>
								{/each}
							</div>
						</section>
					</div>

					<section>
						<h2 class="mb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Build history</h2>
						<div class="card divide-y divide-border">
							{#each platform.history as h, i (i)}
								<div class="flex gap-3 px-4 py-2 {h.emptyLayer ? 'opacity-70' : ''}">
									<span class="w-6 shrink-0 text-right text-[0.6875rem] text-muted-foreground tabular-nums">{i + 1}</span>
									<code class="hash min-w-0 flex-1 break-all whitespace-pre-wrap">{fmtHistory(h.createdBy) || h.comment || '—'}</code>
									{#if h.created}<span class="shrink-0 text-[0.6875rem] text-muted-foreground max-sm:hidden" title={dateTime(h.created)}>{ago(h.created)}</span>{/if}
								</div>
							{:else}
								<p class="px-4 py-3 text-xs text-muted-foreground">The image has no history.</p>
							{/each}
						</div>
					</section>

					{#if r.kind !== 'docker'}
						<section>
							<h2 class="mb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">Layers · {platform.layers.length}</h2>
							<div class="card divide-y divide-border">
								{#each platform.layers as l, i (i)}
									<div class="flex items-center gap-3 px-4 py-2">
										<span class="w-6 shrink-0 text-right text-[0.6875rem] text-muted-foreground tabular-nums">{i + 1}</span>
										<button class="hash min-w-0 flex-1 truncate text-left hover:text-primary" title="Copy {l.digest}" onclick={() => copyText(l.digest, 'Layer digest copied')}>{l.digest}</button>
										<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{bytes(l.size)}</span>
									</div>
								{/each}
							</div>
						</section>
					{/if}
				{/if}

				<details class="card">
					<summary class="cursor-pointer px-4 py-3 text-[0.8125rem] font-medium select-none">{r.kind === 'docker' ? 'docker inspect' : 'Manifest'} <span class="hash ml-2 font-normal text-muted-foreground">{detail.mediaType}</span></summary>
					<pre class="max-h-[32rem] overflow-auto border-t border-border p-4 font-mono text-[0.6875rem] leading-relaxed">{detail.manifest}</pre>
				</details>
			{/if}
		</div>
	{/if}
</div>
