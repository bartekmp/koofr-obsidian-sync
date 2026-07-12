/**
 * TypeScript interfaces and types for the Koofr sync plugin
 */

// ============================================================================
// Authentication Types
// ============================================================================

/** Response body from POST /token */
export interface KoofrTokenResponse {
	token: string;
}

/** Credentials cached in SecretStorage — re-used to silently re-authenticate on 401 */
export interface StoredCredentials {
	email: string;
	appPassword: string;
	/** Last-issued auth token, cached to avoid re-authenticating on every launch */
	token?: string;
}

// ============================================================================
// Koofr REST API v2 Types
// ============================================================================

/**
 * A single file or folder as returned by the Koofr API. Unlike OneDrive,
 * Koofr has no stable object ID — everything is addressed by path.
 */
export interface KoofrFileInfo {
	name: string;
	type: 'file' | 'dir';
	/** Epoch milliseconds */
	modified: number;
	size: number;
	contentType?: string;
	/** Full path from the mount root, e.g. "/MyVault/notes/note.md" */
	path: string;
	/** Opaque content hash used to detect remote changes */
	hash?: string;
}

/** Raw nested response shape from GET /files/tree — flattened by KoofrClient before use elsewhere */
export interface KoofrTreeNode extends Omit<KoofrFileInfo, 'path'> {
	path?: string;
	children?: KoofrTreeNode[];
}

export interface KoofrMount {
	id: string;
	name: string;
	type: string; // 'device' | 'export' | 'import'
	isPrimary: boolean;
	isShared: boolean;
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncState {
	lastSyncTime: number; // Unix timestamp in milliseconds
	fileStates: Map<string, FileState>;
	/** Known remote folder paths — used to detect folder deletes by absence from the next snapshot */
	folderPaths: Set<string>;
}

export interface FileState {
	path: string;
	localMtime: number; // from Obsidian file.stat.mtime
	remoteHash: string; // content hash from Koofr
	size: number;
	remoteModifiedTime: number;
	localContentHash?: string; // hex hash of local content (config files only)
}

export enum LocalChangeType {
	MODIFY = 'modify',
	CREATE = 'create',
	DELETE = 'delete',
	RENAME = 'rename',
	FOLDER_CREATE = 'folder-create',
	FOLDER_DELETE = 'folder-delete',
	FOLDER_RENAME = 'folder-rename',
}

export interface LocalChange {
	path: string;
	type: LocalChangeType;
	oldPath?: string; // for renames
}

export enum SyncDirection {
	UPLOAD = 'upload',
	DOWNLOAD = 'download',
	SKIP = 'skip',
	CONFLICT = 'conflict',
	MOVE = 'move', // Atomic move/rename using Koofr's move API
}

export interface SyncOperation {
	path: string;
	direction: SyncDirection;
	localState?: FileState;
	remoteState?: FileState;
	// For MOVE operations: the remote path being moved from
	moveFromPath?: string;
}

export interface LargeDeleteWarningInfo {
	localDeleteCount: number; // files about to be deleted from the local vault (driven by remote)
	remoteDeleteCount: number; // files about to be deleted from Koofr (driven by local)
	threshold: number;
	sampleLocalDeletes: string[]; // up to 10 example paths
	sampleRemoteDeletes: string[]; // up to 10 example paths
}

export type LargeDeleteDecision = 'proceed' | 'cancel' | 'disable';

export type LargeDeleteWarningHandler = (
	info: LargeDeleteWarningInfo
) => Promise<LargeDeleteDecision>;

/**
 * Minimal interface for ConflictQueue used by SyncEngine.
 * Avoids circular import with the full ConflictQueue class.
 */
export interface SyncEngineConflictQueue {
	/** Check if a conflict exists for the given path */
	hasConflict(path: string): boolean;
	/** Add a new conflict to the queue */
	add(
		path: string,
		localContent: ArrayBuffer,
		remoteContent: ArrayBuffer,
		localMtime: number,
		remoteMtime: number,
		remoteHash: string
	): Promise<ConflictEntry>;
}

/**
 * Optional configuration for SyncEngine.
 * Core dependencies (app, fileOps, client, etc.) are required positionally;
 * these options control behavior and callbacks.
 */
export interface SyncEngineOptions {
	/** Remote folder path for uploads (empty for mount root) */
	remoteRoot?: string;
	/**
	 * Queue for manual conflict resolution.
	 * Accepts the ConflictQueue class from sync/conflictQueue.ts.
	 * Uses a minimal interface to avoid circular imports.
	 */
	conflictQueue?: SyncEngineConflictQueue;
	/** Filter function to determine which paths should sync */
	shouldSyncPath?: (path: string) => boolean;
	/** Returns the threshold for large delete warnings (0 = disabled) */
	getLargeDeleteThreshold?: () => number;
	/** Handler called when large delete threshold is exceeded */
	largeDeleteWarningHandler?: LargeDeleteWarningHandler;
	/** Callback for sync progress updates */
	onProgress?: (message: string | undefined) => void;
	/** Plugin version for User-Agent headers */
	pluginVersion?: string;
	/** Max concurrent upload/download operations */
	maxConcurrentOperations?: number;
	/** Use atomic move API instead of delete+upload */
	useAtomicMoves?: boolean;
	/** Returns true if pull-only mode is enabled */
	isPullOnlyMode?: () => boolean;
}

export enum ConflictResolutionStrategy {
	LAST_WRITE_WINS = 'last-write-wins',
	CREATE_DUPLICATE = 'create-duplicate',
	MANUAL = 'manual',
}

export interface ConflictInfo {
	path: string;
	localModifiedTime: number;
	remoteModifiedTime: number;
	localSize: number;
	remoteSize: number;
}

// ============================================================================
// Conflict Queue Types
// ============================================================================

export enum ConflictResolution {
	ACCEPT_CURRENT = 'accept-current',
	ACCEPT_INCOMING = 'accept-incoming',
	ACCEPT_BOTH = 'accept-both',
}

export interface ConflictEntry {
	id: string;
	path: string;
	localModifiedTime: number;
	remoteModifiedTime: number;
	localSize: number;
	remoteSize: number;
	remoteHash: string;
	createdAt: number;
	isTextFile: boolean;
}

export interface PersistedConflictQueue {
	entries: ConflictEntry[];
}

// ============================================================================
// Plugin Settings Types
// ============================================================================

/** Experimental settings — performance tuning and unstable features */
export interface ExperimentalSettings {
	/**
	 * Skip folder existence checks before uploads. Unlike OneDrive, it's not
	 * confirmed whether Koofr auto-creates parent folders on upload — default
	 * OFF (checks run) until verified against a real account.
	 */
	skipFolderChecks: boolean;
	maxConcurrentOperations: number; // Max parallel sync operations (uploads/downloads)
	useAtomicMoves: boolean; // Use Koofr's move API instead of delete+upload
	pullOnlyMode: boolean; // Pull-only sync: download remote changes but never upload local changes
}

export const DEFAULT_EXPERIMENTAL_SETTINGS: ExperimentalSettings = {
	skipFolderChecks: false, // Default OFF — Koofr's auto-create behavior on upload is unconfirmed
	maxConcurrentOperations: 4, // Conservative default
	useAtomicMoves: true, // Default ON — atomic moves are more efficient and avoid duplicates
	pullOnlyMode: false, // Default OFF — bidirectional sync is the normal behavior
};

export interface PluginSettings {
	// Authentication — app password lives in SecretStorage, not here
	connectedEmail?: string;

	// Sync target
	mountId?: string;
	mountName?: string;
	remotePath?: string; // Folder within the mount, sync root

	// Sync configuration
	syncInterval: number; // Minutes (0 = manual only)
	syncOnFileChange: boolean; // Trigger sync automatically when files are modified
	conflictResolution: ConflictResolutionStrategy;
	startupSyncDelay: number; // Seconds (0 = disabled, 1, 10, 30)
	syncAppSettings: boolean; // Opt-in sync for Obsidian app settings (app.json, appearance.json, hotkeys.json)
	syncPluginManifests: boolean; // Opt-in sync for selected Obsidian plugin manifest files and binaries
	syncCssSnippets: boolean; // Opt-in sync for CSS snippets in .obsidian/snippets/
	syncState?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderPaths?: string[];
	};
	conflictQueue?: PersistedConflictQueue;

	// Advanced
	logLevel: 'off' | 'error' | 'warn' | 'info' | 'debug';
	largeDeleteThreshold: number; // Warn if a sync would delete more than this many files (0 = disabled)

	// Experimental
	experimental?: ExperimentalSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	connectedEmail: undefined,

	mountId: undefined,
	mountName: undefined,
	remotePath: undefined,

	syncInterval: 5, // Poll every 5 minutes
	syncOnFileChange: true,
	conflictResolution: ConflictResolutionStrategy.LAST_WRITE_WINS,
	startupSyncDelay: 10, // 10 seconds default
	syncAppSettings: false,
	syncPluginManifests: false,
	syncCssSnippets: false,
	syncState: undefined,
	conflictQueue: undefined,

	logLevel: 'off',
	largeDeleteThreshold: 25,

	// Experimental — defaults applied via DEFAULT_EXPERIMENTAL_SETTINGS in main.ts
	experimental: undefined,
};

// ============================================================================
// Error Types
// ============================================================================

export class KoofrError extends Error {
	constructor(
		message: string,
		public code?: string,
		public statusCode?: number
	) {
		super(message);
		this.name = 'KoofrError';
	}
}

export class AuthenticationError extends KoofrError {
	constructor(message: string, code?: string) {
		super(message, code, 401);
		this.name = 'AuthenticationError';
	}
}

export class RateLimitError extends KoofrError {
	constructor(
		message: string,
		public retryAfter?: number
	) {
		super(message, 'rate_limit', 429);
		this.name = 'RateLimitError';
	}
}

export class SyncError extends Error {
	constructor(
		message: string,
		public path?: string,
		public operation?: string
	) {
		super(message);
		this.name = 'SyncError';
	}
}
