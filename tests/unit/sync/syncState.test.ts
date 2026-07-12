import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
	},
}));

import { SyncStateManager } from '../../../src/sync/syncState';
import type { FileState } from '../../../src/types';

function makeFileState(path: string, overrides: Partial<FileState> = {}): FileState {
	return {
		path,
		localMtime: Date.now(),
		remoteHash: `hash-${path}`,
		size: 100,
		remoteModifiedTime: Date.now(),
		...overrides,
	};
}

describe('SyncStateManager', () => {
	let stateManager: SyncStateManager;

	beforeEach(() => {
		stateManager = new SyncStateManager();
	});

	it('clearFileStates clears file states while preserving folder paths and sync metadata', () => {
		stateManager.setLastSyncTime(123456);
		stateManager.setFileState('notes/one.md', makeFileState('notes/one.md'));
		stateManager.setFileState('notes/two.md', makeFileState('notes/two.md'));
		stateManager.addFolderPath('notes');
		stateManager.addFolderPath('archive');

		stateManager.clearFileStates();

		expect(stateManager.getTrackedPaths()).toEqual([]);
		expect(stateManager.getFileState('notes/one.md')).toBeUndefined();
		expect(stateManager.getFileState('notes/two.md')).toBeUndefined();
		expect(stateManager.hasFolderPath('notes')).toBe(true);
		expect(stateManager.hasFolderPath('archive')).toBe(true);
		expect(stateManager.getLastSyncTime()).toBe(123456);
	});

	describe('folder path tracking', () => {
		it('tracks and removes folder paths', () => {
			stateManager.addFolderPath('notes');
			stateManager.addFolderPath('notes/subfolder');

			expect(stateManager.hasFolderPath('notes')).toBe(true);
			expect(stateManager.hasFolderPath('notes/subfolder')).toBe(true);
			expect(stateManager.hasFolderPath('missing')).toBe(false);

			stateManager.removeFolderPath('notes');
			expect(stateManager.hasFolderPath('notes')).toBe(false);
			expect(stateManager.hasFolderPath('notes/subfolder')).toBe(true);
		});

		it('handles removing a non-existent folder path without throwing', () => {
			expect(() => stateManager.removeFolderPath('non-existent')).not.toThrow();
			expect(stateManager.hasFolderPath('non-existent')).toBe(false);
		});

		it('returns all tracked folder paths', () => {
			stateManager.addFolderPath('notes');
			stateManager.addFolderPath('archive');

			const paths = stateManager.getAllFolderPaths();
			expect(paths).toHaveLength(2);
			expect(paths).toContain('notes');
			expect(paths).toContain('archive');
		});
	});

	describe('file state operations', () => {
		it('should set and get file state', () => {
			const state = makeFileState('test.md');
			stateManager.setFileState('test.md', state);

			expect(stateManager.getFileState('test.md')).toEqual(state);
		});

		it('should remove file state', () => {
			stateManager.setFileState('test.md', makeFileState('test.md'));
			stateManager.removeFileState('test.md');

			expect(stateManager.getFileState('test.md')).toBeUndefined();
		});

		it('should return all tracked paths', () => {
			stateManager.setFileState('a.md', makeFileState('a.md'));
			stateManager.setFileState('b.md', makeFileState('b.md'));
			stateManager.setFileState('c.md', makeFileState('c.md'));

			const paths = stateManager.getTrackedPaths();
			expect(paths).toHaveLength(3);
			expect(paths).toContain('a.md');
			expect(paths).toContain('b.md');
			expect(paths).toContain('c.md');
		});

		it('should get file states under folder', () => {
			stateManager.setFileState('notes/a.md', makeFileState('notes/a.md'));
			stateManager.setFileState('notes/b.md', makeFileState('notes/b.md'));
			stateManager.setFileState('other/c.md', makeFileState('other/c.md'));

			const notesFiles = stateManager.getFileStatesUnderFolder('notes');
			expect(notesFiles).toHaveLength(2);
			expect(notesFiles.map((f) => f.path)).toContain('notes/a.md');
			expect(notesFiles.map((f) => f.path)).toContain('notes/b.md');
		});
	});

	describe('sync metadata', () => {
		it('should set and get last sync time', () => {
			stateManager.setLastSyncTime(1234567890);
			expect(stateManager.getLastSyncTime()).toBe(1234567890);
		});

		it('should clear all state and reset to initial values', () => {
			stateManager.setLastSyncTime(123);
			stateManager.setFileState('file.md', makeFileState('file.md'));
			stateManager.addFolderPath('notes');

			stateManager.clearState();

			expect(stateManager.getLastSyncTime()).toBe(0); // Reset to 0, not undefined
			expect(stateManager.getTrackedPaths()).toEqual([]);
			expect(stateManager.hasFolderPath('notes')).toBe(false);
		});

		it('should detect first sync correctly', () => {
			expect(stateManager.isFirstSync()).toBe(true);

			stateManager.setLastSyncTime(Date.now());
			expect(stateManager.isFirstSync()).toBe(false);
		});
	});

	describe('serialization', () => {
		it('should serialize state via prepareForSave', () => {
			stateManager.setLastSyncTime(123456);
			stateManager.addFolderPath('notes');
			stateManager.setFileState('test.md', makeFileState('test.md', { size: 500 }));

			const serialized = stateManager.prepareForSave();

			expect(serialized.lastSyncTime).toBe(123456);
			expect(serialized.folderPaths).toEqual(['notes']);
			expect(serialized.fileStates).toHaveLength(1);
			expect(serialized.fileStates[0][0]).toBe('test.md');
		});

		it('should load state from persisted format', () => {
			const persisted = {
				lastSyncTime: 999999,
				folderPaths: ['notes', 'archive'],
				fileStates: [['restored.md', makeFileState('restored.md')] as [string, FileState]],
			};

			stateManager.loadState(persisted);

			expect(stateManager.getLastSyncTime()).toBe(999999);
			expect(stateManager.hasFolderPath('notes')).toBe(true);
			expect(stateManager.hasFolderPath('archive')).toBe(true);
			expect(stateManager.getFileState('restored.md')).toBeDefined();
		});

		it('should handle undefined persisted state gracefully', () => {
			stateManager.loadState(undefined);

			expect(stateManager.getLastSyncTime()).toBe(0);
			expect(stateManager.getTrackedPaths()).toEqual([]);
		});
	});
});
