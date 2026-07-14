/**
 * Koofr Client - REST API v2 wrapper for Koofr cloud storage operations
 *
 * This module provides a clean interface to Koofr's REST API. It handles
 * authentication (via KoofrAuthProvider), retries, and the request/response
 * shapes documented at https://app.koofr.net/developers/api.
 *
 * ## Key differences from a delta-based provider (e.g. OneDrive/Graph)
 *
 * Koofr has no incremental change API. `getTree()` fetches the entire
 * recursive subtree in a single request and flattens it into a plain
 * `KoofrFileInfo[]` — this flat, ID-less, path-addressed shape is what the
 * rest of the plugin (FileOperations, SyncEngine) is built around, so a
 * future second backend only needs to produce the same shape, not touch
 * the sync engine.
 *
 * ## Path handling
 *
 * Koofr paths are plain query-string values — no colon-escaping scheme like
 * Microsoft Graph. `URLSearchParams` handles all necessary encoding.
 *
 * ## Auth
 *
 * Every request carries `Authorization: Token token=<token>`. Koofr has no
 * refresh-token flow, so a 401 triggers a transparent re-authentication
 * from stored credentials (see `KoofrAuthProvider`) and a single retry.
 */

import { requestUrl } from 'obsidian';
import { KoofrAuthProvider } from '../auth/koofrAuthProvider';
import { KoofrFileInfo, KoofrTreeNode, KoofrMount, KoofrError } from '../types';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { parseHttpError } from '../utils/errors';
import { normalizePath, getParentPath, getFileName } from '../utils/pathUtils';
import { KOOFR_API_V2, KOOFR_CONTENT_API_V2 } from '../constants';

interface KoofrHttpResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

interface FilesListResponse {
	files?: KoofrFileInfo[];
	Files?: KoofrFileInfo[];
}

interface MountsResponse {
	mounts?: KoofrMount[];
	Mounts?: KoofrMount[];
}

/**
 * Koofr client for interacting with the REST API v2
 */
export class KoofrClient {
	private authProvider: KoofrAuthProvider;
	private mountId?: string;

	constructor(authProvider: KoofrAuthProvider, mountId?: string) {
		this.authProvider = authProvider;
		this.mountId = mountId;
	}

	setMountId(mountId: string): void {
		this.mountId = mountId;
	}

	getMountId(): string | undefined {
		return this.mountId;
	}

	private requireMountId(): string {
		if (!this.mountId) {
			throw new KoofrError('No Koofr mount selected');
		}
		return this.mountId;
	}

	/** Ensure a leading slash and no trailing slash (except root "/"). */
	private normalizeRemotePath(path: string): string {
		const normalized = normalizePath(path);
		const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
		if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
			return withLeadingSlash.slice(0, -1);
		}
		return withLeadingSlash || '/';
	}

	private buildUrl(base: string, params: Record<string, string>): string {
		const qs = new URLSearchParams(params).toString();
		return qs ? `${base}?${qs}` : base;
	}

	/**
	 * Perform an authenticated request. On a 401, re-authenticates from
	 * stored credentials and retries once before giving up.
	 */
	private async request(
		url: string,
		options: { method: string; headers?: Record<string, string>; body?: string | ArrayBuffer }
	): Promise<KoofrHttpResponse> {
		return retryWithBackoff(async () => {
			const attempt = async (): Promise<KoofrHttpResponse> => {
				const authHeader = await this.authProvider.getAuthHeader();
				const response = (await requestUrl({
					url,
					method: options.method,
					headers: { Authorization: authHeader, ...(options.headers || {}) },
					body: options.body,
					throw: false,
				})) as unknown as KoofrHttpResponse;
				return response;
			};

			let response = await attempt();

			if (response.status === 401) {
				logger.debug('Koofr request unauthorized — re-authenticating and retrying once');
				await this.authProvider.reauthenticate();
				response = await attempt();
			}

			if (response.status < 200 || response.status >= 300) {
				throw parseHttpError(response.status, response.text);
			}

			return response;
		});
	}

	private isNotFoundError(error: unknown): boolean {
		if (error instanceof KoofrError) {
			return error.statusCode === 404;
		}
		return false;
	}

	// ------------------------------------------------------------------
	// Mounts
	// ------------------------------------------------------------------

	async listMounts(): Promise<KoofrMount[]> {
		logger.debug('Listing Koofr mounts');
		try {
			const response = await this.request(`${KOOFR_API_V2}/mounts`, { method: 'GET' });
			const data = response.json as MountsResponse;
			return data.mounts || data.Mounts || [];
		} catch (error) {
			logger.error('Failed to list mounts:', error);
			throw new KoofrError(
				`Failed to list mounts: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	// ------------------------------------------------------------------
	// File / folder info
	// ------------------------------------------------------------------

	async getItemInfo(path: string): Promise<KoofrFileInfo> {
		const mountId = this.requireMountId();
		const remotePath = this.normalizeRemotePath(path);
		logger.debug('Getting item info:', remotePath);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/info`, {
				path: remotePath,
			});
			const response = await this.request(url, { method: 'GET' });
			return response.json as KoofrFileInfo;
		} catch (error) {
			logger.error(`Failed to get item info at ${remotePath}:`, error);
			throw error instanceof KoofrError
				? error
				: new KoofrError(
						`Failed to get item info: ${error instanceof Error ? error.message : 'Unknown error'}`
					);
		}
	}

	async itemExists(path: string): Promise<boolean> {
		try {
			await this.getItemInfo(path);
			return true;
		} catch (error) {
			if (this.isNotFoundError(error)) return false;
			throw error;
		}
	}

	/**
	 * List one level of a folder (used by the folder-browser picker, which
	 * may browse a different mount than the one currently configured for
	 * sync — hence the optional override instead of always using `this.mountId`).
	 * Koofr's files/list doesn't reliably return the `path` field per item,
	 * so it's backfilled here — mirrors go-koofrclient's own FilesList.
	 */
	async listFolder(path: string, mountIdOverride?: string): Promise<KoofrFileInfo[]> {
		const mountId = mountIdOverride || this.requireMountId();
		const remotePath = this.normalizeRemotePath(path);
		logger.debug('Listing folder:', remotePath);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/list`, {
				path: remotePath,
			});
			const response = await this.request(url, { method: 'GET' });
			const data = response.json as FilesListResponse;
			const items = data.files || data.Files || [];
			return items.map((item) => ({
				...item,
				path: item.path || (remotePath === '/' ? `/${item.name}` : `${remotePath}/${item.name}`),
			}));
		} catch (error) {
			if (this.isNotFoundError(error)) return [];
			logger.error(`Failed to list folder ${remotePath}:`, error);
			throw new KoofrError(
				`Failed to list folder: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Fetch the entire recursive subtree under `rootPath` in a single
	 * request and flatten it into a plain list — this is the remote
	 * snapshot the sync engine diffs against on every sync (Koofr has no
	 * incremental delta API). Returns an empty list if the root doesn't
	 * exist remotely yet (first sync — it will be created on upload).
	 */
	async getTree(rootPath: string): Promise<KoofrFileInfo[]> {
		const mountId = this.requireMountId();
		const remotePath = this.normalizeRemotePath(rootPath);
		logger.debug('Fetching remote tree:', remotePath);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/tree`, {
				path: remotePath,
			});
			const response = await this.request(url, { method: 'GET' });
			const tree = response.json as KoofrTreeNode;
			return this.flattenTree(tree, remotePath);
		} catch (error) {
			if (this.isNotFoundError(error)) {
				logger.info(`Remote sync root '${remotePath}' not found — treating as empty`);
				return [];
			}
			logger.error(`Failed to fetch tree at ${remotePath}:`, error);
			throw new KoofrError(
				`Failed to fetch remote tree: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Flatten a nested KoofrTreeNode into a list of KoofrFileInfo with
	 * correctly reconstructed full paths. Mirrors go-koofrclient's
	 * FileTree.Flatten() — child nodes don't reliably carry a full `path`,
	 * only a leaf `name`, so paths are rebuilt by walking the tree.
	 * The root node itself is excluded — callers only want descendants.
	 */
	private flattenTree(root: KoofrTreeNode, basePath: string): KoofrFileInfo[] {
		const results: KoofrFileInfo[] = [];

		const walk = (node: KoofrTreeNode, path: string, isRoot: boolean): void => {
			if (!isRoot) {
				results.push({
					name: node.name,
					type: node.type,
					modified: node.modified,
					size: node.size,
					contentType: node.contentType,
					path,
					hash: node.hash,
				});
			}
			for (const child of node.children || []) {
				const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
				walk(child, childPath, false);
			}
		};

		walk(root, basePath, true);
		return results;
	}

	// ------------------------------------------------------------------
	// File operations
	// ------------------------------------------------------------------

	async downloadFile(path: string): Promise<ArrayBuffer> {
		const mountId = this.requireMountId();
		const remotePath = this.normalizeRemotePath(path);
		logger.debug('Downloading file:', remotePath);

		try {
			const url = this.buildUrl(`${KOOFR_CONTENT_API_V2}/mounts/${mountId}/files/get`, {
				path: remotePath,
			});
			const response = await this.request(url, { method: 'GET' });
			return response.arrayBuffer;
		} catch (error) {
			logger.error(`Failed to download file ${remotePath}:`, error);
			throw new KoofrError(
				`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Upload a file. Koofr's `files/put` takes the whole file in a single
	 * multipart POST — no chunked/resumable upload API is documented, so
	 * (unlike OneDrive) there's no size-based branch here.
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer,
		modifiedMs?: number
	): Promise<KoofrFileInfo> {
		const mountId = this.requireMountId();
		const normalized = this.normalizeRemotePath(remotePath);
		const parentPath = getParentPath(normalized) || '/';
		const filename = getFileName(normalized);
		logger.debug(`Uploading file: ${normalized} (${content.byteLength} bytes)`);

		const boundary = `----KoofrSyncBoundary${Math.random().toString(16).slice(2)}`;
		const body = buildMultipartBody(content, boundary);

		const params: Record<string, string> = {
			path: parentPath,
			filename,
			info: 'true',
			overwrite: 'true',
		};
		if (modifiedMs !== undefined) {
			params.modified = String(Math.round(modifiedMs));
		}

		try {
			const url = this.buildUrl(`${KOOFR_CONTENT_API_V2}/mounts/${mountId}/files/put`, params);
			const response = await this.request(url, {
				method: 'POST',
				headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
				body,
			});
			const info = response.json as KoofrFileInfo;
			// Trust the parent path + filename we sent over the response's own
			// path field, which isn't reliably populated by the API.
			return { ...info, path: normalized };
		} catch (error) {
			logger.error(`Failed to upload file ${normalized}:`, error);
			throw new KoofrError(
				`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	async createFolder(remotePath: string, mountIdOverride?: string): Promise<void> {
		const mountId = mountIdOverride || this.requireMountId();
		const normalized = this.normalizeRemotePath(remotePath);
		const parentPath = getParentPath(normalized) || '/';
		const name = getFileName(normalized);
		logger.debug('Creating folder:', normalized);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/folder`, {
				path: parentPath,
			});
			await this.request(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name }),
			});
		} catch (error) {
			// Ignore if folder already exists
			if (error instanceof Error && /already exists|conflict/i.test(error.message)) {
				logger.debug(`Folder ${normalized} already exists`);
				return;
			}
			logger.error(`Failed to create folder ${normalized}:`, error);
			throw new KoofrError(
				`Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	async deleteItem(path: string): Promise<void> {
		const mountId = this.requireMountId();
		const remotePath = this.normalizeRemotePath(path);
		logger.debug('Deleting item:', remotePath);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/remove`, {
				path: remotePath,
			});
			await this.request(url, { method: 'DELETE' });
		} catch (error) {
			if (this.isNotFoundError(error)) {
				logger.debug(`Item ${remotePath} already deleted (404) — treating as success`);
				return;
			}
			logger.error(`Failed to delete item ${remotePath}:`, error);
			throw new KoofrError(
				`Failed to delete item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Move/rename an item using Koofr's atomic move API — addressed by path
	 * (Koofr has no stable object ID), avoiding a delete+re-upload round trip.
	 */
	async moveItem(fromPath: string, toPath: string): Promise<void> {
		const mountId = this.requireMountId();
		const normalizedFrom = this.normalizeRemotePath(fromPath);
		const normalizedTo = this.normalizeRemotePath(toPath);
		logger.debug(`Moving item ${normalizedFrom} → ${normalizedTo}`);

		try {
			const url = this.buildUrl(`${KOOFR_API_V2}/mounts/${mountId}/files/move`, {
				path: normalizedFrom,
			});
			await this.request(url, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ toMountId: mountId, toPath: normalizedTo }),
			});
			logger.info(`Moved item ${normalizedFrom} → ${normalizedTo}`);
		} catch (error) {
			logger.error(`Failed to move item ${normalizedFrom} → ${normalizedTo}:`, error);
			throw new KoofrError(
				`Failed to move item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}
}

/**
 * Build a single-field multipart/form-data body containing the file bytes.
 * The real target filename is passed separately via the `filename` query
 * param (matching Koofr's own API contract), so the Content-Disposition
 * filename here is just a placeholder.
 */
function buildMultipartBody(content: ArrayBuffer, boundary: string): ArrayBuffer {
	const encoder = new TextEncoder();
	const preamble = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="file"\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`
	);
	const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

	const body = new Uint8Array(preamble.byteLength + content.byteLength + epilogue.byteLength);
	body.set(preamble, 0);
	body.set(new Uint8Array(content), preamble.byteLength);
	body.set(epilogue, preamble.byteLength + content.byteLength);
	return body.buffer;
}
