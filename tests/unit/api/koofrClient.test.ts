/**
 * Unit tests for KoofrClient — the REST API v2 wrapper.
 * No reference implementation to port from (Koofr's API shape is entirely
 * different from OneDrive/Graph), so these are written from scratch against
 * the endpoints documented in constants.ts and the go-koofrclient SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KoofrClient } from '../../../src/api/koofrClient';
import { KoofrAuthProvider } from '../../../src/auth/koofrAuthProvider';
import { mockRequestUrl } from '../../setup';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function makeAuthProvider(token = 'test-token'): KoofrAuthProvider {
	return {
		getToken: vi.fn().mockResolvedValue(token),
		getAuthHeader: vi.fn().mockResolvedValue(`Token token=${token}`),
		reauthenticate: vi.fn().mockResolvedValue(token),
	} as unknown as KoofrAuthProvider;
}

function jsonResponse(status: number, body: unknown) {
	return {
		status,
		text: JSON.stringify(body),
		json: body,
		arrayBuffer: new ArrayBuffer(0),
	};
}

describe('KoofrClient', () => {
	let authProvider: KoofrAuthProvider;
	let client: KoofrClient;

	beforeEach(() => {
		authProvider = makeAuthProvider();
		client = new KoofrClient(authProvider, 'mount-1');
		mockRequestUrl.mockReset();
	});

	describe('listMounts', () => {
		it('parses a lowercase "mounts" key', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, { mounts: [{ id: 'm1', name: 'My Koofr', type: 'device', isPrimary: true, isShared: false }] })
			);

			const mounts = await client.listMounts();

			expect(mounts).toHaveLength(1);
			expect(mounts[0].id).toBe('m1');
			expect(mockRequestUrl).toHaveBeenCalledWith(
				expect.objectContaining({ url: expect.stringContaining('/api/v2/mounts'), method: 'GET' })
			);
		});

		it('falls back to a capitalized "Mounts" key', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(200, { Mounts: [{ id: 'm2', name: 'Shared', type: 'import', isPrimary: false, isShared: true }] }));

			const mounts = await client.listMounts();
			expect(mounts[0].id).toBe('m2');
		});
	});

	describe('getItemInfo / itemExists', () => {
		it('sends the normalized path as a query param', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, { name: 'file.md', type: 'file', modified: 1000, size: 10, path: '/notes/file.md', hash: 'abc' })
			);

			const info = await client.getItemInfo('notes/file.md');

			expect(info.name).toBe('file.md');
			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toContain('/mounts/mount-1/files/info');
			expect(call.url).toContain(encodeURIComponent('/notes/file.md'));
		});

		it('itemExists returns false on a 404', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(404, { error: 'not_found', message: 'Not found' }));

			expect(await client.itemExists('missing.md')).toBe(false);
		});

		it('itemExists returns true when info succeeds', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, { name: 'file.md', type: 'file', modified: 1000, size: 10, path: '/file.md' })
			);

			expect(await client.itemExists('file.md')).toBe(true);
		});
	});

	describe('listFolder', () => {
		it('backfills the path field when the API omits it', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, { files: [{ name: 'sub', type: 'dir', modified: 0, size: 0 }] })
			);

			const items = await client.listFolder('/notes');

			expect(items[0].path).toBe('/notes/sub');
		});

		it('uses a mountId override instead of the configured mount', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(200, { files: [] }));

			await client.listFolder('/', 'other-mount');

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toContain('/mounts/other-mount/files/list');
		});

		it('returns an empty list for a 404 (folder does not exist yet)', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));

			expect(await client.listFolder('/missing')).toEqual([]);
		});
	});

	describe('getTree', () => {
		it('flattens a nested tree into a list with reconstructed full paths, excluding the root', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, {
					name: 'MyVault',
					type: 'dir',
					modified: 0,
					size: 0,
					children: [
						{ name: 'note.md', type: 'file', modified: 100, size: 5, hash: 'h1' },
						{
							name: 'sub',
							type: 'dir',
							modified: 0,
							size: 0,
							children: [{ name: 'nested.md', type: 'file', modified: 200, size: 8, hash: 'h2' }],
						},
					],
				})
			);

			const items = await client.getTree('/MyVault');

			expect(items).toHaveLength(3);
			const byPath = new Map(items.map((i) => [i.path, i]));
			expect(byPath.get('/MyVault/note.md')?.hash).toBe('h1');
			expect(byPath.get('/MyVault/sub')?.type).toBe('dir');
			expect(byPath.get('/MyVault/sub/nested.md')?.hash).toBe('h2');
			// Root itself is excluded
			expect(byPath.has('/MyVault')).toBe(false);
		});

		it('returns an empty list when the sync root does not exist remotely yet (404)', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));

			expect(await client.getTree('/DoesNotExist')).toEqual([]);
		});
	});

	describe('uploadFile', () => {
		it('sends a multipart body with parent path, filename, and modified as query params', async () => {
			mockRequestUrl.mockResolvedValue(
				jsonResponse(200, { name: 'file.md', type: 'file', modified: 1234, size: 11, hash: 'newhash' })
			);

			const content = new TextEncoder().encode('hello world').buffer;
			const result = await client.uploadFile('/notes/file.md', content, 1234);

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.method).toBe('POST');
			expect(call.url).toContain('/content/api/v2/mounts/mount-1/files/put');
			expect(call.url).toContain(`path=${encodeURIComponent('/notes')}`);
			expect(call.url).toContain('filename=file.md');
			expect(call.url).toContain('modified=1234');
			expect(call.headers['Content-Type']).toContain('multipart/form-data; boundary=');

			// Body should contain the raw file bytes between multipart boundaries
			const bodyText = new TextDecoder().decode(call.body as ArrayBuffer);
			expect(bodyText).toContain('hello world');
			expect(bodyText).toContain('Content-Disposition: form-data; name="file"');

			// Trusts the requested path over whatever the response says
			expect(result.path).toBe('/notes/file.md');
			expect(result.hash).toBe('newhash');
		});
	});

	describe('createFolder', () => {
		it('posts the folder name with the parent as the path param', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(201, {}));

			await client.createFolder('/notes/sub');

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.method).toBe('POST');
			expect(call.url).toContain('/mounts/mount-1/files/folder');
			expect(call.url).toContain(`path=${encodeURIComponent('/notes')}`);
			expect(JSON.parse(call.body as string)).toEqual({ name: 'sub' });
		});
	});

	describe('deleteItem', () => {
		it('sends a DELETE request', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(200, {}));

			await client.deleteItem('/notes/file.md');

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.method).toBe('DELETE');
			expect(call.url).toContain('/mounts/mount-1/files/remove');
		});

		it('treats a 404 as success (already deleted)', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(404, { error: 'not_found' }));

			await expect(client.deleteItem('/gone.md')).resolves.toBeUndefined();
		});
	});

	describe('moveItem', () => {
		it('PUTs with toMountId and toPath in the body', async () => {
			mockRequestUrl.mockResolvedValue(jsonResponse(200, {}));

			await client.moveItem('/old.md', '/new.md');

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.method).toBe('PUT');
			expect(call.url).toContain('/mounts/mount-1/files/move');
			expect(call.url).toContain(`path=${encodeURIComponent('/old.md')}`);
			expect(JSON.parse(call.body as string)).toEqual({ toMountId: 'mount-1', toPath: '/new.md' });
		});
	});

	describe('401 handling', () => {
		it('re-authenticates and retries once on a 401, then succeeds', async () => {
			mockRequestUrl
				.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))
				.mockResolvedValueOnce(jsonResponse(200, { mounts: [] }));

			const mounts = await client.listMounts();

			expect(mounts).toEqual([]);
			expect(authProvider.reauthenticate).toHaveBeenCalledTimes(1);
			expect(mockRequestUrl).toHaveBeenCalledTimes(2);
		});
	});

	describe('mount requirement', () => {
		it('throws a clear error when no mount is configured', async () => {
			const clientWithoutMount = new KoofrClient(authProvider);
			await expect(clientWithoutMount.listFolder('/')).rejects.toThrow('No Koofr mount selected');
		});
	});
});
