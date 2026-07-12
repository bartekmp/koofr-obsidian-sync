/**
 * Sync state tracking and persistence
 *
 * Unlike a delta-cursor-based provider, there's no cursor to persist here —
 * every sync fetches a fresh remote snapshot (see SyncEngine) and diffs it
 * against the tracked FileState map by content hash. What's tracked:
 *   - fileStates: last-known synced state per vault path (for diffing)
 *   - folderPaths: known remote folder paths (a folder's absence from the
 *     next snapshot means it was deleted — no ID reverse-lookup needed,
 *     unlike OneDrive's bare-ID delta deletes)
 */

import { SyncState, FileState } from '../types';
import { logger } from '../utils/logger';

/**
 * Manages sync state (last sync time, file states, known folder paths)
 */
export class SyncStateManager {
	private state: SyncState;

	constructor() {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderPaths: new Set(),
		};
	}

	/**
	 * Load state from persisted data
	 */
	loadState(data?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderPaths?: string[];
	}): void {
		if (!data) {
			this.state = {
				lastSyncTime: 0,
				fileStates: new Map(),
				folderPaths: new Set(),
			};
			return;
		}

		this.state = {
			lastSyncTime: data.lastSyncTime,
			fileStates: new Map(data.fileStates),
			folderPaths: new Set(data.folderPaths || []),
		};

		logger.debug('Sync state loaded', {
			lastSyncTime: new Date(data.lastSyncTime).toISOString(),
			fileCount: this.state.fileStates.size,
			folderCount: this.state.folderPaths.size,
		});
	}

	/**
	 * Prepare state for persistence
	 */
	prepareForSave(): {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderPaths: string[];
	} {
		return {
			lastSyncTime: this.state.lastSyncTime,
			fileStates: Array.from(this.state.fileStates.entries()),
			folderPaths: Array.from(this.state.folderPaths),
		};
	}

	/**
	 * Get last sync time
	 */
	getLastSyncTime(): number {
		return this.state.lastSyncTime;
	}

	/**
	 * Update last sync time
	 */
	setLastSyncTime(time: number): void {
		this.state.lastSyncTime = time;
		logger.debug('Last sync time updated:', new Date(time).toISOString());
	}

	/**
	 * Get file state
	 */
	getFileState(path: string): FileState | undefined {
		return this.state.fileStates.get(path);
	}

	/**
	 * Set file state
	 */
	setFileState(path: string, state: FileState): void {
		this.state.fileStates.set(path, state);
	}

	/**
	 * Remove file state
	 */
	removeFileState(path: string): void {
		this.state.fileStates.delete(path);
	}

	/**
	 * Get all file paths tracked
	 */
	getTrackedPaths(): string[] {
		return Array.from(this.state.fileStates.keys());
	}

	/**
	 * Record a known remote folder path.
	 */
	addFolderPath(path: string): void {
		this.state.folderPaths.add(path);
	}

	/**
	 * Check whether a folder path is known to exist remotely.
	 */
	hasFolderPath(path: string): boolean {
		return this.state.folderPaths.has(path);
	}

	removeFolderPath(path: string): void {
		this.state.folderPaths.delete(path);
	}

	getAllFolderPaths(): string[] {
		return Array.from(this.state.folderPaths);
	}

	/**
	 * Return tracked file states whose path lives under the given folder path.
	 * Matches direct children and any deeper descendants. Used to update
	 * child paths after a folder rename.
	 */
	getFileStatesUnderFolder(folderPath: string): Array<{ path: string; state: FileState }> {
		const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
		const results: Array<{ path: string; state: FileState }> = [];
		for (const [path, state] of this.state.fileStates) {
			if (path.startsWith(prefix)) results.push({ path, state });
		}
		return results;
	}

	/**
	 * Check if this is the first sync (no state yet)
	 */
	isFirstSync(): boolean {
		return this.state.lastSyncTime === 0;
	}

	/**
	 * Reset for a full re-scan. Clears fileStates, folderPaths and
	 * lastSyncTime so the next sync re-diffs everything from a fresh
	 * remote snapshot against empty local state.
	 */
	clearState(): void {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderPaths: new Set(),
		};
		logger.debug('Sync state cleared');
	}

	/** Wipe all tracked file states but keep folder paths and last sync time. */
	clearFileStates(): void {
		this.state.fileStates.clear();
		logger.debug('Tracked file states cleared');
	}
}
