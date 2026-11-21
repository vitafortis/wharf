import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestPrefix, likePattern, parseSearch, splitRef } from '../src/lib/search.ts';
import { groupByDigest, imageHref, parsePath, pullRef, registryHost, registryUrl } from '../src/lib/registries.ts';

test('bare words, keys, digests and references', () => {
	assert.deepEqual(parseSearch('nginx 1.27'), [
		{ field: 'any', value: 'nginx', negate: false },
		{ field: 'any', value: '1.27', negate: false }
	]);
	assert.deepEqual(parseSearch('tag:v1.* repo:team/ -registry:ecr'), [
		{ field: 'tag', value: 'v1.*', negate: false },
		{ field: 'repo', value: 'team/', negate: false },
		{ field: 'registry', value: 'ecr', negate: true }
	]);
	assert.equal(parseSearch('sha256:3f2a9c')[0].field, 'digest');
	assert.equal(parseSearch('3f2a9c01')[0].field, 'digest');
	// Too short to be a digest: a word.
	assert.equal(parseSearch('abc')[0].field, 'any');
	assert.deepEqual(parseSearch('api:v2.*')[0], { field: 'ref', value: 'api:v2.*', negate: false });
	assert.equal(parseSearch('app@sha256:abcdef')[0].field, 'ref');
	assert.deepEqual(parseSearch('label:"org.example=a b"')[0], { field: 'label', value: 'org.example=a b', negate: false });
	assert.deepEqual(parseSearch(''), []);
});

test('LIKE patterns escape and glob', () => {
	assert.equal(likePattern('a_b'), '%a\\_b%');
	assert.equal(likePattern('v1.*'), 'v1.%');
	assert.equal(likePattern('100%', { anchored: true }), '100\\%');
	assert.equal(digestPrefix('SHA256:ABC'), 'sha256:abc%');
	assert.equal(digestPrefix('abc'), 'sha256:abc%');
});

test('references split into repo and tag or digest', () => {
	assert.deepEqual(splitRef('team/api:v1'), { repo: 'team/api', tag: 'v1', digest: null });
	assert.deepEqual(splitRef('localhost:5000/app'), { repo: 'localhost:5000/app', tag: null, digest: null });
	assert.deepEqual(splitRef('app@sha256:ab'), { repo: 'app', tag: null, digest: 'sha256:ab' });
});

test('page paths round-trip', () => {
	assert.deepEqual(parsePath('team/api'), { repo: 'team/api', ref: null });
	assert.deepEqual(parsePath('team/api:v1.2'), { repo: 'team/api', ref: 'v1.2' });
	assert.deepEqual(parsePath('team/api@sha256:abc'), { repo: 'team/api', ref: 'sha256:abc' });
	assert.deepEqual(parsePath('localhost:5000/app:1'), { repo: 'localhost:5000/app', ref: '1' });
	assert.deepEqual(parsePath(''), { repo: '', ref: null });
	assert.equal(imageHref('r1', 'team/api', 'v1'), '/r/r1/team/api:v1');
	assert.equal(imageHref('r1', 'team/api', 'sha256:abc'), '/r/r1/team/api@sha256%3Aabc');
});

test('registry addresses and pull references', () => {
	assert.equal(registryUrl('registry', { url: 'localhost:5000' }), 'http://localhost:5000');
	assert.equal(registryUrl('registry', { url: 'registry.example.com/' }), 'https://registry.example.com');
	assert.equal(registryHost('ecr', { region: 'eu-west-1', accountId: '123456789012' }), '123456789012.dkr.ecr.eu-west-1.amazonaws.com');
	assert.equal(pullRef('docker.io', 'library/nginx', '1.27'), 'nginx:1.27');
	assert.equal(pullRef('ghcr.io', 'acme/api', 'sha256:ab'), 'ghcr.io/acme/api@sha256:ab');
	assert.equal(pullRef('', 'app', 'latest'), 'app:latest');
});

test('tags on one digest group into a version, chosen names first', () => {
	const row = (tag: string, digest: string) => ({ registryId: 'r', repo: 'app', tag, digest });
	const groups = groupByDigest([row('a46d888c9536', 'sha256:a'), row('develop', 'sha256:a'), row('cbc825e084c1', 'sha256:b'), row('latest', 'sha256:a')]);
	assert.deepEqual(
		groups.map((g) => [g.digest, g.tag, g.aliases]),
		[
			['sha256:a', 'latest', ['develop', 'a46d888c9536']],
			['sha256:b', 'cbc825e084c1', []]
		]
	);
});
