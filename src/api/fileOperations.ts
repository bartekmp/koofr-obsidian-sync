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
	private skipFolderChecks: () => boolean;

	constructor(client: KoofrClient, skipFolderChecks: () => boolean = () => false) {
		this.client = client;
		this.skipFolderChecks = skipFolderChecks;
	}

	/**
	 * Set the Koofr client (used after reconnection)
	 */
	setClient(client: KoofrClient): void {
		this.client = client;
	}

	/**
	 * Upload a file to Koofr
	 */
	async uploadFile(remotePath: string, content: ArrayBuffer, modifiedMs?: number): Promise<KoofrFileInfo> {
		logger.debug('Uploading file:', remotePath);

		if (!this.skipFolderChecks()) {
			await this.ensureParentFolder(remotePath);
		}

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
		if (!this.skipFolderChecks()) {
			await this.ensureParentFolder(toPath);
		}
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
	 * Ensure a single remote folder exists, sharing in-flight checks/creates across parallel uploads.
	 */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		const pendingEnsure = this.pendingFolderEnsures.get(folderPath);
		if (pendingEnsure) {
			await pendingEnsure;
			return;
		}

		const ensurePromise = (async () => {
			const exists = await this.client.itemExists(folderPath);
			if (exists) {
				return;
			}

			try {
				await this.client.createFolder(folderPath);
			} catch (error) {
				if (!(await this.client.itemExists(folderPath))) {
					throw error;
				}
			}
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
