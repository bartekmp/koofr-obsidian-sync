/**
 * Tests for ConflictQueue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictQueue } from '../../../src/sync/conflictQueue';
import { ConflictResolution } from '../../../src/types';
import { SyncStateManager } from '../../../src/sync/syncState';
import { EventManager } from '../../../src/sync/eventManager';
import { mockApp } from '../../setup';

describe('ConflictQueue', () => {
	let queue: ConflictQueue;
	let stateManager: SyncStateManager;
	let eventManager: EventManager;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		eventManager = new EventManager(
			mockApp as never,
			vi.fn().mockResolvedValue(undefined),
			stateManager
		);
		queue = new ConflictQueue(mockApp as never, stateManager, eventManager, mockApp.vault.configDir);

		mockApp.vault.adapter.exists.mockResolvedValue(false);
		mockApp.vault.adapter.writeBinary.mockResolvedValue(undefined);
		mockApp.vault.adapter.mkdir.mockResolvedValue(undefined);
		mockApp.vault.adapter.remove.mockResolvedValue(undefined);
		mockApp.vault.adapter.rmdir.mockResolvedValue(undefined);
	});

	describe('add', () => {
		it('should add a conflict entry', async () => {
			const localContent = new TextEncoder().encode('local content').buffer;
			const remoteContent = new TextEncoder().encode('remote content').buffer;

			const entry = await queue.add('notes/test.md', localContent, remoteContent, 1000, 2000, 'hash-1');

			expect(entry.path).toBe('notes/test.md');
			expect(entry.localModifiedTime).toBe(1000);
			expect(entry.remoteModifiedTime).toBe(2000);
			expect(entry.remoteHash).toBe('hash-1');
			expect(entry.isTextFile).toBe(true);
			expect(entry.id).toBeTruthy();
			expect(queue.count).toBe(1);
		});

		it('should detect text files by extension', async () => {
			const buf = new ArrayBuffer(0);

			const mdEntry = await queue.add('test.md', buf, buf, 0, 0, 'hash');
			expect(mdEntry.isTextFile).toBe(true);

			const pngEntry = await queue.add('image.png', buf, buf, 0, 0, 'hash');
			expect(pngEntry.isTextFile).toBe(false);
		});

		it('should store content as sidecar files', async () => {
			const localContent = new TextEncoder().encode('local').buffer;
			const remoteContent = new TextEncoder().encode('remote').buffer;

			const entry = await queue.add('test.md', localContent, remoteContent, 0, 0, 'hash');

			expect(mockApp.vault.adapter.mkdir).toHaveBeenCalledWith(expect.stringContaining(entry.id));
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledTimes(2);
		});

		it('should deduplicate by path — replacing existing entry', async () => {
			const buf = new ArrayBuffer(0);
			mockApp.vault.adapter.exists.mockResolvedValue(true);

			await queue.add('test.md', buf, buf, 1000, 2000, 'hash-1');
			expect(queue.count).toBe(1);

			await queue.add('test.md', buf, buf, 3000, 4000, 'hash-2');
			expect(queue.count).toBe(1);

			const entries = queue.getAll();
			expect(entries[0].remoteHash).toBe('hash-2');
			expect(entries[0].remoteModifiedTime).toBe(4000);
		});
	});

	describe('hasConflict / getByPath', () => {
		it('should find conflicts by path', async () => {
			const buf = new ArrayBuffer(0);
			await queue.add('test.md', buf, buf, 0, 0, 'hash');

			expect(queue.hasConflict('test.md')).toBe(true);
			expect(queue.hasConflict('other.md')).toBe(false);
			expect(queue.getByPath('test.md')?.path).toBe('test.md');
		});
	});

	describe('resolve', () => {
		it('should resolve with ACCEPT_CURRENT — marks file dirty', async () => {
			const buf = new ArrayBuffer(0);
			const entry = await queue.add('test.md', buf, buf, 0, 0, 'hash');

			const addDirtySpy = vi.spyOn(eventManager, 'addDirtyFile');

			await queue.resolve(entry.id, ConflictResolution.ACCEPT_CURRENT);

			expect(queue.count).toBe(0);
			expect(addDirtySpy).toHaveBeenCalledWith('test.md', 'modify');
		});

		it('should resolve with ACCEPT_INCOMING — writes remote content', async () => {
			const localContent = new TextEncoder().encode('local').buffer;
			const remoteContent = new TextEncoder().encode('remote').buffer;

			mockApp.vault.adapter.readBinary.mockResolvedValue(remoteContent);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

			const entry = await queue.add('test.md', localContent, remoteContent, 1000, 2000, 'hash-1');

			const markOwnSpy = vi.spyOn(eventManager, 'markOwnWrites');

			await queue.resolve(entry.id, ConflictResolution.ACCEPT_INCOMING);

			expect(queue.count).toBe(0);
			expect(markOwnSpy).toHaveBeenCalledWith(['test.md']);
			expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith('test.md', remoteContent);

			const fileState = stateManager.getFileState('test.md');
			expect(fileState).toBeDefined();
			expect(fileState?.remoteHash).toBe('hash-1');
		});

		it('should resolve with ACCEPT_BOTH — creates duplicate file', async () => {
			const localContent = new TextEncoder().encode('local').buffer;
			const remoteContent = new TextEncoder().encode('remote').buffer;

			mockApp.vault.adapter.readBinary.mockResolvedValue(remoteContent);

			const entry = await queue.add('test.md', localContent, remoteContent, 0, 0, 'hash');

			const addDirtySpy = vi.spyOn(eventManager, 'addDirtyFile');
			const markOwnSpy = vi.spyOn(eventManager, 'markOwnWrites');

			await queue.resolve(entry.id, ConflictResolution.ACCEPT_BOTH);

			expect(queue.count).toBe(0);
			expect(markOwnSpy).toHaveBeenCalled();
			expect(addDirtySpy).toHaveBeenCalledWith('test.md', 'modify');
			expect(addDirtySpy).toHaveBeenCalledWith(expect.stringContaining('(conflict'), 'create');
		});

		it('should handle resolving non-existent conflict gracefully', async () => {
			await queue.resolve('non-existent', ConflictResolution.ACCEPT_CURRENT);
			// No error thrown
		});
	});

	describe('resolveAll', () => {
		it('should resolve all conflicts with the same strategy', async () => {
			const buf = new ArrayBuffer(0);
			await queue.add('file1.md', buf, buf, 0, 0, 'hash1');
			await queue.add('file2.md', buf, buf, 0, 0, 'hash2');
			await queue.add('file3.md', buf, buf, 0, 0, 'hash3');

			expect(queue.count).toBe(3);

			await queue.resolveAll(ConflictResolution.ACCEPT_CURRENT);

			expect(queue.count).toBe(0);
		});
	});

	describe('persistence', () => {
		it('should serialize and deserialize entries', async () => {
			const buf = new ArrayBuffer(0);
			await queue.add('file1.md', buf, buf, 1000, 2000, 'hash1');
			await queue.add('file2.txt', buf, buf, 3000, 4000, 'hash2');

			const saved = queue.prepareForSave();
			expect(saved.entries).toHaveLength(2);

			const newQueue = new ConflictQueue(mockApp as never, stateManager, eventManager, mockApp.vault.configDir);
			newQueue.load(saved);

			expect(newQueue.count).toBe(2);
			expect(newQueue.hasConflict('file1.md')).toBe(true);
			expect(newQueue.hasConflict('file2.txt')).toBe(true);
		});

		it('should handle loading undefined data', () => {
			queue.load(undefined);
			expect(queue.count).toBe(0);
		});

		it('should handle loading empty data', () => {
			queue.load({ entries: [] });
			expect(queue.count).toBe(0);
		});
	});
});
