/**
 * Unit tests for SyncEngine — focused on the snapshot-diff behavior that
 * replaces OneDrive's delta-cursor engine (see the architecture comment
 * at the top of src/sync/syncEngine.ts). Not a full port of the reference
 * suite (which tests delta-specific mechanics that no longer exist) —
 * covers the key diff/plan/execute branches instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { EventManager } from '../../../src/sync/eventManager';
import { ConflictResolutionStrategy, KoofrFileInfo, LocalChangeType } from '../../../src/types';
import { mockApp, makeTFile } from '../../setup';

function makeFileOps() {
	return {
		listAllItems: vi.fn().mockResolvedValue([] as KoofrFileInfo[]),
		listAllFiles: vi.fn().mockResolvedValue([] as KoofrFileInfo[]),
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		deleteFile: vi.fn().mockResolvedValue(undefined),
		moveFile: vi.fn().mockResolvedValue(undefined),
		createFolder: vi.fn().mockResolvedValue(undefined),
		fileExists: vi.fn().mockResolvedValue(false),
		getFileMetadata: vi.fn(),
	};
}

describe('SyncEngine', () => {
	let fileOps: ReturnType<typeof makeFileOps>;
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let eventManager: EventManager;

	beforeEach(() => {
		vi.clearAllMocks();
		fileOps = makeFileOps();
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		eventManager = new EventManager(mockApp as never, vi.fn(), stateManager);

		mockApp.vault.getFiles.mockReturnValue([]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);
		mockApp.vault.adapter.exists.mockResolvedValue(false);
		mockApp.vault.adapter.stat.mockResolvedValue(null);
		mockApp.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		mockApp.vault.adapter.readBinary.mockResolvedValue(new ArrayBuffer(0));
		mockApp.vault.adapter.writeBinary.mockResolvedValue(undefined);
		mockApp.vault.adapter.read.mockRejectedValue(new Error('no .syncIgnore'));
		mockApp.fileManager.trashFile.mockResolvedValue(undefined);
	});

	function makeEngine(options: Partial<Parameters<typeof SyncEngine.prototype.constructor>[6]> = {}) {
		return new SyncEngine(
			mockApp as never,
			fileOps as never,
			stateManager,
			conflictResolver,
			eventManager,
			'.obsidian',
			{ remoteRoot: '', ...options }
		);
	}

	describe('local-only files (first sync)', () => {
		it('uploads a local file that does not exist remotely', async () => {
			const file = makeTFile('note.md', 11, 5000);
			mockApp.vault.getFiles.mockReturnValue([file]);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
			mockApp.vault.readBinary.mockResolvedValue(new TextEncoder().encode('hello world').buffer);
			fileOps.uploadFile.mockResolvedValue({
				name: 'note.md',
				type: 'file',
				modified: 5000,
				size: 11,
				hash: 'h1',
				path: '/note.md',
			});

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.uploadFile).toHaveBeenCalledWith('/note.md', expect.any(ArrayBuffer), 5000);
			const state = stateManager.getFileState('note.md');
			expect(state?.remoteHash).toBe('h1');
		});
	});

	describe('remote-only files', () => {
		it('downloads a remote file that does not exist locally', async () => {
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'note.md', type: 'file', modified: 1000, size: 5, hash: 'h1', path: '/note.md' },
			]);
			fileOps.downloadFile.mockResolvedValue(new TextEncoder().encode('hello').buffer);
			mockApp.vault.adapter.stat.mockResolvedValue({ mtime: 1234, size: 5, type: 'file' });

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.downloadFile).toHaveBeenCalledWith('/note.md');
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith('note.md', expect.any(ArrayBuffer));
			const state = stateManager.getFileState('note.md');
			expect(state?.remoteHash).toBe('h1');
		});
	});

	describe('unchanged files', () => {
		it('skips a file whose remote hash matches tracked state', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'h1',
				size: 5,
				remoteModifiedTime: 1000,
			});
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'note.md', type: 'file', modified: 1000, size: 5, hash: 'h1', path: '/note.md' },
			]);

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.uploadFile).not.toHaveBeenCalled();
			expect(fileOps.downloadFile).not.toHaveBeenCalled();
		});
	});

	describe('local delete', () => {
		it('deletes remotely when the file still exists there', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'h1',
				size: 5,
				remoteModifiedTime: 1000,
			});
			eventManager.getDirtyFiles = vi.fn().mockReturnValue([{ path: 'note.md', type: LocalChangeType.DELETE }]);
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'note.md', type: 'file', modified: 1000, size: 5, hash: 'h1', path: '/note.md' },
			]);

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.deleteFile).toHaveBeenCalledWith('/note.md');
			expect(stateManager.getFileState('note.md')).toBeUndefined();
		});

		it('is a no-op when the file is already gone remotely too', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'h1',
				size: 5,
				remoteModifiedTime: 1000,
			});
			eventManager.getDirtyFiles = vi.fn().mockReturnValue([{ path: 'note.md', type: LocalChangeType.DELETE }]);
			fileOps.listAllItems.mockResolvedValue([]);

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.deleteFile).not.toHaveBeenCalled();
			expect(stateManager.getFileState('note.md')).toBeUndefined();
		});
	});

	describe('remote delete', () => {
		it('removes the local file when tracked state is missing from the snapshot', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'h1',
				size: 5,
				remoteModifiedTime: 1000,
			});
			const file = makeTFile('note.md', 5, 1000);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
			fileOps.listAllItems.mockResolvedValue([]);

			const engine = makeEngine();
			await engine.performSync();

			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(file);
			expect(stateManager.getFileState('note.md')).toBeUndefined();
		});
	});

	describe('conflicts', () => {
		it('queues a manual conflict when both local and remote changed', async () => {
			conflictResolver.setStrategy(ConflictResolutionStrategy.MANUAL);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'old-hash',
				size: 5,
				remoteModifiedTime: 1000,
			});
			eventManager.getDirtyFiles = vi.fn().mockReturnValue([{ path: 'note.md', type: LocalChangeType.MODIFY }]);
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'note.md', type: 'file', modified: 5000, size: 20, hash: 'new-hash', path: '/note.md' },
			]);

			const localFile = makeTFile('note.md', 12, 9000);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);
			mockApp.vault.readBinary.mockResolvedValue(new TextEncoder().encode('local content').buffer);
			fileOps.downloadFile.mockResolvedValue(new TextEncoder().encode('remote content').buffer);

			const conflictQueue = {
				hasConflict: vi.fn().mockReturnValue(false),
				add: vi.fn().mockResolvedValue({ id: 'c1', path: 'note.md' }),
			};

			const engine = makeEngine({ conflictQueue });
			await engine.performSync();

			expect(conflictQueue.add).toHaveBeenCalledWith(
				'note.md',
				expect.any(ArrayBuffer),
				expect.any(ArrayBuffer),
				9000,
				5000,
				'new-hash'
			);
			// Not a plain upload/download — it went through conflict resolution
			expect(fileOps.uploadFile).not.toHaveBeenCalled();
		});

		it('treats a hash-unchanged remote echo as a plain upload, not a conflict', async () => {
			conflictResolver.setStrategy(ConflictResolutionStrategy.MANUAL);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('note.md', {
				path: 'note.md',
				localMtime: 1000,
				remoteHash: 'same-hash',
				size: 5,
				remoteModifiedTime: 1000,
			});
			eventManager.getDirtyFiles = vi.fn().mockReturnValue([{ path: 'note.md', type: LocalChangeType.MODIFY }]);
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'note.md', type: 'file', modified: 1000, size: 5, hash: 'same-hash', path: '/note.md' },
			]);

			const localFile = makeTFile('note.md', 12, 9000);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);
			mockApp.vault.readBinary.mockResolvedValue(new TextEncoder().encode('local content').buffer);
			fileOps.uploadFile.mockResolvedValue({
				name: 'note.md',
				type: 'file',
				modified: 9500,
				size: 12,
				hash: 'freshly-uploaded-hash',
				path: '/note.md',
			});

			const conflictQueue = { hasConflict: vi.fn().mockReturnValue(false), add: vi.fn() };
			const engine = makeEngine({ conflictQueue });
			await engine.performSync();

			expect(fileOps.uploadFile).toHaveBeenCalled();
			expect(conflictQueue.add).not.toHaveBeenCalled();
		});
	});

	describe('rename via atomic move', () => {
		it('moves the remote file instead of delete+upload', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('old.md', {
				path: 'old.md',
				localMtime: 1000,
				remoteHash: 'h1',
				size: 5,
				remoteModifiedTime: 1000,
			});
			eventManager.getDirtyFiles = vi
				.fn()
				.mockReturnValue([{ path: 'new.md', type: LocalChangeType.RENAME, oldPath: 'old.md' }]);
			fileOps.listAllItems.mockResolvedValue([
				{ name: 'old.md', type: 'file', modified: 1000, size: 5, hash: 'h1', path: '/old.md' },
			]);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('new.md', 5, 2000));

			const engine = makeEngine({ useAtomicMoves: true });
			await engine.performSync();

			expect(fileOps.moveFile).toHaveBeenCalledWith('/old.md', '/new.md');
			expect(fileOps.uploadFile).not.toHaveBeenCalled();
			expect(fileOps.deleteFile).not.toHaveBeenCalled();
			expect(stateManager.getFileState('old.md')).toBeUndefined();
			expect(stateManager.getFileState('new.md')).toBeDefined();
		});
	});

	describe('large delete guard', () => {
		it('cancels the sync and applies nothing when the user declines', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setFileState('a.md', { path: 'a.md', localMtime: 0, remoteHash: 'h1', size: 1, remoteModifiedTime: 0 });
			stateManager.setFileState('b.md', { path: 'b.md', localMtime: 0, remoteHash: 'h2', size: 1, remoteModifiedTime: 0 });
			fileOps.listAllItems.mockResolvedValue([]); // both gone remotely -> 2 local deletes

			const largeDeleteWarningHandler = vi.fn().mockResolvedValue('cancel');
			const engine = makeEngine({
				getLargeDeleteThreshold: () => 1,
				largeDeleteWarningHandler,
			});
			await engine.performSync();

			expect(largeDeleteWarningHandler).toHaveBeenCalledTimes(1);
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			// State untouched since the sync was aborted before execution
			expect(stateManager.getFileState('a.md')).toBeDefined();
			expect(stateManager.getFileState('b.md')).toBeDefined();
		});
	});

	describe('folder changes', () => {
		it('creates a remote folder for a local folder create event', async () => {
			eventManager.getDirtyFiles = vi
				.fn()
				.mockReturnValue([{ path: 'NewFolder', type: LocalChangeType.FOLDER_CREATE }]);

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.createFolder).toHaveBeenCalledWith('/NewFolder');
			expect(stateManager.hasFolderPath('NewFolder')).toBe(true);
		});

		it('deletes a remote folder for a local folder delete event', async () => {
			stateManager.addFolderPath('OldFolder');
			eventManager.getDirtyFiles = vi
				.fn()
				.mockReturnValue([{ path: 'OldFolder', type: LocalChangeType.FOLDER_DELETE }]);

			const engine = makeEngine();
			await engine.performSync();

			expect(fileOps.deleteFile).toHaveBeenCalledWith('/OldFolder');
			expect(stateManager.hasFolderPath('OldFolder')).toBe(false);
		});
	});
});
