export type UserRole = 'admin' | 'member';

export type User = {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	createdAt: string;
	lastLoginAt: string | null;
};

/** The signed-in person, as the browser sees them. */
export type Viewer = { email: string; name: string | null; admin: boolean };

/**
 * Where images come from. Everything that speaks the registry API (Harbor, GitLab, Gitea, Quay,
 * Nexus, Artifactory, Azure, Google Artifact Registry, a local registry:2) is `registry`; the
 * others list repositories through their own APIs, or are the Docker Engine itself.
 */
export type RegistryKind = 'registry' | 'ecr' | 'dockerhub' | 'ghcr' | 'docker';

export type RegistryConfig = {
	/** Registry API base, e.g. https://registry.example.com or http://localhost:5000. */
	url?: string;
	username?: string;
	/** ECR: the region, and the account (blank: the credentials' own). */
	region?: string;
	accountId?: string;
	/** ECR: keys entered here, or the container's environment / instance role. */
	awsAuth?: 'keys' | 'environment';
	/** Docker Hub: the namespaces (users or orgs) to list. GHCR: the owner, and whether it's an org. */
	namespaces?: string[];
	owner?: string;
	ownerType?: 'user' | 'org';
	/** Repositories to index besides (or, where the registry can't list them, instead of) discovery. */
	repositories?: string[];
	/** Only index repositories matching these globs (blank: all). */
	include?: string[];
};

export type RegistrySecrets = {
	password?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
};

export type RegistryStatus = 'unknown' | 'ok' | 'error';

export type Registry = {
	id: string;
	name: string;
	kind: RegistryKind;
	config: RegistryConfig;
	/** Which secrets are stored (never their values). */
	secrets: (keyof RegistrySecrets)[];
	status: RegistryStatus;
	lastError: string | null;
	syncedAt: string | null;
	createdAt: string;
	/** The host:port that goes in front of image names, e.g. 123.dkr.ecr.us-east-1.amazonaws.com. */
	host: string;
	repoCount: number;
	tagCount: number;
	syncing: boolean;
};

/** A tag in the index, joined with what its manifest says. */
export type ImageRow = {
	registryId: string;
	repo: string;
	tag: string;
	digest: string;
	mediaType: string | null;
	/** Compressed size: config plus layers (for a multi-platform image, the largest platform). */
	size: number | null;
	/** The image config's `created`. */
	created: string | null;
	pushedAt: string | null;
	/** os/arch[/variant] for each platform; one entry for a single-platform image. */
	platforms: string[];
	/** The image ID `docker images` shows (the config digest); for multi-platform images, the first platform's. */
	configDigest: string | null;
	labels: Record<string, string>;
};

export type RepoRow = { registryId: string; name: string; tagCount: number; size: number | null; updatedAt: string | null };

/** One image (a repository in a registry) in search results. */
export type RepoSummary = {
	registryId: string;
	repo: string;
	tagCount: number;
	/** Tags that match the search (all of them when there's no search). */
	matches: number;
	/** Distinct digests among the matching tags. */
	versions: number;
	updatedAt: string | null;
	/** The newest matching tag. */
	latest: ImageRow;
	/** The newest matching tags, newest first (up to 8). */
	tags: string[];
};

export type Descriptor = { mediaType: string; digest: string; size: number; platform?: { os: string; architecture: string; variant?: string }; annotations?: Record<string, string> };

/** What the image page shows for one platform. */
export type ImagePlatform = {
	platform: string;
	digest: string;
	configDigest: string;
	size: number;
	layers: Descriptor[];
	created: string | null;
	env: string[];
	entrypoint: string[] | null;
	cmd: string[] | null;
	workdir: string | null;
	user: string | null;
	exposedPorts: string[];
	labels: Record<string, string>;
	history: { created: string | null; createdBy: string; emptyLayer: boolean; comment: string | null }[];
};

export type ImageDetail = {
	registryId: string;
	repo: string;
	ref: string;
	digest: string;
	mediaType: string;
	/** The manifest as the registry sent it, pretty-printed. */
	manifest: string;
	platforms: ImagePlatform[];
	/** Other tags in the index pointing at the same digest. */
	aliases: string[];
	pullRef: string;
};

export type LinkState = 'active' | 'expired' | 'used' | 'revoked';

export type ShareLink = {
	id: string;
	registryId: string;
	repo: string;
	/** The tag or digest the link was made for. */
	ref: string;
	/** The digest it's pinned to, or null when it follows the tag to whatever it points at when downloaded. */
	digest: string | null;
	/** os/arch for multi-platform images. */
	platform: string | null;
	note: string | null;
	createdBy: string | null;
	createdAt: string;
	expiresAt: string | null;
	maxDownloads: number | null;
	downloads: number;
	lastDownloadAt: string | null;
	revokedAt: string | null;
	state: LinkState;
};

export type Activity = { id: number; at: string; actor: string | null; action: string; target: string | null; detail: string | null };

export type Settings = {
	/** Minutes between automatic syncs of every registry; 0 turns them off. */
	syncMinutes: number;
	/** Tags per repository to index, newest first where the registry says which are newest. */
	maxTagsPerRepo: number;
	/** The address share links use, e.g. https://wharf.example.com (blank: the address you're using). */
	publicUrl: string;
	/** Defaults for new share links. */
	linkHours: number;
	linkMaxDownloads: number;
};
