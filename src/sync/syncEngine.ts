/**
 * Sync Engine - Core synchronization logic for Koofr ↔ Obsidian vault
 *
 * This is the heart of the plugin, orchestrating bidirectional sync between
 * the local Obsidian vault and Koofr cloud storage.
 *
 * ## Why this looks different from a delta-cursor-based engine
 *
 * Koofr's REST API has no incremental change/delta endpoint — see
 * `KoofrClient.getTree()`. Every sync fetches one full recursive snapshot
 * of the remote folder and diffs it against the locally-tracked FileState
 * map by content hash. This removes an entire category of complexity that
 * exists in delta-based engines purely to cope with bare-ID delete events
 * and folder-delete expansion: here, a file or folder's absence from the
 * fresh snapshot IS the delete signal, compared directly by path (Koofr
 * has no stable object IDs at all — everything is path-addressed).
 *
 * ## Sync Flow Overview
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         performSync() Entry Point                       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                         │
 * │  1. gatherLocalChanges()     ──→  Collect dirty files from EventManager │
 * │                                   + detect .obsidian config changes     │
 * │                                                                         │
 * │  2. fetchRemoteSnapshot()    ──→  One recursive Koofr tree listing      │
 * │                                                                         │
 * │  3. planOperations()         ──→  Diff local vs remote snapshot by      │
 * │                                   content hash, decide:                 │
 * │                                   • UPLOAD (local → cloud)              │
 * │                                   • DOWNLOAD (cloud → local)            │
 * │                                   • CONFLICT (needs resolution)         │
 * │                                                                         │
 * │  4. executeSyncOperations()  ──→  Parallel upload/download with         │
 * │                                   concurrency limit                     │
 * │                                                                         │
 * │  5. Finalize                 ──→  Store folder-path set, clear dirty    │
 * │                                   queue, update sync state              │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Extensibility seam
 *
 * This engine only ever calls FileOperations' public methods, which in turn
 * only ever call KoofrClient's public methods — both operate on the generic
 * `KoofrFileInfo`/`FileState` shapes defined in types.ts, never on raw Koofr
 * REST response shapes. A future second backend means writing a new
 * `*Client` + `FileOperations` pair with the same method shapes, not
 * touching this file's diff/planning logic.
 *
 * @see EventManager for local change tracking
 * @see KoofrClient for REST API operations
 * @see ConflictResolver for conflict handling strategies
 */

import { App, Notice, TFile, TFolder } from 'obsidian';
import { FileOperations } from '../api/fileOperations';
import { KoofrFileInfo } from '../types';
import { SyncStateManager } from './syncState';
import { ConflictResolver } from './conflictResolver';
import { EventManager } from './eventManager';
import {
	SyncOperation,
	SyncDirection,
	FileState,
	ConflictInfo,
	LocalChange,
	LocalChangeType,
	LargeDeleteWarningHandler,
	LargeDeleteDecision,
	SyncEngineOptions,
	SyncEngineConflictQueue,
} from '../types';
import { logger } from '../utils/logger';
import {
	normalizePath,
	toRemotePath,
	toVaultPath,
	getParentPath,
	shouldSyncVaultPath,
	getAllSyncableConfigPaths,
} from '../utils/pathUtils';
import { ProgressNotice } from '../ui/progressNotice';
import { t } from '../i18n';

/**
 * FNV-1a 32-bit hash of binary content, returned as hex string.
 * Used to detect whether config file content actually changed
 * vs Obsidian just touching the file on startup.
 */
function hashContent(data: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Progress callback — pass undefined to clear the status bar message. */
type ProgressFn = (message: string | undefined) => void;

/** Returned by gatherLocalChanges: filtered dirty files, folder changes, and the count of ignored paths. */
interface LocalChangesResult {
	localChanges: LocalChange[];
	folderChanges: LocalChange[];
	ignoredCount: number;
}

/** Returned by fetchRemoteSnapshot: the current remote files and folders, keyed/filtered by vault path. */
interface RemoteSnapshotResult {
	remoteFiles: Map<string, KoofrFileInfo>;
	remoteFolderVaultPaths: Set<string>;
}

/**
 * Returned by executeSyncOperations: counts of completed operations and
 * the paths that were downloaded or ended in conflict (needed for post-sync
 * dirty-file cleanup).
 */
interface SyncExecutionResult {
	completed: number;
	downloadedPaths: string[];
	conflictedPaths: string[];
}

/**
 * Main sync engine
 */
export class SyncEngine {
	// Concurrent operations limit — overridable via experimental settings.
	private readonly maxConcurrentOperations: number;
	private static readonly DEFAULT_IGNORE_PATTERNS: string[] = [];
	private pendingVaultFolderCreates = new Map<string, Promise<void>>();

	// Options stored as instance properties
	private readonly remoteRoot: string;
	private readonly conflictQueue?: SyncEngineConflictQueue;
	private readonly shouldSyncPath: (path: string) => boolean;
	private readonly getLargeDeleteThreshold: () => number;
	private readonly largeDeleteWarningHandler?: LargeDeleteWarningHandler;
	private readonly onProgress?: (message: string | undefined) => void;
	private readonly pluginVersion: string;
	private readonly isPullOnlyMode: () => boolean;

	constructor(
		private app: App,
		private fileOps: FileOperations,
		private stateManager: SyncStateManager,
		private conflictResolver: ConflictResolver,
		private eventManager: EventManager,
		private configDir: string,
		options: SyncEngineOptions = {}
	) {
		this.remoteRoot = options.remoteRoot ?? '';
		this.conflictQueue = options.conflictQueue;
		this.shouldSyncPath =
			options.shouldSyncPath ?? ((path) => shouldSyncVaultPath(path, false, false, configDir));
		this.getLargeDeleteThreshold = options.getLargeDeleteThreshold ?? (() => 0);
		this.largeDeleteWarningHandler = options.largeDeleteWarningHandler;
		this.onProgress = options.onProgress;
		this.pluginVersion = options.pluginVersion ?? 'unknown';
		this.maxConcurrentOperations = options.maxConcurrentOperations ?? 4;
		this.isPullOnlyMode = options.isPullOnlyMode ?? (() => false);
	}

	/**
	 * Perform a sync using a full remote snapshot + local dirty files.
	 *
	 * Orchestrates five phases:
	 *   1. Gather local dirty files (gatherLocalChanges)
	 *   2. Fetch a fresh remote snapshot (fetchRemoteSnapshot)
	 *   3. Plan operations by diffing local vs remote (planOperations)
	 *   4. Execute uploads / downloads / deletes (executeSyncOperations)
	 *   5. Finalize — store folder-path set, clear dirty queue, notify user
	 */
	async performSync(): Promise<void> {
		logger.info(`Koofr Sync v${this.pluginVersion} — starting sync`);
		const progress: ProgressFn = (msg) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress(t('progress.starting'));

			this.logInventoryDrift();

			const ignoreMatchers = await this.loadIgnoreMatchers();
			const isFirstSync = this.stateManager.isFirstSync();
			const { localChanges, folderChanges } = await this.gatherLocalChanges(ignoreMatchers);

			const { remoteFiles, remoteFolderVaultPaths } = await this.fetchRemoteSnapshot(
				ignoreMatchers,
				progress
			);

			// Seed FileOperations' known-folder cache from this snapshot so
			// uploads this sync skip a live existence check for any folder
			// we already know is there.
			this.fileOps.seedKnownFolders(this.knownRemoteFolderPaths(remoteFolderVaultPaths));

			// Reconcile the tracked folder-path set with what the snapshot shows
			// exists remotely right now — folders gone from the snapshot are
			// deletes; new ones are simply recorded.
			const deletedFolderPaths = this.stateManager
				.getAllFolderPaths()
				.filter((p) => !remoteFolderVaultPaths.has(p));
			for (const p of remoteFolderVaultPaths) {
				if (!this.stateManager.hasFolderPath(p)) this.stateManager.addFolderPath(p);
			}
			for (const p of deletedFolderPaths) {
				this.stateManager.removeFolderPath(p);
			}

			const operations = this.planOperations(localChanges, remoteFiles, ignoreMatchers);

			logger.info(`Sync plan: ${operations.length} operations`);
			for (const op of operations) {
				logger.debug(`  Op: ${op.direction} ${op.path}`);
			}

			if (!isFirstSync) {
				const decision = await this.maybeWarnLargeDeletes(operations);
				if (decision === 'cancel' || decision === 'disable') {
					logger.warn(`Sync aborted by user (${decision}) due to large delete count.`);
					new Notice(
						decision === 'disable'
							? t('notices.sync.disabledAfterLargeDelete')
							: t('notices.sync.cancelledAfterLargeDelete')
					);
					return;
				}
			}

			if (
				operations.length === 0 &&
				folderChanges.length === 0 &&
				deletedFolderPaths.length === 0
			) {
				if (isFirstSync && localChanges.length === 0 && remoteFiles.size === 0) {
					logger.info('First sync with no local files and empty remote — nothing to do.');
					new Notice(t('notices.sync.noFilesToSync'));
				} else {
					logger.info('Everything up to date — no operations needed');
				}
				this.stateManager.setLastSyncTime(Date.now());
				this.eventManager.markInitialSyncDone();
				return;
			}

			const { completed, downloadedPaths, conflictedPaths } = await this.executeSyncOperations(
				operations,
				progress
			);

			// Clean up empty folders left behind because the cloud told us they're gone
			if (deletedFolderPaths.length > 0) {
				await this.deleteCloudDeletedFolders(deletedFolderPaths);
			}

			await this.processFolderChanges(folderChanges);

			// Prune remote config folders (.obsidian/plugins/*) left empty
			// after local-driven file deletes.
			await this.pruneEmptyRemoteConfigFolders(operations);

			if (downloadedPaths.length > 0) {
				this.eventManager.removeDirtyPaths(downloadedPaths);
			}

			this.stateManager.setLastSyncTime(Date.now());

			this.eventManager.clearDirtyFiles();
			for (const path of conflictedPaths) {
				this.eventManager.addDirtyFile(path, 'modify');
			}

			logger.debug('Sync operations finished');
			this.eventManager.markInitialSyncDone();

			const syncedCount = completed - conflictedPaths.length;
			if (conflictedPaths.length > 0) {
				new Notice(
					t('notices.sync.conflictsNeedResolution', {
						syncedCount,
						fileLabel: t(syncedCount === 1 ? 'notices.sync.file' : 'notices.sync.files'),
						conflictCount: conflictedPaths.length,
						conflictLabel: t(
							conflictedPaths.length === 1 ? 'notices.sync.conflict' : 'notices.sync.conflicts'
						),
					})
				);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : t('notices.common.unknownError');
			logger.error(`Sync failed: ${errorMsg}`, error);
			new Notice(t('notices.sync.engineFailed', { message: errorMsg }));
			throw error;
		}
	}

	/**
	 * Log inventory drift between tracked state and actual vault files.
	 * A large gap hints at silent delete drops or a stale tracked set.
	 */
	private logInventoryDrift(): void {
		const trackedCount = this.stateManager.getTrackedPaths().length;
		const vaultCount = this.app.vault.getFiles().length;
		const drift = vaultCount - trackedCount;
		logger.info(
			`Inventory: vaultFiles=${vaultCount} trackedStates=${trackedCount} drift=${drift >= 0 ? '+' : ''}${drift}`
		);
		if (Math.abs(drift) > 10 && trackedCount > 0) {
			logger.warn(
				`Inventory drift detected: vault has ${vaultCount} files but plugin tracks ${trackedCount} (${drift >= 0 ? '+' : ''}${drift}).`
			);
		}
	}

	/**
	 * Collect local dirty files from the event manager, filtering out any
	 * that match .syncIgnore patterns. In pull-only mode, returns empty
	 * changes (local edits are not uploaded).
	 */
	private async gatherLocalChanges(ignoreMatchers: RegExp[]): Promise<LocalChangesResult> {
		if (this.isPullOnlyMode()) {
			logger.info('Pull-only mode: skipping local change detection');
			return { localChanges: [], folderChanges: [], ignoredCount: 0 };
		}

		const allLocalChanges = this.eventManager.getDirtyFiles();
		const ignoredLocalPaths: string[] = [];
		const folderChanges: LocalChange[] = [];
		const localChanges = allLocalChanges.filter((change) => {
			if (this.shouldIgnorePath(change.path, ignoreMatchers)) {
				ignoredLocalPaths.push(change.path);
				return false;
			}
			if (
				change.type === LocalChangeType.FOLDER_CREATE ||
				change.type === LocalChangeType.FOLDER_DELETE ||
				change.type === LocalChangeType.FOLDER_RENAME
			) {
				folderChanges.push(change);
				return false;
			}
			return true;
		});
		if (ignoredLocalPaths.length > 0) {
			this.eventManager.removeDirtyPaths(ignoredLocalPaths);
		}

		const configChanges = await this.detectConfigFileChanges(ignoreMatchers);
		localChanges.push(...configChanges);

		logger.info(
			`Local changes: ${localChanges.length} dirty files (${configChanges.length} config), ${folderChanges.length} folder operations`
		);

		const discoveredFolderCreates = this.discoverUntrackedLocalFolders(
			ignoreMatchers,
			folderChanges
		);
		if (discoveredFolderCreates.length > 0) {
			folderChanges.push(...discoveredFolderCreates);
			logger.info(
				`Local folder discovery: queued ${discoveredFolderCreates.length} untracked folder creates`
			);
		}

		return { localChanges, folderChanges, ignoredCount: ignoredLocalPaths.length };
	}

	private discoverUntrackedLocalFolders(
		ignoreMatchers: RegExp[],
		existingFolderChanges: LocalChange[]
	): LocalChange[] {
		const pendingFolderPaths = new Set(existingFolderChanges.map((change) => change.path));
		const configDir = normalizePath(this.configDir).replace(/\/+$/, '');
		const discovered: LocalChange[] = [];
		const root = this.app.vault.getRoot();

		const traverseFolderTree = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;

				const path = normalizePath(child.path);

				if (path === configDir || path.startsWith(`${configDir}/`)) {
					continue;
				}

				if (
					!pendingFolderPaths.has(path) &&
					!this.stateManager.hasFolderPath(path) &&
					this.shouldSyncPath(path) &&
					!this.shouldIgnorePath(path, ignoreMatchers)
				) {
					discovered.push({ path, type: LocalChangeType.FOLDER_CREATE });
					pendingFolderPaths.add(path);
				}

				traverseFolderTree(child);
			}
		};

		traverseFolderTree(root);

		return discovered;
	}

	/**
	 * Detect local changes to .obsidian/ config files by comparing their
	 * current mtime/size against the last-synced state.
	 */
	private async detectConfigFileChanges(ignoreMatchers: RegExp[]): Promise<LocalChange[]> {
		const adapter = this.app.vault.adapter;
		const changes: LocalChange[] = [];

		const allConfigPaths = await getAllSyncableConfigPaths(this.configDir, adapter, (path) =>
			this.shouldSyncPath(path)
		);

		const checkedPaths = new Set<string>();

		for (const path of allConfigPaths) {
			checkedPaths.add(path);
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			if (this.eventManager.getDirtyFiles().some((d) => d.path === path)) continue;
			if (this.eventManager.isOwnWrite(path)) continue;

			const trackedState = this.stateManager.getFileState(path);

			try {
				const stat = await adapter.stat(path);
				if (stat && stat.type === 'file') {
					if (!trackedState) {
						changes.push({ path, type: LocalChangeType.CREATE });
					} else if (stat.mtime !== trackedState.localMtime || stat.size !== trackedState.size) {
						const content = await adapter.readBinary(path);
						const hash = hashContent(new Uint8Array(content));
						if (hash !== trackedState.localContentHash) {
							if (!trackedState.localContentHash) {
								logger.debug(`Config file hash backfilled: ${path} (${hash})`);
								this.stateManager.setFileState(path, {
									...trackedState,
									localMtime: stat.mtime,
									size: stat.size,
									localContentHash: hash,
								});
							} else {
								logger.debug(`Config file content changed: ${path}`);
								changes.push({ path, type: LocalChangeType.MODIFY });
							}
						} else {
							this.stateManager.setFileState(path, {
								...trackedState,
								localMtime: stat.mtime,
								size: stat.size,
							});
						}
					}
				} else if (trackedState) {
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			} catch {
				if (trackedState) {
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			}
		}

		const pluginPrefix = `${this.configDir}/plugins/`;
		for (const path of this.stateManager.getTrackedPaths()) {
			if (!path.startsWith(pluginPrefix)) continue;
			if (checkedPaths.has(path)) continue;
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			if (this.eventManager.getDirtyFiles().some((d) => d.path === path)) continue;

			try {
				const stat = await adapter.stat(path);
				if (!stat || stat.type !== 'file') {
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			} catch {
				changes.push({ path, type: LocalChangeType.DELETE });
			}
		}

		return changes;
	}

	/**
	 * Fetch a single full recursive snapshot of the remote sync root and
	 * split it into files (by vault path) and folder vault paths, filtered
	 * by sync scope + .syncIgnore patterns.
	 */
	private async fetchRemoteSnapshot(
		ignoreMatchers: RegExp[],
		progress: ProgressFn
	): Promise<RemoteSnapshotResult> {
		progress(t('progress.fetchingRemoteChanges'));

		const items = await this.fileOps.listAllItems(this.remoteRoot);

		progress(t('progress.planning'));

		const remoteFiles = new Map<string, KoofrFileInfo>();
		const remoteFolderVaultPaths = new Set<string>();

		for (const item of items) {
			const vaultPath = this.remotePathToVaultPath(item.path);
			if (!vaultPath) continue;
			if (!this.shouldSyncPath(vaultPath)) continue;
			if (this.shouldIgnorePath(vaultPath, ignoreMatchers)) continue;

			if (item.type === 'dir') {
				remoteFolderVaultPaths.add(vaultPath);
			} else {
				remoteFiles.set(vaultPath, item);
			}
		}

		logger.info(
			`Remote snapshot: ${remoteFiles.size} files, ${remoteFolderVaultPaths.size} folders under '${this.remoteRoot || '/'}'`
		);

		return { remoteFiles, remoteFolderVaultPaths };
	}

	/**
	 * Execute all planned sync operations (uploads, downloads, deletes)
	 * with progress tracking.
	 */
	private async executeSyncOperations(
		operations: SyncOperation[],
		progress: ProgressFn
	): Promise<SyncExecutionResult> {
		let completed = 0;
		const downloadedPaths: string[] = [];
		const conflictedPaths: string[] = [];
		progress(t('progress.files', { completed: 0, total: operations.length }));
		const progressNotice =
			operations.length >= 5 ? new ProgressNotice(t('progress.syncing'), operations.length) : null;
		await this.executeOperations(operations, (operation) => {
			completed++;

			if (operation.direction === SyncDirection.DOWNLOAD) {
				downloadedPaths.push(operation.path);
			}
			if (operation.direction === SyncDirection.CONFLICT) {
				conflictedPaths.push(operation.path);
			}

			const progressLabel = t('progress.files', { completed, total: operations.length });
			progress(progressLabel);
			if (progressNotice) {
				progressNotice.update(completed, t('progress.syncing'));
			}
		});
		progressNotice?.hide();
		progress(undefined);
		return { completed, downloadedPaths, conflictedPaths };
	}

	/**
	 * Classify operations and, if the planned deletes exceed the configured
	 * threshold, ask the user whether to proceed.
	 */
	private async maybeWarnLargeDeletes(operations: SyncOperation[]): Promise<LargeDeleteDecision> {
		const threshold = Math.max(0, Math.floor(this.getLargeDeleteThreshold() || 0));
		if (threshold <= 0 || !this.largeDeleteWarningHandler) return 'proceed';

		const localDeletes: string[] = []; // remote-driven local deletes (data-loss risk)
		const remoteDeletes: string[] = []; // local-driven remote deletes
		for (const op of operations) {
			if (op.direction === SyncDirection.DOWNLOAD && op.remoteState === undefined) {
				localDeletes.push(op.path);
			} else if (
				op.direction === SyncDirection.UPLOAD &&
				op.localState === undefined &&
				op.remoteState !== undefined
			) {
				remoteDeletes.push(op.path);
			}
		}

		const total = localDeletes.length + remoteDeletes.length;
		if (total < threshold) return 'proceed';

		logger.warn(
			`Large delete detected: ${localDeletes.length} local + ${remoteDeletes.length} remote (threshold ${threshold})`
		);

		try {
			return await this.largeDeleteWarningHandler({
				localDeleteCount: localDeletes.length,
				remoteDeleteCount: remoteDeletes.length,
				threshold,
				sampleLocalDeletes: localDeletes.slice(0, 10),
				sampleRemoteDeletes: remoteDeletes.slice(0, 10),
			});
		} catch (_err) {
			logger.error(`Large-delete warning handler threw; cancelling sync as a safety default`);
			return 'cancel';
		}
	}

	/**
	 * Plan sync operations by diffing local dirty changes and the full
	 * remote snapshot against tracked FileState (by content hash).
	 */
	private planOperations(
		localChanges: LocalChange[],
		remoteFiles: Map<string, KoofrFileInfo>,
		ignoreMatchers: RegExp[]
	): SyncOperation[] {
		const operations: SyncOperation[] = [];
		const handledRemotePaths = new Set<string>();

		for (const change of localChanges) {
			if (this.conflictQueue?.hasConflict(change.path)) {
				logger.debug(`Skipping ${change.path} — pending conflict`);
				handledRemotePaths.add(change.path);
				continue;
			}

			if (change.type === LocalChangeType.DELETE) {
				const knownState = this.stateManager.getFileState(change.path);
				const remoteItem = remoteFiles.get(change.path);
				handledRemotePaths.add(change.path);
				if (knownState && remoteItem) {
					operations.push({
						path: change.path,
						direction: SyncDirection.UPLOAD, // "upload" the deletion
						localState: undefined,
						remoteState: knownState,
					});
				} else {
					// Already gone remotely (or never synced) — just clear tracked state
					this.stateManager.removeFileState(change.path);
				}
				continue;
			}

			if (change.type === LocalChangeType.RENAME && change.oldPath) {
				logger.info(`Processing rename: ${change.oldPath} → ${change.path}`);
				const oldState = this.stateManager.getFileState(change.oldPath);
				handledRemotePaths.add(change.path);
				handledRemotePaths.add(change.oldPath);

				if (oldState) {
					// Always move atomically — Koofr's move API is a single
					// request and is strictly cheaper than delete+re-upload,
					// so there's no reason to fall back to that path.
					operations.push({
						path: change.path,
						direction: SyncDirection.MOVE,
						moveFromPath: this.vaultPathToRemotePath(change.oldPath),
						remoteState: oldState,
					});
				} else {
					// No tracked state for the old path — we don't know its
					// remote location, so there's nothing to move. Just
					// upload the file at its new path.
					logger.warn(
						`Rename: no tracked state for old path ${change.oldPath} — cannot move on Koofr, uploading fresh.`
					);
					operations.push({ path: change.path, direction: SyncDirection.UPLOAD });
				}
				this.stateManager.removeFileState(change.oldPath);
				continue;
			}

			// MODIFY or CREATE
			const remoteItem = remoteFiles.get(change.path);
			handledRemotePaths.add(change.path);

			if (remoteItem) {
				const knownState = this.stateManager.getFileState(change.path);
				const remoteHash = remoteItem.hash || '';

				if (knownState && knownState.remoteHash === remoteHash) {
					// Remote content unchanged since our last sync — just upload, no real conflict
					operations.push({
						path: change.path,
						direction: SyncDirection.UPLOAD,
						localState: knownState,
						remoteState: this.itemToFileState(remoteItem),
					});
				} else if (knownState) {
					// Remote genuinely changed while we also changed locally — real conflict
					const file = this.app.vault.getAbstractFileByPath(change.path);
					const conflictInfo: ConflictInfo = {
						path: change.path,
						localModifiedTime: file instanceof TFile ? file.stat.mtime : Date.now(),
						remoteModifiedTime: remoteItem.modified,
						localSize: file instanceof TFile ? file.stat.size : 0,
						remoteSize: remoteItem.size,
					};
					const resolution = this.conflictResolver.resolveConflict(conflictInfo);
					operations.push({
						path: resolution.newPath || change.path,
						direction: resolution.direction,
						localState: knownState,
						remoteState: this.itemToFileState(remoteItem),
					});
				} else {
					// No known state — local edit wins, upload
					operations.push({
						path: change.path,
						direction: SyncDirection.UPLOAD,
						remoteState: this.itemToFileState(remoteItem),
					});
				}
			} else {
				operations.push({ path: change.path, direction: SyncDirection.UPLOAD });
			}
		}

		// Process remote files not already handled by a local change
		for (const [vaultPath, item] of remoteFiles) {
			if (handledRemotePaths.has(vaultPath)) continue;
			if (this.conflictQueue?.hasConflict(vaultPath)) continue;

			const knownState = this.stateManager.getFileState(vaultPath);
			const remoteHash = item.hash || '';

			if (knownState) {
				if (knownState.remoteHash === remoteHash) {
					continue; // Remote hasn't actually changed — skip
				}
				operations.push({
					path: vaultPath,
					direction: SyncDirection.DOWNLOAD,
					remoteState: this.itemToFileState(item),
				});
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (file instanceof TFile && file.stat.size === (item.size || 0)) {
				// Untracked but present locally with a matching size — assume identical
				this.stateManager.setFileState(vaultPath, this.itemToFileState(item));
				continue;
			}

			operations.push({
				path: vaultPath,
				direction: SyncDirection.DOWNLOAD,
				remoteState: this.itemToFileState(item),
			});
		}

		// Tracked files that vanished from the remote snapshot entirely
		// (no local change already accounts for them) are remote deletes —
		// the snapshot has no explicit "deleted" entries, so this is the
		// only place absence-as-delete gets detected.
		for (const path of this.stateManager.getTrackedPaths()) {
			if (handledRemotePaths.has(path)) continue;
			if (remoteFiles.has(path)) continue;
			if (this.conflictQueue?.hasConflict(path)) continue;
			operations.push({ path, direction: SyncDirection.DOWNLOAD, remoteState: undefined });
		}

		// Local-only files not tracked and not present remotely — upload.
		// Runs every sync (not just first sync): a cheap in-memory vault walk
		// that also catches drift after a crash or a state reset.
		this.addLocalOnlyUploads(operations, remoteFiles, ignoreMatchers);

		return operations;
	}

	/**
	 * Add UPLOAD operations for local files that aren't tracked and don't
	 * exist remotely (new local files, or every file on a first sync).
	 */
	private addLocalOnlyUploads(
		operations: SyncOperation[],
		remoteFiles: Map<string, KoofrFileInfo>,
		ignoreMatchers: RegExp[]
	): void {
		const covered = new Set<string>(operations.map((op) => op.path));
		for (const path of remoteFiles.keys()) covered.add(path);
		for (const path of this.stateManager.getTrackedPaths()) covered.add(path);

		for (const file of this.app.vault.getFiles()) {
			const path = file.path;
			if (covered.has(path)) continue;
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			if (this.conflictQueue?.hasConflict(path)) continue;
			operations.push({ path, direction: SyncDirection.UPLOAD });
			covered.add(path);
		}
	}

	/**
	 * Convert a KoofrFileInfo to FileState
	 */
	private itemToFileState(item: KoofrFileInfo): FileState {
		return {
			path: this.remotePathToVaultPath(item.path),
			localMtime: 0,
			remoteHash: item.hash || '',
			size: item.size || 0,
			remoteModifiedTime: item.modified,
		};
	}

	/**
	 * Execute a sync operation
	 */
	private async executeOperation(operation: SyncOperation): Promise<void> {
		logger.debug(`Executing ${operation.direction} for ${operation.path}`);

		try {
			if (operation.direction === SyncDirection.UPLOAD) {
				if (operation.localState === undefined && operation.remoteState) {
					// This is a delete operation
					await this.fileOps.deleteFile(this.vaultPathToRemotePath(operation.path));
					this.stateManager.removeFileState(operation.path);
					logger.debug(`Deleted remote ${operation.path}`);
				} else {
					await this.uploadFile(operation);
				}
			} else if (operation.direction === SyncDirection.DOWNLOAD) {
				if (operation.remoteState === undefined) {
					await this.deleteLocalFile(operation.path);
				} else {
					await this.downloadFile(operation);
				}
			} else if (operation.direction === SyncDirection.MOVE) {
				if (!operation.moveFromPath) {
					throw new Error('MOVE operation requires moveFromPath');
				}
				const remotePath = this.vaultPathToRemotePath(operation.path);
				logger.info(`Moving item to ${remotePath}`);
				await this.fileOps.moveFile(operation.moveFromPath, remotePath);

				const localFile = this.app.vault.getAbstractFileByPath(operation.path);
				const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
				this.stateManager.setFileState(operation.path, {
					path: operation.path,
					localMtime,
					remoteHash: operation.remoteState?.remoteHash || '',
					size: operation.remoteState?.size || 0,
					remoteModifiedTime: operation.remoteState?.remoteModifiedTime || Date.now(),
				});
				logger.debug(`Moved remote file to ${operation.path}`);
			} else if (operation.direction === SyncDirection.CONFLICT) {
				await this.queueConflict(operation);
			}
		} catch (error) {
			logger.error(`Failed to execute operation for ${operation.path}:`, error);
			throw error;
		}
	}

	/**
	 * Execute sync operations with limited parallelism.
	 */
	private async executeOperations(
		operations: SyncOperation[],
		onComplete: (operation: SyncOperation) => void
	): Promise<void> {
		const parallelCount = Math.min(this.maxConcurrentOperations, operations.length);
		let nextIndex = 0;

		await Promise.all(
			Array.from({ length: parallelCount }, async () => {
				while (nextIndex < operations.length) {
					const operation = operations[nextIndex++];
					await this.executeOperation(operation);
					onComplete(operation);
				}
			})
		);
	}

	/**
	 * Queue a conflict for manual resolution. Snapshots both local and remote content.
	 */
	private async queueConflict(operation: SyncOperation): Promise<void> {
		if (!this.conflictQueue) {
			logger.warn(`No conflict queue available, skipping conflict for ${operation.path}`);
			return;
		}

		if (!operation.remoteState) {
			logger.warn(`No remote state for conflict: ${operation.path}`);
			return;
		}

		let localContent: ArrayBuffer;
		let localMtime: number;
		const file = this.app.vault.getAbstractFileByPath(operation.path);
		if (file instanceof TFile) {
			localContent = await this.app.vault.readBinary(file);
			localMtime = file.stat.mtime;
		} else {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(operation.path))) {
				logger.warn(`Local file not found for conflict: ${operation.path}`);
				return;
			}
			localContent = await adapter.readBinary(operation.path);
			const stat = await adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		const remoteContent = await this.fileOps.downloadFile(
			this.vaultPathToRemotePath(operation.path)
		);

		await this.conflictQueue.add(
			operation.path,
			localContent,
			remoteContent,
			localMtime,
			operation.remoteState.remoteModifiedTime,
			operation.remoteState.remoteHash
		);
	}

	/**
	 * Upload a file to Koofr
	 */
	private async uploadFile(operation: SyncOperation): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(operation.path);
		let content: ArrayBuffer;
		let localMtime: number;

		if (file instanceof TFile) {
			content = await this.app.vault.readBinary(file);
			localMtime = file.stat.mtime;
		} else {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(operation.path))) {
				logger.warn(`File vanished before upload: ${operation.path} — converting to remote delete`);
				const knownState = this.stateManager.getFileState(operation.path);
				if (knownState) {
					try {
						await this.fileOps.deleteFile(this.vaultPathToRemotePath(operation.path));
						logger.debug(`Deleted remote ${operation.path} (vanished locally)`);
					} catch (deleteError) {
						logger.warn(
							`Could not delete remote ${operation.path} after local vanish:`,
							deleteError
						);
					}
				}
				this.stateManager.removeFileState(operation.path);
				return;
			}
			content = await adapter.readBinary(operation.path);
			const stat = await adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		const remotePath = this.vaultPathToRemotePath(operation.path);
		const item = await this.fileOps.uploadFile(remotePath, content, localMtime);

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime,
			remoteHash: item.hash || '',
			size: content.byteLength,
			remoteModifiedTime: item.modified ?? localMtime,
			localContentHash: !(file instanceof TFile) ? hashContent(new Uint8Array(content)) : undefined,
		});

		logger.debug(`Uploaded ${operation.path} successfully`);
	}

	/**
	 * Ensure parent folders exist in the vault for a given file path
	 */
	private async ensureVaultFolders(filePath: string): Promise<void> {
		const parentPath = getParentPath(filePath);
		if (!parentPath) return;

		const pendingCreate = this.pendingVaultFolderCreates.get(parentPath);
		if (pendingCreate) {
			await pendingCreate;
			return;
		}

		const adapter = this.app.vault.adapter;
		const createPromise = (async () => {
			if (await adapter.exists(parentPath)) return;

			try {
				await adapter.mkdir(parentPath);
			} catch (error) {
				if (!(await adapter.exists(parentPath))) {
					throw error;
				}
			}
		})();

		this.pendingVaultFolderCreates.set(parentPath, createPromise);
		try {
			await createPromise;
		} finally {
			this.pendingVaultFolderCreates.delete(parentPath);
		}
	}

	/**
	 * Download a file from Koofr
	 */
	private async downloadFile(operation: SyncOperation): Promise<void> {
		if (!operation.remoteState) {
			logger.warn(`No remote state for ${operation.path}`);
			return;
		}

		const content = await this.fileOps.downloadFile(this.vaultPathToRemotePath(operation.path));

		await this.ensureVaultFolders(operation.path);

		const adapter = this.app.vault.adapter;
		try {
			this.eventManager.markOwnWrites([operation.path]);
			await adapter.writeBinary(operation.path, content);
		} catch {
			await this.ensureVaultFolders(operation.path);
			try {
				await adapter.writeBinary(operation.path, content);
			} catch (retryError) {
				this.eventManager.removeOwnWrite(operation.path);
				throw retryError;
			}
		}

		const file = this.app.vault.getAbstractFileByPath(operation.path);
		let localMtime: number;
		if (file instanceof TFile) {
			localMtime = file.stat.mtime;
		} else {
			const stat = await this.app.vault.adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime,
			remoteHash: operation.remoteState.remoteHash,
			size: content.byteLength,
			remoteModifiedTime: operation.remoteState.remoteModifiedTime,
			localContentHash: !(file instanceof TFile) ? hashContent(new Uint8Array(content)) : undefined,
		});

		logger.debug(`Downloaded ${operation.path} successfully`);
	}

	/**
	 * Delete a local file
	 */
	private async deleteLocalFile(filePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file) {
			this.eventManager.markOwnWrites([filePath]);
			try {
				await this.app.fileManager.trashFile(file);
			} catch (error) {
				this.eventManager.removeOwnWrite(filePath);
				throw error;
			}
			logger.debug(`Deleted local file ${filePath}`);
		} else {
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(filePath)) {
				this.eventManager.markOwnWrites([filePath]);
				try {
					await adapter.remove(filePath);
				} catch (error) {
					this.eventManager.removeOwnWrite(filePath);
					throw error;
				}
				logger.debug(`Deleted local config file ${filePath}`);
			}
		}
		this.stateManager.removeFileState(filePath);
	}

	/**
	 * Delete local folders that the cloud told us were deleted, but only
	 * if they are empty after processing file deletions.
	 */
	private async deleteCloudDeletedFolders(folderPaths: string[]): Promise<void> {
		const candidates = new Set<string>(folderPaths);
		const sorted = Array.from(candidates).sort((a, b) => b.split('/').length - a.split('/').length);

		for (const path of sorted) {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder && folder instanceof TFolder) {
				if (folder.children.length > 0) {
					logger.debug(
						`Skipping cloud-deleted folder ${path} — still has ${folder.children.length} local children`
					);
					continue;
				}
				try {
					await this.app.fileManager.trashFile(folder);
					logger.debug(`Deleted local folder (cloud-deleted): ${path}`);
				} catch (error) {
					logger.warn(`Failed to delete local folder ${path}:`, error);
				}
			} else {
				const adapter = this.app.vault.adapter;
				try {
					if (await adapter.exists(path)) {
						const listing = await adapter.list(path);
						if (listing.files.length > 0 || listing.folders.length > 0) {
							logger.debug(
								`Skipping cloud-deleted config folder ${path} — still has local children`
							);
							continue;
						}
						await adapter.rmdir(path, false);
						logger.debug(`Deleted local config folder (cloud-deleted): ${path}`);
					}
				} catch (error) {
					logger.warn(`Failed to delete local config folder ${path}:`, error);
				}
			}
		}
	}

	/**
	 * Prune remote config folders (.obsidian/) left empty after
	 * local-driven file deletes.
	 */
	private async pruneEmptyRemoteConfigFolders(operations: SyncOperation[]): Promise<void> {
		const configPrefix = `${normalizePath(this.configDir).replace(/\/+$/g, '')}/`;
		const candidateFolders = new Set<string>();
		for (const op of operations) {
			if (op.direction === SyncDirection.UPLOAD && op.localState === undefined && op.remoteState) {
				const parent = getParentPath(op.path);
				if (parent && parent.startsWith(configPrefix)) {
					candidateFolders.add(parent);
				}
			}
		}

		if (candidateFolders.size === 0) return;

		const sorted = Array.from(candidateFolders).sort(
			(a, b) => b.split('/').length - a.split('/').length
		);

		const adapter = this.app.vault.adapter;
		for (const folderPath of sorted) {
			try {
				const stat = await adapter.stat(folderPath);
				if (stat) continue;
			} catch {
				// stat threw — folder is gone
			}

			try {
				await this.fileOps.deleteFile(this.vaultPathToRemotePath(folderPath));
				this.stateManager.removeFolderPath(folderPath);
				logger.info(`Deleted remote config folder (local folder gone): ${folderPath}`);
			} catch (error) {
				logger.warn(`Failed to delete remote config folder ${folderPath}:`, error);
			}
		}
	}

	/**
	 * Process explicit folder create/delete/rename events from the vault.
	 */
	private async processFolderChanges(folderChanges: LocalChange[]): Promise<void> {
		if (folderChanges.length === 0) return;

		const creates = folderChanges
			.filter((c) => c.type === LocalChangeType.FOLDER_CREATE)
			.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
		const deletes = folderChanges
			.filter((c) => c.type === LocalChangeType.FOLDER_DELETE)
			.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
		const renames = folderChanges.filter(
			(c) => c.type === LocalChangeType.FOLDER_RENAME && c.oldPath
		);

		for (const change of renames) {
			const oldPath = change.oldPath!;
			const oldRemote = this.vaultPathToRemotePath(oldPath);
			const newRemote = this.vaultPathToRemotePath(change.path);
			try {
				try {
					await this.fileOps.moveFile(oldRemote, newRemote);
				} catch (moveError) {
					if (!this.stateManager.hasFolderPath(oldPath)) {
						// Not tracked remotely — the move may have 404'd. Fall back to create.
						await this.fileOps.createFolder(newRemote);
					} else {
						throw moveError;
					}
				}
				this.stateManager.removeFolderPath(oldPath);
				this.stateManager.addFolderPath(change.path);
				this.updateChildPathsAfterFolderRename(oldPath, change.path);
				logger.info(`Renamed remote folder: ${oldPath} → ${change.path}`);
			} catch (error) {
				logger.error(`Failed to rename remote folder ${oldPath} → ${change.path}:`, error);
			}
		}

		for (const change of creates) {
			try {
				await this.fileOps.createFolder(this.vaultPathToRemotePath(change.path));
				this.stateManager.addFolderPath(change.path);
				logger.info(`Created remote folder: ${change.path}`);
			} catch (error) {
				logger.warn(`Failed to create remote folder ${change.path}:`, error);
			}
		}

		for (const change of deletes) {
			try {
				await this.fileOps.deleteFile(this.vaultPathToRemotePath(change.path));
				this.stateManager.removeFolderPath(change.path);
				logger.info(`Deleted remote folder: ${change.path}`);
			} catch (error) {
				logger.debug(
					`Could not delete remote folder ${change.path}: ${error instanceof Error ? error.message : error}`
				);
			}
		}
	}

	/**
	 * After renaming a folder on Koofr, update all tracked file/folder
	 * states that were under the old folder path to use the new path.
	 */
	private updateChildPathsAfterFolderRename(oldFolderPath: string, newFolderPath: string): void {
		const oldPrefix = oldFolderPath.endsWith('/') ? oldFolderPath : `${oldFolderPath}/`;
		const newPrefix = newFolderPath.endsWith('/') ? newFolderPath : `${newFolderPath}/`;

		const childFiles = this.stateManager.getFileStatesUnderFolder(oldFolderPath);
		for (const { path, state } of childFiles) {
			const newPath = newPrefix + path.slice(oldPrefix.length);
			this.stateManager.removeFileState(path);
			this.stateManager.setFileState(newPath, { ...state, path: newPath });
			logger.debug(`Updated file state path: ${path} → ${newPath}`);
		}

		const childFolders = this.stateManager
			.getAllFolderPaths()
			.filter((p) => p.startsWith(oldPrefix));
		for (const oldChildPath of childFolders) {
			const newChildPath = newPrefix + oldChildPath.slice(oldPrefix.length);
			this.stateManager.removeFolderPath(oldChildPath);
			this.stateManager.addFolderPath(newChildPath);
			logger.debug(`Updated folder state path: ${oldChildPath} → ${newChildPath}`);
		}
	}

	/**
	 * Convert vault path to a Koofr path (absolute, prefixed by remoteRoot).
	 */
	private vaultPathToRemotePath(vaultPath: string): string {
		return toRemotePath(vaultPath, this.remoteRoot);
	}

	/**
	 * Convert a Koofr path back to a vault-relative path.
	 */
	private remotePathToVaultPath(remotePath: string): string {
		return toVaultPath(remotePath, this.remoteRoot);
	}

	/**
	 * Compute the remote-path form of every folder known to exist right
	 * now (the configured sync root itself, plus everything the fresh
	 * snapshot reported) for FileOperations.seedKnownFolders. The sync
	 * root needs including explicitly since getTree() excludes the root
	 * node it was queried with — top-level uploads would otherwise
	 * needlessly try to (re)create a folder the user already selected.
	 */
	private knownRemoteFolderPaths(remoteFolderVaultPaths: Set<string>): string[] {
		const paths = Array.from(remoteFolderVaultPaths, (p) => this.vaultPathToRemotePath(p));
		if (this.remoteRoot) {
			const normalized = normalizePath(this.remoteRoot);
			paths.push(normalized.startsWith('/') ? normalized : `/${normalized}`);
		}
		return paths;
	}

	private async loadIgnoreMatchers(): Promise<RegExp[]> {
		const patterns = [...SyncEngine.DEFAULT_IGNORE_PATTERNS];

		try {
			const content = await this.app.vault.adapter.read('.syncIgnore');
			if (typeof content === 'string' && content.trim().length > 0) {
				patterns.push(...this.parseSyncIgnorePatterns(content));
			}
		} catch {
			// Ignore missing or unreadable .syncIgnore files
		}

		return patterns.map((pattern) => this.patternToRegex(pattern));
	}

	private parseSyncIgnorePatterns(content: string): string[] {
		return content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
			.map((line) => line.replace(/^\.\//, '').replace(/^\/+/, ''));
	}

	private patternToRegex(pattern: string): RegExp {
		let normalizedPattern = normalizePath(pattern);
		if (normalizedPattern.endsWith('/')) {
			normalizedPattern = `${normalizedPattern}**`;
		}

		const wildcardToken = '__DOUBLE_STAR__';
		const hasPathSeparator = normalizedPattern.includes('/');
		let regexPattern = normalizedPattern.replace(/\*\*/g, wildcardToken);
		regexPattern = regexPattern.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
		regexPattern = regexPattern.replace(/\*/g, '[^/]*');
		regexPattern = regexPattern.replace(new RegExp(wildcardToken, 'g'), '.*');

		if (hasPathSeparator) {
			return new RegExp(`^${regexPattern}$`);
		}

		return new RegExp(`(^|/)${regexPattern}$`);
	}

	private shouldIgnorePath(path: string, ignoreMatchers: RegExp[]): boolean {
		if (!path) return false;
		const normalizedPath = normalizePath(path).replace(/^\/+/, '');
		return ignoreMatchers.some((matcher) => matcher.test(normalizedPath));
	}

	/**
	 * Reconcile the local vault from a full cloud listing. Treats cloud as
	 * authoritative: any local file not present in cloud is deleted; any
	 * cloud file not present locally is downloaded; size mismatches are
	 * downloaded too. Skips conflict detection entirely — cloud always wins.
	 *
	 * Destructive deletes are gated by the same large-delete confirmation
	 * modal used by normal sync.
	 */
	async reconcileFromCloud(): Promise<void> {
		logger.info('Starting reconcile-from-cloud operation');
		const progress = (msg: string | undefined) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress(t('progress.listingCloud'));
			new Notice(t('notices.reconcile.listing'), 6000);
			const ignoreMatchers = await this.loadIgnoreMatchers();

			const allRemoteItems = await this.fileOps.listAllItems(this.remoteRoot);
			logger.info(`Reconcile: enumerated ${allRemoteItems.length} remote items`);

			const remoteFiles = new Map<string, KoofrFileInfo>();
			const remoteFolderVaultPaths = new Set<string>();
			for (const item of allRemoteItems) {
				const vaultPath = this.remotePathToVaultPath(item.path);
				if (!vaultPath) continue;
				if (!this.shouldSyncPath(vaultPath)) continue;
				if (this.shouldIgnorePath(vaultPath, ignoreMatchers)) continue;
				if (item.type === 'dir') {
					remoteFolderVaultPaths.add(vaultPath);
				} else {
					remoteFiles.set(vaultPath, item);
				}
			}

			const localFiles = this.app.vault
				.getFiles()
				.filter((f) => this.shouldSyncPath(f.path))
				.filter((f) => !this.shouldIgnorePath(f.path, ignoreMatchers));
			const localByPath = new Map<string, { path: string; size: number }>(
				localFiles.map((f) => [f.path, { path: f.path, size: f.stat.size }])
			);

			const adapter = this.app.vault.adapter;
			const configPaths = await getAllSyncableConfigPaths(this.configDir, adapter, (path) =>
				this.shouldSyncPath(path)
			);
			for (const path of configPaths) {
				if (localByPath.has(path)) continue;
				if (!this.shouldSyncPath(path)) continue;
				if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
				try {
					const stat = await adapter.stat(path);
					if (stat && stat.type === 'file') {
						localByPath.set(path, { path, size: stat.size });
					}
				} catch {
					// file doesn't exist, skip
				}
			}

			this.stateManager.clearFileStates();

			const operations: SyncOperation[] = [];
			const localOnly: string[] = [];
			const remoteOnly: string[] = [];
			const sizeMismatch: string[] = [];

			for (const [path] of localByPath) {
				if (!remoteFiles.has(path)) {
					localOnly.push(path);
					operations.push({ path, direction: SyncDirection.DOWNLOAD, remoteState: undefined });
				}
			}

			for (const [path, item] of remoteFiles) {
				const local = localByPath.get(path);
				if (!local) {
					remoteOnly.push(path);
					operations.push({
						path,
						direction: SyncDirection.DOWNLOAD,
						remoteState: this.itemToFileState(item),
					});
				} else {
					const remoteSize = item.size || 0;
					if (local.size !== remoteSize) {
						sizeMismatch.push(path);
						operations.push({
							path,
							direction: SyncDirection.DOWNLOAD,
							remoteState: this.itemToFileState(item),
						});
					} else {
						this.stateManager.setFileState(path, this.itemToFileState(item));
					}
				}
			}

			logger.info(
				`Reconcile plan: ${operations.length} operations (localOnly=${localOnly.length} deletes, remoteOnly=${remoteOnly.length} downloads, sizeMismatch=${sizeMismatch.length} re-downloads)`
			);

			const threshold = this.getLargeDeleteThreshold();
			if (threshold > 0 && localOnly.length >= threshold && this.largeDeleteWarningHandler) {
				logger.warn(
					`Reconcile would delete ${localOnly.length} local files (threshold ${threshold}). Asking user.`
				);
				const decision = await this.largeDeleteWarningHandler({
					localDeleteCount: localOnly.length,
					remoteDeleteCount: 0,
					threshold,
					sampleLocalDeletes: localOnly.slice(0, 10),
					sampleRemoteDeletes: [],
				});
				if (decision !== 'proceed') {
					logger.info(`Reconcile cancelled by user (${operations.length} ops aborted)`);
					new Notice(t('notices.reconcile.cancelled'));
					return;
				}
			}

			// Refresh the tracked folder-path set from this authoritative listing
			for (const p of this.stateManager.getAllFolderPaths()) {
				if (!remoteFolderVaultPaths.has(p)) this.stateManager.removeFolderPath(p);
			}
			for (const p of remoteFolderVaultPaths) {
				this.stateManager.addFolderPath(p);
			}

			if (operations.length === 0) {
				logger.info('Reconcile: nothing to do — local already matches cloud');
				new Notice(t('notices.reconcile.alreadyInSync'));
				this.stateManager.setLastSyncTime(Date.now());
				return;
			}

			let completed = 0;
			progress(t('progress.files', { completed: 0, total: operations.length }));
			const progressNotice = new ProgressNotice(t('progress.reconciling'), operations.length);
			await this.executeOperations(operations, () => {
				completed++;
				const label = t('progress.files', { completed, total: operations.length });
				progress(label);
				progressNotice.update(completed, t('progress.reconciling'));
			});
			progressNotice.hide();
			progress(undefined);

			this.eventManager.clearDirtyFiles();
			this.stateManager.setLastSyncTime(Date.now());

			logger.info(`Reconcile from cloud complete: ${operations.length} operations executed`);
			new Notice(
				t('notices.reconcile.complete', {
					downloaded: remoteOnly.length,
					deleted: localOnly.length,
					refreshed: sizeMismatch.length,
				})
			);
		} catch (error) {
			logger.error('Reconcile from cloud failed:', error);
			new Notice(t('notices.reconcile.failed', { message: String(error) }));
			throw error;
		}
	}
}
