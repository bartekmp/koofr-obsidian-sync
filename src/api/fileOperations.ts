/**
 * High-level file operations for Koofr
 */

import { KoofrClient } from './koofrClient';
import { KoofrFileInfo } from '../types';
import { logger } from '../utils/logger';
import { getParentPath } from '../utils/pathUtils';

/**
 * File operations manager
 */
export class FileOperations {
	private client: KoofrClient;
	private pendingFolderEnsures = new Map<string, Promise<void>>();
	// Remote folder paths already known to exist — seeded once per sync from
	// the sync engine's fresh remote snapshot (see seedKnownFolders) and
	// grown as folders get created. Koofr has no incremental change API, so
	// that snapshot is already fetched every sync; checking against it here
	// is free, unlike a live existence request per upload.
	private knownFolders = new Set<string>();

	constructor(client: KoofrClient) {
		this.client = client;
	}

	/**
	 * Set the Koofr client (used after reconnection)
	 */
	setClient(client: KoofrClient): void {
		this.client = client;
	}

	/**
	 * Seed the set of remote folder paths already known to exist, so
	 * upload/move calls this sync skip the create-folder round trip for
	 * anything the caller already knows is there.
	 */
	seedKnownFolders(remotePaths: Iterable<string>): void {
		for (const path of remotePaths) {
			this.knownFolders.add(path);
		}
	}

	/**
	 * Upload a file to Koofr
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer,
		modifiedMs?: number
	): Promise<KoofrFileInfo> {
		logger.debug('Uploading file:', remotePath);

		await this.ensureParentFolder(remotePath);

		return this.client.uploadFile(remotePath, content, modifiedMs);
	}

	/**
	 * Download a file from Koofr
	 */
	async downloadFile(remotePath: string): Promise<ArrayBuffer> {
		logger.debug('Downloading file:', remotePath);
		return this.client.downloadFile(remotePath);
	}

	/**
	 * Delete a file from Koofr
	 */
	async deleteFile(remotePath: string): Promise<void> {
		logger.debug('Deleting file:', remotePath);
		await this.client.deleteItem(remotePath);
	}

	/**
	 * Move/rename a file on Koofr using the atomic move API.
	 * More efficient than delete+upload (no re-upload) and avoids duplicate files.
	 */
	async moveFile(fromPath: string, toPath: string): Promise<void> {
		logger.debug('Moving file:', fromPath, 'to', toPath);
		await this.ensureParentFolder(toPath);
		await this.client.moveItem(fromPath, toPath);
	}

	/**
	 * List all files recursively under a root path (excludes folders)
	 */
	async listAllFiles(rootPath: string = ''): Promise<KoofrFileInfo[]> {
		logger.debug('Listing all files in:', rootPath);
		const allItems = await this.client.getTree(rootPath);
		return allItems.filter((item) => item.type === 'file');
	}

	/**
	 * List everything (files + folders) recursively under a root path
	 */
	async listAllItems(rootPath: string = ''): Promise<KoofrFileInfo[]> {
		return this.client.getTree(rootPath);
	}

	/**
	 * Check if file exists
	 */
	async fileExists(remotePath: string): Promise<boolean> {
		return this.client.itemExists(remotePath);
	}

	/**
	 * Ensure parent folders exist (create if needed)
	 */
	private async ensureParentFolder(remotePath: string): Promise<void> {
		const parentPath = getParentPath(remotePath);
		if (!parentPath || parentPath === '/') {
			return;
		}

		const segments = parentPath.split('/').filter((s) => s.length > 0);
		let currentPath = '';

		for (const segment of segments) {
			const nextPath = currentPath ? `${currentPath}/${segment}` : `/${segment}`;
			await this.ensureFolderExists(nextPath);
			currentPath = nextPath;
		}
	}

	/**
	 * Ensure a single remote folder exists, sharing in-flight checks/creates
	 * across parallel uploads. Skips the network entirely when the folder
	 * is already in knownFolders (the common case — most folders a sync
	 * touches already existed in the snapshot fetched at the start of it).
	 * Otherwise attempts to create it directly; koofrClient.createFolder
	 * already treats "already exists" as success, so no separate existence
	 * check is needed before creating.
	 */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		if (this.knownFolders.has(folderPath)) {
			return;
		}

		const pendingEnsure = this.pendingFolderEnsures.get(folderPath);
		if (pendingEnsure) {
			await pendingEnsure;
			return;
		}

		const ensurePromise = (async () => {
			try {
				await this.client.createFolder(folderPath);
			} catch (error) {
				// Defensive fallback in case createFolder threw for a reason
				// its "already exists" message match didn't catch.
				if (!(await this.client.itemExists(folderPath))) {
					throw error;
				}
			}
			this.knownFolders.add(folderPath);
		})();

		this.pendingFolderEnsures.set(folderPath, ensurePromise);
		try {
			await ensurePromise;
		} finally {
			this.pendingFolderEnsures.delete(folderPath);
		}
	}

	/**
	 * Create a folder on Koofr (including any missing ancestors).
	 */
	async createFolder(remotePath: string): Promise<void> {
		logger.debug('Creating folder:', remotePath);
		const segments = remotePath.split('/').filter((s) => s.length > 0);
		let currentPath = '';

		for (const segment of segments) {
			const nextPath = currentPath ? `${currentPath}/${segment}` : `/${segment}`;
			await this.ensureFolderExists(nextPath);
			currentPath = nextPath;
		}
	}

	/**
	 * Get file metadata
	 */
	async getFileMetadata(remotePath: string): Promise<KoofrFileInfo> {
		return this.client.getItemInfo(remotePath);
	}
}
