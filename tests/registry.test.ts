import { dataDir as dir } from './env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startMock, type Mock } from './mock-registry.ts';

const store = await import('../src/lib/server/store.ts');
const { syncRegistry } = await import('../src/lib/server/sync.ts');
const { imageArchive } = await import('../src/lib/server/archive.ts');
const { imageDetail, deleteTag } = await import('../src/lib/server/images.ts');
const { makeLink, findLink } = await import('../src/lib/server/links.ts');

let mock: Mock;
let registryId: string;

before(async () => {
	mock = await startMock();
	registryId = store.createRegistry({ name: 'Mock', kind: 'registry', config: { url: mock.url, username: 'bot' }, secrets: { password: 'hunter22' } }).id;
});

after(async () => {
	await mock.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Reads a tar into name → contents. */
function untar(buf: Buffer): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	let off = 0;
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (h.every((b) => b === 0)) break;
		const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
		const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
		out.set(name, buf.subarray(off + 512, off + 512 + size));
		off += 512 + Math.ceil(size / 512) * 512;
	}
	return out;
}

const collect = async (s: AsyncIterable<Uint8Array>) => {
	const chunks: Buffer[] = [];
	for await (const c of s) chunks.push(Buffer.from(c));
	return Buffer.concat(chunks);
};

test('sync indexes every repository and tag, with token auth and catalog paging', async () => {
	const result = await syncRegistry(registryId);
	assert.deepEqual(result.errors, []);
	assert.equal(result.repos, 2);
	assert.equal(result.tags, 4);
	const r = store.getRegistry(registryId)!;
	assert.equal(r.status, 'ok');
	assert.equal(r.host, mock.url.replace('http://', ''));
	assert.equal(r.tagCount, 4);
	// The multi-platform index summarises as both platforms (not the attestation), sized as amd64.
	const api = store.findImage(registryId, 'team/api', 'v1.2.0')!;
	assert.deepEqual(api.platforms, ['linux/amd64', 'linux/arm64']);
	assert.ok(api.size! > 0);
	assert.equal(api.labels['org.opencontainers.image.source'], 'https://github.com/acme/api');
	assert.equal(api.created, '2026-11-01T10:00:00Z');
});

test('a second sync fetches no manifests it already has', async () => {
	mock.requests.length = 0;
	await syncRegistry(registryId);
	assert.equal(mock.requests.filter((r) => r.startsWith('GET /v2/') && r.includes('/manifests/')).length, 0);
});

test('search by words, tag globs, digests, image IDs, references, labels and platforms', () => {
	const q = (s: string) => store.searchImages({ q: s }).rows.map((r) => `${r.repo}:${r.tag}`).sort();
	assert.deepEqual(q('api'), ['team/api:latest', 'team/api:v1.10.0-rc1', 'team/api:v1.2.0']);
	assert.deepEqual(q('tag:v1.*'), ['team/api:v1.10.0-rc1', 'team/api:v1.2.0']);
	assert.deepEqual(q(mock.digests.web.slice(7, 19)), ['team/web:2026.11']);
	assert.deepEqual(q(mock.digests.index), ['team/api:latest', 'team/api:v1.2.0']);
	const web = store.findImage(registryId, 'team/web', '2026.11')!;
	assert.deepEqual(q(`id:${web.configDigest!.slice(7, 20)}`), ['team/web:2026.11']);
	assert.deepEqual(q('api:v1.2'), ['team/api:v1.2.0']);
	assert.deepEqual(q('label:org.opencontainers.image.source=*web'), ['team/web:2026.11']);
	assert.deepEqual(q('arch:arm64'), ['team/api:latest', 'team/api:v1.2.0']);
	assert.deepEqual(q('team -tag:latest registry:mock'), ['team/api:v1.10.0-rc1', 'team/api:v1.2.0', 'team/web:2026.11']);
	assert.deepEqual(q('nothing-like-this'), []);
	// LIKE wildcards in the query are literal.
	assert.deepEqual(q('tag:v1_2'), []);
});

test('image detail reads every platform live', async () => {
	const d = await imageDetail(store.getRegistry(registryId)!, 'team/api', 'v1.2.0');
	assert.equal(d.digest, mock.digests.index);
	assert.deepEqual(d.platforms.map((p) => p.platform), ['linux/amd64', 'linux/arm64']);
	assert.deepEqual(d.aliases, ['latest']);
	assert.deepEqual(d.platforms[0].cmd, ['/app']);
	assert.equal(d.pullRef, `${mock.url.replace('http://', '')}/team/api:v1.2.0`);
});

test('downloads are docker-save and OCI layout tars, with exact lengths and checked blobs', async () => {
	const r = store.getRegistry(registryId)!;
	const a = await imageArchive(r, 'team/api', 'v1.2.0', 'linux/arm64');
	assert.equal(a.digest, mock.digests.arm);
	assert.equal(a.filename, 'api_v1.2.0_linux-arm64.tar');
	const buf = await collect(a.stream);
	assert.equal(buf.length, a.size);
	const files = untar(buf);
	const manifest = JSON.parse(files.get('manifest.json')!.toString());
	assert.deepEqual(manifest[0].RepoTags, [`${r.host}/team/api:v1.2.0`]);
	for (const p of [manifest[0].Config, ...manifest[0].Layers]) {
		const blob = files.get(p);
		assert.ok(blob, `${p} is in the archive`);
		assert.equal(`sha256:${createHash('sha256').update(blob).digest('hex')}`, p.replace('blobs/sha256/', 'sha256:'));
	}
	const config = JSON.parse(files.get(manifest[0].Config)!.toString());
	assert.equal(config.architecture, 'arm64');
	assert.match(gunzipSync(files.get(manifest[0].Layers[0])!).toString('latin1'), /binary for arm64/);
	const index = JSON.parse(files.get('index.json')!.toString());
	assert.equal(index.manifests[0].digest, mock.digests.arm);
	assert.ok(files.get(`blobs/sha256/${mock.digests.arm.slice(7)}`));
	assert.equal(JSON.parse(files.get('oci-layout')!.toString()).imageLayoutVersion, '1.0.0');
});

test('a corrupted blob ends the download with an error', async () => {
	const r = store.getRegistry(registryId)!;
	const layerDigest = [...mock.blobs.keys()].find((d) => mock.blobs.get(d)![0] === 0x1f)!;
	const good = mock.blobs.get(layerDigest)!;
	const bad = Buffer.from(good);
	bad[bad.length - 1] ^= 0xff;
	mock.blobs.set(layerDigest, bad);
	try {
		const tags = ['v1.2.0', '2026.11'];
		let failed = 0;
		for (const [repo, tag] of [['team/api', tags[0]], ['team/web', tags[1]]]) {
			const a = await imageArchive(r, repo, tag, null);
			await collect(a.stream).catch(() => failed++);
		}
		assert.equal(failed, 1);
	} finally {
		mock.blobs.set(layerDigest, good);
	}
});

test('one-time links can be claimed once, and given back on failure', () => {
	const { link, token } = makeLink({ registryId, repo: 'team/web', ref: '2026.11', digest: mock.digests.web, platform: null, note: null, createdBy: null, expiresAt: null, maxDownloads: 1 });
	assert.equal(findLink(token)?.id, link.id);
	assert.equal(findLink('not-a-token-but-long-enough'), undefined);
	assert.equal(store.claimLinkDownload(link.id), true);
	assert.equal(store.claimLinkDownload(link.id), false);
	assert.equal(store.getLink(link.id)!.state, 'used');
	store.releaseLinkDownload(link.id);
	assert.equal(store.getLink(link.id)!.state, 'active');
	store.revokeLink(link.id);
	assert.equal(store.claimLinkDownload(link.id), false);
	assert.equal(store.getLink(link.id)!.state, 'revoked');
});

test('expired links refuse downloads', () => {
	const { link } = makeLink({ registryId, repo: 'team/web', ref: '2026.11', digest: null, platform: null, note: null, createdBy: null, expiresAt: new Date(Date.now() - 1000).toISOString(), maxDownloads: null });
	assert.equal(link.state, 'expired');
	assert.equal(store.claimLinkDownload(link.id), false);
});

test('deleting a tag on a plain registry removes every tag on its digest', async () => {
	const r = store.getRegistry(registryId)!;
	const { removed } = await deleteTag(r, 'team/api', 'latest', null);
	assert.deepEqual(removed.sort(), ['latest', 'v1.2.0']);
	assert.equal(store.findImage(registryId, 'team/api', 'v1.2.0'), undefined);
	await syncRegistry(registryId);
	assert.deepEqual(store.repoTags(registryId, 'team/api').map((t) => t.tag), ['v1.10.0-rc1']);
});

test('registry secrets are encrypted at rest and never listed', async () => {
	const { DatabaseSync } = await import('node:sqlite');
	const raw = new DatabaseSync(join(dir, 'wharf.db')).prepare('SELECT secret FROM registries').get() as { secret: string };
	assert.ok(!raw.secret.includes('hunter22'));
	assert.deepEqual(store.getRegistry(registryId)!.secrets, ['password']);
	assert.ok(!JSON.stringify(store.listRegistries()).includes('hunter22'));
});

test('an address without a scheme falls back to http:// when the registry speaks plain HTTP', async () => {
	const { resolveScheme } = await import('../src/lib/server/registry-input.ts');
	// 0.0.0.0 reaches the mock but isn't treated as localhost, so the HTTPS probe runs.
	const bare = mock.url.replace(/^http:\/\/127\.0\.0\.1/, '0.0.0.0');
	assert.equal((await resolveScheme('registry', { url: bare })).url, `http://${bare}`);
	assert.equal((await resolveScheme('registry', { url: `https://${bare}` })).url, `https://${bare}`);
});
