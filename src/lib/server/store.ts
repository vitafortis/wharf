import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import { digestPrefix, likePattern, parseSearch, splitRef } from '#lib/search.ts';
import { registryHost } from '#lib/registries.ts';
import type {
	Activity,
	ImageRow,
	LinkState,
	Registry,
	RegistryConfig,
	RegistryKind,
	RegistrySecrets,
	RegistryStatus,
	RepoRow,
	RepoSummary,
	Settings,
	ShareLink,
	User,
	UserRole
} from '#lib/types.ts';

let handle: DatabaseSync | undefined;

/** Opens the store on first use, so importing this module (e.g. during build) has no side effects. */
function db(): DatabaseSync {
	if (handle) return handle;
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const dbPath = join(config.dataDir, 'wharf.db');
	handle = new DatabaseSync(dbPath);
	try {
		chmodSync(dbPath, 0o600);
	} catch {
		// Best effort — some mounted volumes don't support chmod.
	}
	handle.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			name TEXT,
			role TEXT NOT NULL DEFAULT 'admin',
			password_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_login_at TEXT
		);

		CREATE TABLE IF NOT EXISTS auth_sessions (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS registries (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			config TEXT NOT NULL DEFAULT '{}',
			secret TEXT,
			status TEXT NOT NULL DEFAULT 'unknown',
			last_error TEXT,
			synced_at TEXT,
			created_at TEXT NOT NULL
		);

		-- One row per tag; for the Docker Engine, untagged images get their short ID as the tag.
		CREATE TABLE IF NOT EXISTS tags (
			registry_id TEXT NOT NULL REFERENCES registries(id) ON DELETE CASCADE,
			repo TEXT NOT NULL,
			tag TEXT NOT NULL,
			digest TEXT NOT NULL,
			pushed_at TEXT,
			seen_at TEXT NOT NULL,
			PRIMARY KEY (registry_id, repo, tag)
		);
		CREATE INDEX IF NOT EXISTS tags_digest ON tags(digest);
		CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

		-- What a digest's manifest (and config) says, fetched once and kept: digests never change.
		CREATE TABLE IF NOT EXISTS manifests (
			registry_id TEXT NOT NULL REFERENCES registries(id) ON DELETE CASCADE,
			repo TEXT NOT NULL,
			digest TEXT NOT NULL,
			media_type TEXT,
			size INTEGER,
			created TEXT,
			config_digest TEXT,
			platforms TEXT NOT NULL DEFAULT '[]',
			labels TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (registry_id, repo, digest)
		);
		CREATE INDEX IF NOT EXISTS manifests_config ON manifests(config_digest);

		CREATE TABLE IF NOT EXISTS links (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			registry_id TEXT NOT NULL REFERENCES registries(id) ON DELETE CASCADE,
			repo TEXT NOT NULL,
			ref TEXT NOT NULL,
			digest TEXT,
			platform TEXT,
			note TEXT,
			created_by TEXT,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			max_downloads INTEGER,
			downloads INTEGER NOT NULL DEFAULT 0,
			last_download_at TEXT,
			revoked_at TEXT
		);

		CREATE TABLE IF NOT EXISTS activity (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			actor TEXT,
			action TEXT NOT NULL,
			target TEXT,
			detail TEXT
		);
		CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
	`);
	return handle;
}

const now = () => new Date().toISOString();
const parse = <T>(s: unknown, fallback: T): T => {
	try {
		return typeof s === 'string' ? (JSON.parse(s) as T) : fallback;
	} catch {
		return fallback;
	}
};

/* ---------- key/value settings ---------- */

export function getKv<T>(key: string, fallback: T): T {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
	return row ? parse(row.value, fallback) : fallback;
}

export function setKv(key: string, value: unknown) {
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function defaultSettings(): Settings {
	return { syncMinutes: 30, maxTagsPerRepo: 500, publicUrl: '', linkHours: 24, linkMaxDownloads: 1 };
}

export function getSettings(): Settings {
	return { ...defaultSettings(), ...getKv<Partial<Settings>>('settings', {}) };
}

export function saveSettings(s: Settings) {
	setKv('settings', s);
}

/* ---------- users and sign-in ---------- */

type UserRowDb = { id: string; email: string; name: string | null; role: string; created_at: string; last_login_at: string | null };
const toUser = (r: UserRowDb): User => ({ id: r.id, email: r.email, name: r.name, role: r.role as UserRole, createdAt: r.created_at, lastLoginAt: r.last_login_at });
const USER_COLS = 'id, email, name, role, created_at, last_login_at';

export function listUsers(): User[] {
	return (db().prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at`).all() as UserRowDb[]).map(toUser);
}

export function getUser(id: string): User | undefined {
	const r = db().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as UserRowDb | undefined;
	return r && toUser(r);
}

export function countUsers(): number {
	return (db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
	return (db().prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }).n;
}

export function findUserByEmail(email: string): User | undefined {
	const r = db().prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).get(email.trim()) as UserRowDb | undefined;
	return r && toUser(r);
}

export function getPasswordHash(userId: string): string | undefined {
	return (db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined)?.password_hash;
}

export function createUser(input: { email: string; name?: string | null; passwordHash: string; role?: UserRole }): User {
	const id = randomUUID();
	db()
		.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, input.email.trim(), input.name ?? null, input.role ?? 'admin', input.passwordHash, now());
	return getUser(id)!;
}

export function updateUser(id: string, patch: { name?: string | null; email?: string; passwordHash?: string; role?: UserRole }) {
	if (patch.name !== undefined) db().prepare('UPDATE users SET name = ? WHERE id = ?').run(patch.name, id);
	if (patch.email !== undefined) db().prepare('UPDATE users SET email = ? WHERE id = ?').run(patch.email.trim(), id);
	if (patch.passwordHash !== undefined) db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(patch.passwordHash, id);
	if (patch.role !== undefined) db().prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
}

export function deleteUser(id: string): boolean {
	return db().prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

export function touchUserLogin(id: string) {
	db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id);
}

export function createAuthSession(tokenHash: string, userId: string, ttlMs: number) {
	db().prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
	db().prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, Date.now() + ttlMs);
}

export function authSessionUser(tokenHash: string): User | undefined {
	const r = db()
		.prepare(`SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')} FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
		.get(tokenHash, Date.now()) as UserRowDb | undefined;
	return r && toUser(r);
}

export function deleteAuthSession(tokenHash: string) {
	db().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserAuthSessions(userId: string, except?: string) {
	db().prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(userId, except ?? '');
}

/* ---------- registries ---------- */

type RegistryRowDb = {
	id: string;
	name: string;
	kind: string;
	config: string;
	secret: string | null;
	status: string;
	last_error: string | null;
	synced_at: string | null;
	created_at: string;
	repo_count: number;
	tag_count: number;
};

/** Set while a sync runs, so the list can say so without a column that a crash would leave stuck. */
export const syncing = new Set<string>();

function toRegistry(r: RegistryRowDb): Registry {
	const cfg = parse<RegistryConfig>(r.config, {});
	const stored = r.secret ? readSecret(r.id, r.secret) : {};
	const secrets = (Object.keys(stored) as (keyof RegistrySecrets)[]).filter((k) => stored[k]);
	return {
		id: r.id,
		name: r.name,
		kind: r.kind as RegistryKind,
		config: cfg,
		secrets,
		status: r.status as RegistryStatus,
		lastError: r.last_error,
		syncedAt: r.synced_at,
		createdAt: r.created_at,
		host: registryHost(r.kind as RegistryKind, cfg),
		repoCount: r.repo_count,
		tagCount: r.tag_count,
		syncing: syncing.has(r.id)
	};
}

function readSecret(id: string, secret: string): RegistrySecrets {
	try {
		return JSON.parse(decrypt(secret, `registry:${id}`)) as RegistrySecrets;
	} catch {
		return {};
	}
}

const REGISTRY_SELECT = `
	SELECT r.*,
		(SELECT COUNT(DISTINCT repo) FROM tags t WHERE t.registry_id = r.id) AS repo_count,
		(SELECT COUNT(*) FROM tags t WHERE t.registry_id = r.id) AS tag_count
	FROM registries r`;

export function listRegistries(): Registry[] {
	return (db().prepare(`${REGISTRY_SELECT} ORDER BY r.created_at`).all() as RegistryRowDb[]).map(toRegistry);
}

export function getRegistry(id: string): Registry | undefined {
	const r = db().prepare(`${REGISTRY_SELECT} WHERE r.id = ?`).get(id) as RegistryRowDb | undefined;
	return r && toRegistry(r);
}

export function getRegistrySecrets(id: string): RegistrySecrets {
	const r = db().prepare('SELECT secret FROM registries WHERE id = ?').get(id) as { secret: string | null } | undefined;
	return r?.secret ? readSecret(id, r.secret) : {};
}

export function createRegistry(input: { name: string; kind: RegistryKind; config: RegistryConfig; secrets: RegistrySecrets }): Registry {
	const id = randomUUID();
	const secret = Object.values(input.secrets).some(Boolean) ? encrypt(JSON.stringify(input.secrets), `registry:${id}`) : null;
	db()
		.prepare('INSERT INTO registries (id, name, kind, config, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, input.name, input.kind, JSON.stringify(input.config), secret, now());
	return getRegistry(id)!;
}

/** Secrets left out (undefined) keep their stored value; an empty string clears one. */
export function updateRegistry(id: string, patch: { name?: string; config?: RegistryConfig; secrets?: RegistrySecrets }) {
	if (patch.name !== undefined) db().prepare('UPDATE registries SET name = ? WHERE id = ?').run(patch.name, id);
	if (patch.config !== undefined) db().prepare('UPDATE registries SET config = ? WHERE id = ?').run(JSON.stringify(patch.config), id);
	if (patch.secrets !== undefined) {
		const merged: RegistrySecrets = { ...getRegistrySecrets(id) };
		for (const [k, v] of Object.entries(patch.secrets)) if (v !== undefined) merged[k as keyof RegistrySecrets] = v || undefined;
		const secret = Object.values(merged).some(Boolean) ? encrypt(JSON.stringify(merged), `registry:${id}`) : null;
		db().prepare('UPDATE registries SET secret = ? WHERE id = ?').run(secret, id);
	}
}

export function setRegistryStatus(id: string, status: RegistryStatus, error: string | null, synced = false) {
	db()
		.prepare(`UPDATE registries SET status = ?, last_error = ?${synced ? ', synced_at = ?' : ''} WHERE id = ?`)
		.run(...([status, error, ...(synced ? [now()] : []), id] as SQLInputValue[]));
}

export function deleteRegistry(id: string): boolean {
	return db().prepare('DELETE FROM registries WHERE id = ?').run(id).changes > 0;
}

/* ---------- the index ---------- */

export type TagInput = { tag: string; digest: string; pushedAt?: string | null };

export type ManifestInput = {
	digest: string;
	mediaType: string | null;
	size: number | null;
	created: string | null;
	configDigest: string | null;
	platforms: string[];
	labels: Record<string, string>;
};

/** Replaces a repository's tags with what the registry has now. */
export function replaceTags(registryId: string, repo: string, tags: TagInput[]) {
	const d = db();
	const at = now();
	d.exec('BEGIN');
	try {
		d.prepare('DELETE FROM tags WHERE registry_id = ? AND repo = ?').run(registryId, repo);
		const ins = d.prepare('INSERT OR REPLACE INTO tags (registry_id, repo, tag, digest, pushed_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)');
		for (const t of tags) ins.run(registryId, repo, t.tag, t.digest, t.pushedAt ?? null, at);
		d.exec('COMMIT');
	} catch (err) {
		d.exec('ROLLBACK');
		throw err;
	}
}

/** Drops repositories the registry no longer has, and manifests no tag points at. */
export function pruneIndex(registryId: string, keepRepos: string[]) {
	const d = db();
	const keep = new Set(keepRepos);
	const repos = (d.prepare('SELECT DISTINCT repo FROM tags WHERE registry_id = ?').all(registryId) as { repo: string }[]).map((r) => r.repo);
	for (const repo of repos) if (!keep.has(repo)) d.prepare('DELETE FROM tags WHERE registry_id = ? AND repo = ?').run(registryId, repo);
	d.prepare(
		`DELETE FROM manifests WHERE registry_id = ? AND NOT EXISTS (
			SELECT 1 FROM tags t WHERE t.registry_id = manifests.registry_id AND t.repo = manifests.repo AND t.digest = manifests.digest)`
	).run(registryId);
}

export function knownDigests(registryId: string, repo: string): Set<string> {
	const rows = db().prepare('SELECT digest FROM manifests WHERE registry_id = ? AND repo = ?').all(registryId, repo) as { digest: string }[];
	return new Set(rows.map((r) => r.digest));
}

export function saveManifest(registryId: string, repo: string, m: ManifestInput) {
	db()
		.prepare(
			`INSERT OR REPLACE INTO manifests (registry_id, repo, digest, media_type, size, created, config_digest, platforms, labels)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(registryId, repo, m.digest, m.mediaType, m.size, m.created, m.configDigest, JSON.stringify(m.platforms), JSON.stringify(m.labels));
}

type ImageRowDb = {
	registry_id: string;
	repo: string;
	tag: string;
	digest: string;
	pushed_at: string | null;
	media_type: string | null;
	size: number | null;
	created: string | null;
	config_digest: string | null;
	platforms: string | null;
	labels: string | null;
};

const toImage = (r: ImageRowDb): ImageRow => ({
	registryId: r.registry_id,
	repo: r.repo,
	tag: r.tag,
	digest: r.digest,
	mediaType: r.media_type,
	size: r.size,
	created: r.created,
	pushedAt: r.pushed_at,
	platforms: parse(r.platforms, []),
	configDigest: r.config_digest,
	labels: parse(r.labels, {})
});

const IMAGE_FROM = `
	FROM tags t
	JOIN registries r ON r.id = t.registry_id
	LEFT JOIN manifests m ON m.registry_id = t.registry_id AND m.repo = t.repo AND m.digest = t.digest`;
const IMAGE_COLS = 't.registry_id, t.repo, t.tag, t.digest, t.pushed_at, m.media_type, m.size, m.created, m.config_digest, m.platforms, m.labels';
// Newest first: when it was pushed, else when it was built.
const IMAGE_ORDER = `COALESCE(t.pushed_at, m.created) DESC NULLS LAST, t.repo, t.tag`;

export type SearchOptions = { q: string; registryId?: string; limit?: number; offset?: number };

/** The WHERE clause for a search over tags. See search.ts for the query language. */
function searchWhere(q: string, registryId?: string): { w: string; args: SQLInputValue[] } {
	const where: string[] = [];
	const args: SQLInputValue[] = [];
	if (registryId) {
		where.push('t.registry_id = ?');
		args.push(registryId);
	}
	for (const term of parseSearch(q)) {
		let clause: string;
		const v = term.value;
		switch (term.field) {
			case 'repo':
				clause = `t.repo LIKE ? ESCAPE '\\'`;
				args.push(likePattern(v));
				break;
			case 'tag':
				clause = `t.tag LIKE ? ESCAPE '\\'`;
				args.push(likePattern(v));
				break;
			case 'digest':
				clause = `(t.digest LIKE ? OR m.config_digest LIKE ?)`;
				args.push(digestPrefix(v), digestPrefix(v));
				break;
			case 'registry':
				clause = `(r.name LIKE ? ESCAPE '\\' OR r.kind = ? OR r.id = ?)`;
				args.push(likePattern(v), v.toLowerCase(), v);
				break;
			case 'arch':
				clause = `m.platforms LIKE ? ESCAPE '\\'`;
				args.push(likePattern(v));
				break;
			case 'label': {
				const eq = v.indexOf('=');
				const key = eq === -1 ? v : v.slice(0, eq);
				const val = eq === -1 ? null : v.slice(eq + 1);
				clause = `EXISTS (SELECT 1 FROM json_each(m.labels) j WHERE j.key LIKE ? ESCAPE '\\'${val === null ? '' : ` AND j.value LIKE ? ESCAPE '\\'`})`;
				args.push(likePattern(key, { anchored: !key.includes('*') }));
				if (val !== null) args.push(likePattern(val, { anchored: !val.includes('*') }));
				break;
			}
			case 'ref': {
				const { repo, tag, digest } = splitRef(v);
				clause = `t.repo LIKE ? ESCAPE '\\'`;
				args.push(`%${likePattern(repo, { anchored: true })}`);
				if (tag) {
					clause += ` AND t.tag LIKE ? ESCAPE '\\'`;
					args.push(likePattern(tag, { anchored: true }) + (tag.includes('*') ? '' : '%'));
				}
				if (digest) {
					clause += ' AND t.digest LIKE ?';
					args.push(digestPrefix(digest));
				}
				clause = `(${clause})`;
				break;
			}
			default: {
				const p = likePattern(v);
				clause = `(t.repo LIKE ? ESCAPE '\\' OR t.tag LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')`;
				args.push(p, p, p);
			}
		}
		where.push(term.negate ? `NOT ${clause}` : clause);
	}
	return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** Searches every indexed tag. */
export function searchImages({ q, registryId, limit = 100, offset = 0 }: SearchOptions): { rows: ImageRow[]; total: number } {
	const { w, args } = searchWhere(q, registryId);
	const total = (db().prepare(`SELECT COUNT(*) AS n ${IMAGE_FROM} ${w}`).get(...args) as { n: number }).n;
	const rows = db()
		.prepare(`SELECT ${IMAGE_COLS} ${IMAGE_FROM} ${w} ORDER BY ${IMAGE_ORDER} LIMIT ? OFFSET ?`)
		.all(...args, limit, offset) as ImageRowDb[];
	return { rows: rows.map(toImage), total };
}

/**
 * The same search, one row per image (registry + repository): how many of its tags match, how many
 * distinct versions (digests) they cover, and its newest matching tags.
 */
export function searchRepos({ q, registryId, limit = 100, offset = 0 }: SearchOptions): { repos: RepoSummary[]; total: number } {
	const { w, args } = searchWhere(q, registryId);
	const d = db();
	const total = (d.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${IMAGE_FROM} ${w} GROUP BY t.registry_id, t.repo)`).get(...args) as { n: number }).n;
	const groups = d
		.prepare(
			`SELECT t.registry_id, t.repo, COUNT(*) AS matches, COUNT(DISTINCT t.digest) AS versions, MAX(COALESCE(t.pushed_at, m.created)) AS updated_at,
				(SELECT COUNT(*) FROM tags x WHERE x.registry_id = t.registry_id AND x.repo = t.repo) AS tag_count
			 ${IMAGE_FROM} ${w} GROUP BY t.registry_id, t.repo ORDER BY updated_at DESC NULLS LAST, t.repo LIMIT ? OFFSET ?`
		)
		.all(...args, limit, offset) as { registry_id: string; repo: string; matches: number; versions: number; updated_at: string | null; tag_count: number }[];
	const newest = d.prepare(`SELECT ${IMAGE_COLS} ${IMAGE_FROM} ${w ? `${w} AND` : 'WHERE'} t.registry_id = ? AND t.repo = ? ORDER BY ${IMAGE_ORDER} LIMIT 8`);
	const repos = groups.map((g): RepoSummary => {
		const rows = (newest.all(...args, g.registry_id, g.repo) as ImageRowDb[]).map(toImage);
		return { registryId: g.registry_id, repo: g.repo, tagCount: g.tag_count, matches: g.matches, versions: g.versions, updatedAt: g.updated_at, latest: rows[0], tags: rows.map((r) => r.tag) };
	});
	return { repos, total };
}

export function listRepos(registryId: string): RepoRow[] {
	const rows = db()
		.prepare(
			`SELECT t.repo AS name, COUNT(*) AS tag_count, MAX(m.size) AS size, MAX(COALESCE(t.pushed_at, m.created)) AS updated_at
			 ${IMAGE_FROM} WHERE t.registry_id = ? GROUP BY t.repo ORDER BY t.repo`
		)
		.all(registryId) as { name: string; tag_count: number; size: number | null; updated_at: string | null }[];
	return rows.map((r) => ({ registryId, name: r.name, tagCount: r.tag_count, size: r.size, updatedAt: r.updated_at }));
}

export function repoTags(registryId: string, repo: string): ImageRow[] {
	return (db().prepare(`SELECT ${IMAGE_COLS} ${IMAGE_FROM} WHERE t.registry_id = ? AND t.repo = ? ORDER BY ${IMAGE_ORDER}`).all(registryId, repo) as ImageRowDb[]).map(toImage);
}

/** The indexed tag or digest, if the index has it. */
export function findImage(registryId: string, repo: string, ref: string): ImageRow | undefined {
	const col = ref.startsWith('sha256:') ? 't.digest' : 't.tag';
	const r = db().prepare(`SELECT ${IMAGE_COLS} ${IMAGE_FROM} WHERE t.registry_id = ? AND t.repo = ? AND ${col} = ? LIMIT 1`).get(registryId, repo, ref) as ImageRowDb | undefined;
	return r && toImage(r);
}

export function tagsForDigest(registryId: string, repo: string, digest: string): string[] {
	return (db().prepare('SELECT tag FROM tags WHERE registry_id = ? AND repo = ? AND digest = ? ORDER BY tag').all(registryId, repo, digest) as { tag: string }[]).map((r) => r.tag);
}

export function deleteIndexedTag(registryId: string, repo: string, tag: string) {
	db().prepare('DELETE FROM tags WHERE registry_id = ? AND repo = ? AND tag = ?').run(registryId, repo, tag);
}

export function indexTotals(): { registries: number; repos: number; tags: number; digests: number } {
	return db()
		.prepare(
			`SELECT (SELECT COUNT(*) FROM registries) AS registries,
				(SELECT COUNT(*) FROM (SELECT DISTINCT registry_id, repo FROM tags)) AS repos,
				(SELECT COUNT(*) FROM tags) AS tags,
				(SELECT COUNT(DISTINCT digest) FROM tags) AS digests`
		)
		.get() as { registries: number; repos: number; tags: number; digests: number };
}

/* ---------- share links ---------- */

type LinkRowDb = {
	id: string;
	registry_id: string;
	repo: string;
	ref: string;
	digest: string | null;
	platform: string | null;
	note: string | null;
	created_by: string | null;
	created_at: string;
	expires_at: string | null;
	max_downloads: number | null;
	downloads: number;
	last_download_at: string | null;
	revoked_at: string | null;
};

export function linkState(l: { revokedAt: string | null; expiresAt: string | null; maxDownloads: number | null; downloads: number }, at = Date.now()): LinkState {
	if (l.revokedAt) return 'revoked';
	if (l.maxDownloads !== null && l.downloads >= l.maxDownloads) return 'used';
	if (l.expiresAt && Date.parse(l.expiresAt) <= at) return 'expired';
	return 'active';
}

function toLink(r: LinkRowDb): ShareLink {
	const l = {
		id: r.id,
		registryId: r.registry_id,
		repo: r.repo,
		ref: r.ref,
		digest: r.digest,
		platform: r.platform,
		note: r.note,
		createdBy: r.created_by,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		maxDownloads: r.max_downloads,
		downloads: r.downloads,
		lastDownloadAt: r.last_download_at,
		revokedAt: r.revoked_at
	};
	return { ...l, state: linkState(l) };
}

export function listLinks(): ShareLink[] {
	return (db().prepare('SELECT * FROM links ORDER BY created_at DESC').all() as LinkRowDb[]).map(toLink);
}

export function getLink(id: string): ShareLink | undefined {
	const r = db().prepare('SELECT * FROM links WHERE id = ?').get(id) as LinkRowDb | undefined;
	return r && toLink(r);
}

export function linkByTokenHash(hash: string): ShareLink | undefined {
	const r = db().prepare('SELECT * FROM links WHERE token_hash = ?').get(hash) as LinkRowDb | undefined;
	return r && toLink(r);
}

export function createLink(input: Omit<ShareLink, 'id' | 'createdAt' | 'downloads' | 'lastDownloadAt' | 'revokedAt' | 'state'> & { tokenHash: string }): ShareLink {
	const id = randomUUID();
	db()
		.prepare(
			`INSERT INTO links (id, token_hash, registry_id, repo, ref, digest, platform, note, created_by, created_at, expires_at, max_downloads)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.tokenHash, input.registryId, input.repo, input.ref, input.digest, input.platform, input.note, input.createdBy, now(), input.expiresAt, input.maxDownloads);
	return getLink(id)!;
}

/**
 * Takes one download from the link, atomically, so a one-time link can't be fetched twice by
 * two requests at once. Returns false when the link has none left (or expired, or was revoked).
 */
export function claimLinkDownload(id: string): boolean {
	return (
		db()
			.prepare(
				`UPDATE links SET downloads = downloads + 1, last_download_at = ?
				 WHERE id = ? AND revoked_at IS NULL
				   AND (max_downloads IS NULL OR downloads < max_downloads)
				   AND (expires_at IS NULL OR expires_at > ?)`
			)
			.run(now(), id, now()).changes > 0
	);
}

/** Gives back a download that failed before the file was sent, so a one-time link isn't spent on an error. */
export function releaseLinkDownload(id: string) {
	db().prepare('UPDATE links SET downloads = MAX(downloads - 1, 0) WHERE id = ?').run(id);
}

export function revokeLink(id: string): boolean {
	return db().prepare('UPDATE links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id).changes > 0;
}

export function deleteLink(id: string): boolean {
	return db().prepare('DELETE FROM links WHERE id = ?').run(id).changes > 0;
}

/* ---------- activity ---------- */

export function logActivity(action: string, opts: { actor?: string | null; target?: string | null; detail?: string | null } = {}) {
	db()
		.prepare('INSERT INTO activity (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
		.run(now(), opts.actor ?? null, action, opts.target ?? null, opts.detail ?? null);
	// Keep a year, at most 20k entries.
	db().prepare(`DELETE FROM activity WHERE at < ? OR id <= (SELECT MAX(id) - 20000 FROM activity)`).run(new Date(Date.now() - 365 * 86400_000).toISOString());
}

export function listActivity(limit = 200): Activity[] {
	return db().prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as Activity[];
}
