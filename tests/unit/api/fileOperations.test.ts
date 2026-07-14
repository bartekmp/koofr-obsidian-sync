/**
 * Unit tests for FileOperations — specifically the known-folder caching
 * that replaced the old "skip folder checks" experimental toggle. Instead
 * of an unconditional live existence check (or none at all, at the user's
 * risk), parent-folder checks are now free when the folder was already
 * seen in the sync engine's remote snapshot, and only hit the network for
 * folders that are genuinely new.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileOperations } from '../../../src/api/fileOperations';
import { KoofrClient } from '../../../src/api/koofrClient';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function makeClient() {
	return {
		uploadFile: vi
			.fn()
			.mockResolvedValue({ name: 'file.md', type: 'file', modified: 0, size: 0, path: '/x' }),
		downloadFile: vi.fn(),
		deleteItem: vi.fn().mockResolvedValue(undefined),
		moveItem: vi.fn().mockResolvedValue(undefined),
		createFolder: vi.fn().mockResolvedValue(undefined),
		itemExists: vi.fn().mockResolvedValue(false),
		getItemInfo: vi.fn(),
		getTree: vi.fn().mockResolvedValue([]),
	} as unknown as KoofrClient & {
		uploadFile: ReturnType<typeof vi.fn>;
		createFolder: ReturnType<typeof vi.fn>;
		itemExists: ReturnType<typeof vi.fn>;
		moveItem: ReturnType<typeof vi.fn>;
	};
}

describe('FileOperations known-folder caching', () => {
	let client: ReturnType<typeof makeClient>;
	let fileOps: FileOperations;

	beforeEach(() => {
		client = makeClient();
		fileOps = new FileOperations(client);
	});

	it('creates missing parent folders when nothing is seeded', async () => {
		await fileOps.uploadFile('/notes/sub/file.md', new ArrayBuffer(0));

		expect(client.createFolder).toHaveBeenCalledWith('/notes');
		expect(client.createFolder).toHaveBeenCalledWith('/notes/sub');
		expect(client.itemExists).not.toHaveBeenCalled(); // no existence pre-check anymore
	});

	it('skips folder creation entirely for seeded (known) folders', async () => {
		fileOps.seedKnownFolders(['/notes', '/notes/sub']);

		await fileOps.uploadFile('/notes/sub/file.md', new ArrayBuffer(0));

		expect(client.createFolder).not.toHaveBeenCalled();
	});

	it('only creates the unseeded ancestor when a parent is partially known', async () => {
		fileOps.seedKnownFolders(['/notes']);

		await fileOps.uploadFile('/notes/sub/file.md', new ArrayBuffer(0));

		expect(client.createFolder).not.toHaveBeenCalledWith('/notes');
		expect(client.createFolder).toHaveBeenCalledWith('/notes/sub');
		expect(client.createFolder).toHaveBeenCalledTimes(1);
	});

	it('remembers a newly created folder — a second upload into it does not recreate it', async () => {
		await fileOps.uploadFile('/notes/a.md', new ArrayBuffer(0));
		expect(client.createFolder).toHaveBeenCalledTimes(1);

		client.createFolder.mockClear();
		await fileOps.uploadFile('/notes/b.md', new ArrayBuffer(0));
		expect(client.createFolder).not.toHaveBeenCalled();
	});

	it('ensures the destination parent folder on move too', async () => {
		await fileOps.moveFile('/old.md', '/archive/new.md');

		expect(client.createFolder).toHaveBeenCalledWith('/archive');
		expect(client.moveItem).toHaveBeenCalledWith('/old.md', '/archive/new.md');
	});

	it('falls back to itemExists only when createFolder throws, and swallows the error if the folder is actually there', async () => {
		client.createFolder.mockRejectedValueOnce(new Error('weird 409 wording we do not match'));
		client.itemExists.mockResolvedValueOnce(true);

		await expect(fileOps.uploadFile('/notes/file.md', new ArrayBuffer(0))).resolves.toBeDefined();
		expect(client.itemExists).toHaveBeenCalledWith('/notes');
	});

	it('propagates the error when createFolder fails and the folder genuinely does not exist', async () => {
		client.createFolder.mockRejectedValueOnce(new Error('permission denied'));
		client.itemExists.mockResolvedValueOnce(false);

		await expect(fileOps.uploadFile('/notes/file.md', new ArrayBuffer(0))).rejects.toThrow(
			'permission denied'
		);
	});

	it('dedupes concurrent ensure calls for the same folder into a single createFolder request', async () => {
		let resolveCreate!: () => void;
		client.createFolder.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveCreate = resolve;
				})
		);

		const upload1 = fileOps.uploadFile('/notes/a.md', new ArrayBuffer(0));
		const upload2 = fileOps.uploadFile('/notes/b.md', new ArrayBuffer(0));

		resolveCreate();
		await Promise.all([upload1, upload2]);

		expect(client.createFolder).toHaveBeenCalledTimes(1);
	});
});
