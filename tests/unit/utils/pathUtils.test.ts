/**
 * Unit tests for path utilities
 */

import { describe, it, expect } from 'vitest';
import {
	normalizePath,
	joinPath,
	getParentPath,
	getFileName,
	getFileExtension,
	getFileNameWithoutExtension,
	sanitizeFileName,
	createConflictFileName,
	toRemotePath,
	toVaultPath,
	shouldSyncVaultPath,
} from '../../../src/utils/pathUtils';

describe('pathUtils', () => {
	describe('normalizePath', () => {
		it('should convert backslashes to forward slashes', () => {
			expect(normalizePath('foo\\bar\\baz')).toBe('foo/bar/baz');
			expect(normalizePath('C:\\Users\\Name\\file.txt')).toBe('C:/Users/Name/file.txt');
		});

		it('should leave forward slashes unchanged', () => {
			expect(normalizePath('foo/bar/baz')).toBe('foo/bar/baz');
		});
	});

	describe('joinPath', () => {
		it('should join path segments with forward slashes', () => {
			expect(joinPath('foo', 'bar', 'baz')).toBe('foo/bar/baz');
		});

		it('should handle leading/trailing slashes', () => {
			expect(joinPath('/foo/', '/bar/', '/baz/')).toBe('foo/bar/baz');
		});

		it('should filter out empty segments', () => {
			expect(joinPath('foo', '', 'bar')).toBe('foo/bar');
		});
	});

	describe('getParentPath', () => {
		it('should return parent directory', () => {
			expect(getParentPath('foo/bar/file.txt')).toBe('foo/bar');
			expect(getParentPath('foo/file.txt')).toBe('foo');
		});

		it('should return empty string for root-level files', () => {
			expect(getParentPath('file.txt')).toBe('');
		});
	});

	describe('getFileName', () => {
		it('should extract filename from path', () => {
			expect(getFileName('foo/bar/file.txt')).toBe('file.txt');
			expect(getFileName('file.txt')).toBe('file.txt');
		});
	});

	describe('getFileExtension', () => {
		it('should extract file extension including dot', () => {
			expect(getFileExtension('file.txt')).toBe('.txt');
			expect(getFileExtension('archive.tar.gz')).toBe('.gz');
		});

		it('should return empty string for files without extension', () => {
			expect(getFileExtension('README')).toBe('');
		});
	});

	describe('getFileNameWithoutExtension', () => {
		it('should return filename without extension', () => {
			expect(getFileNameWithoutExtension('file.txt')).toBe('file');
			expect(getFileNameWithoutExtension('archive.tar.gz')).toBe('archive.tar');
		});

		it('should return full name for files without extension', () => {
			expect(getFileNameWithoutExtension('README')).toBe('README');
		});
	});

	describe('sanitizeFileName', () => {
		it('should remove invalid characters', () => {
			expect(sanitizeFileName('file<name>.txt')).toBe('file_name_.txt');
			expect(sanitizeFileName('file|name')).toBe('file_name');
		});

		it('should handle reserved names', () => {
			expect(sanitizeFileName('con')).toBe('_con');
			expect(sanitizeFileName('CON')).toBe('_CON');
		});

		it('should remove leading/trailing dots and spaces', () => {
			expect(sanitizeFileName('  .file.txt  ')).toBe('file.txt');
		});

		it('should return "unnamed" for empty result', () => {
			expect(sanitizeFileName('...')).toBe('unnamed');
		});
	});

	describe('createConflictFileName', () => {
		it('should add conflict marker with timestamp', () => {
			const result = createConflictFileName('note.md');
			expect(result).toMatch(/^note \(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.md$/);
		});

		it('should work with files without extension', () => {
			const result = createConflictFileName('README');
			expect(result).toMatch(/^README \(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)$/);
		});
	});

	describe('toRemotePath', () => {
		it('should prepend remote root to vault path with a leading slash', () => {
			expect(toRemotePath('notes/file.md', '/vault')).toBe('/vault/notes/file.md');
		});

		it('should add a leading slash even with an empty remote root', () => {
			expect(toRemotePath('notes/file.md', '')).toBe('/notes/file.md');
		});

		it('should normalize a remote root missing its leading slash', () => {
			expect(toRemotePath('notes/file.md', 'vault')).toBe('/vault/notes/file.md');
		});
	});

	describe('toVaultPath', () => {
		it('should remove remote root from a Koofr path', () => {
			expect(toVaultPath('/vault/notes/file.md', '/vault')).toBe('notes/file.md');
		});

		it('should strip only the leading slash if path is not under root', () => {
			expect(toVaultPath('/other/file.md', '/vault')).toBe('other/file.md');
		});

		it('should handle nested files under a multi-segment root', () => {
			const remotePath = '/Documents/ObsidianVaults/JeffBrain/notes/daily.md';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			expect(toVaultPath(remotePath, remoteRoot)).toBe('notes/daily.md');
		});

		it('should handle root-level files under the sync root', () => {
			const remotePath = '/Documents/ObsidianVaults/JeffBrain/Welcome.md';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			expect(toVaultPath(remotePath, remoteRoot)).toBe('Welcome.md');
		});

		it('should handle .obsidian paths for filtering', () => {
			const remotePath = '/Documents/ObsidianVaults/JeffBrain/.obsidian/app.json';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			const vaultPath = toVaultPath(remotePath, remoteRoot);
			expect(vaultPath).toBe('.obsidian/app.json');
			expect(vaultPath.startsWith('.obsidian/')).toBe(true);
		});

		it('should handle an empty remote root', () => {
			expect(toVaultPath('/notes/file.md', '')).toBe('notes/file.md');
		});

		it('round-trips with toRemotePath', () => {
			const remoteRoot = '/MyVault';
			const vaultPath = 'sub/folder/note.md';
			expect(toVaultPath(toRemotePath(vaultPath, remoteRoot), remoteRoot)).toBe(vaultPath);
		});
	});

	describe('shouldSyncVaultPath', () => {
		it('should sync non-.obsidian files by default', () => {
			expect(shouldSyncVaultPath('notes/file.md', false, false, '.obsidian')).toBe(true);
		});

		it('should exclude .obsidian files by default', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', false, false, '.obsidian')).toBe(
				false
			);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/manifest.json', false, false, '.obsidian')
			).toBe(false);
		});

		it('respects a custom vault config directory', () => {
			expect(shouldSyncVaultPath('.config/app.json', false, true, '.config')).toBe(true);
			expect(shouldSyncVaultPath('.config/plugins/calendar/main.js', true, false, '.config')).toBe(
				true
			);
			expect(shouldSyncVaultPath('.config/workspace.json', true, true, '.config')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.config')).toBe(true);
		});

		it('should sync app settings files when syncAppSettings is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/appearance.json', false, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/hotkeys.json', false, true, '.obsidian')).toBe(true);
		});

		it('should exclude non-allowlisted .obsidian files even when syncAppSettings is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', false, true, '.obsidian')).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', false, true, '.obsidian')
			).toBe(false);
		});

		it('should allow selected plugin manifest files when syncPluginManifests is opted in', () => {
			expect(
				shouldSyncVaultPath('.obsidian/community-plugins.json', true, false, '.obsidian')
			).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/core-plugins.json', true, false, '.obsidian')).toBe(
				true
			);
		});

		it('should sync plugin binaries when syncPluginManifests is opted in', () => {
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/manifest.json', true, false, '.obsidian')
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, false, '.obsidian')
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/styles.css', true, false, '.obsidian')
			).toBe(true);
		});

		it('should exclude plugin data files when syncPluginManifests is opted in', () => {
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', true, false, '.obsidian')
			).toBe(false);
			expect(
				shouldSyncVaultPath(
					'.obsidian/plugins/calendar/subdir/manifest.json',
					true,
					false,
					'.obsidian'
				)
			).toBe(false);
		});

		it('should sync app settings and plugin files simultaneously when both are enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/app.json', true, true, '.obsidian')).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, true, '.obsidian')
			).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/workspace.json', true, true, '.obsidian')).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', true, true, '.obsidian')
			).toBe(false);
		});

		it('always excludes the per-device debug log folder from sync', () => {
			expect(shouldSyncVaultPath('_KoofrSyncLogs', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('_KoofrSyncLogs/2026-06-04.md', false, false, '.obsidian')).toBe(
				false
			);
			expect(shouldSyncVaultPath('_KoofrSyncLogs/sub/dir/note.md', true, true, '.obsidian')).toBe(
				false
			);
			// Files that just look similar should still sync — exclusion is
			// folder-scoped, not name-scoped, so moving a log out of the folder
			// makes it syncable again.
			expect(shouldSyncVaultPath('_KoofrSyncLogs-2026-06-04.md', false, false, '.obsidian')).toBe(
				true
			);
			expect(shouldSyncVaultPath('_KoofrSyncLogsBackup/foo.md', false, false, '.obsidian')).toBe(
				true
			);
			expect(shouldSyncVaultPath('notes/_KoofrSyncLogs/x.md', false, false, '.obsidian')).toBe(
				true
			);
		});

		it("never syncs the Koofr plugin's own folder, even with plugin sync enabled", () => {
			expect(shouldSyncVaultPath('.obsidian/plugins/koofr-sync', false, false, '.obsidian')).toBe(
				false
			);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/koofr-sync/main.js', true, true, '.obsidian')
			).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/koofr-sync/manifest.json', true, true, '.obsidian')
			).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/koofr-sync/data.json', true, true, '.obsidian')
			).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/plugins/koofr-sync/styles.css', true, true, '.obsidian')
			).toBe(false);
			// Other plugins are unaffected.
			expect(
				shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, false, '.obsidian')
			).toBe(true);
		});

		it('never syncs Obsidian per-device workspace state files', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/workspace-mobile.json', true, true, '.obsidian')).toBe(
				false
			);
			expect(
				shouldSyncVaultPath('.obsidian/workspace-JEFFSTEISL7.json', true, true, '.obsidian')
			).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/workspace-JEFFOFFICE3-6.json', true, true, '.obsidian')
			).toBe(false);
			// Other .obsidian files still follow the normal rules.
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.obsidian')).toBe(true);
		});

		it('should NOT sync CSS snippets when syncCssSnippets is disabled (default)', () => {
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian')
			).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/snippets/another.css', false, false, '.obsidian')).toBe(
				false
			);
			expect(shouldSyncVaultPath('.obsidian/snippets', false, false, '.obsidian')).toBe(false);
		});

		it('should sync CSS snippet files when syncCssSnippets is enabled', () => {
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian', true)
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/snippets/another.css', false, false, '.obsidian', true)
			).toBe(true);
		});

		it('should sync snippets folder itself when syncCssSnippets is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets', false, false, '.obsidian', true)).toBe(true);
		});

		it('should NOT sync non-css files in snippets folder', () => {
			expect(
				shouldSyncVaultPath('.obsidian/snippets/note.md', false, false, '.obsidian', true)
			).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/snippets/style.json', false, false, '.obsidian', true)
			).toBe(false);
		});

		it('should NOT sync files in subdirectories of snippets folder', () => {
			expect(
				shouldSyncVaultPath('.obsidian/snippets/sub/style.css', false, false, '.obsidian', true)
			).toBe(false);
		});

		it('should sync CSS snippets independently of app settings and plugin manifests', () => {
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', true, true, '.obsidian', true)
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian', true)
			).toBe(true);
		});

		it('should work with custom configDir for snippets', () => {
			expect(
				shouldSyncVaultPath('.config/snippets/my-style.css', false, false, '.config', true)
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.config', true)
			).toBe(true);
			expect(
				shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.config', false)
			).toBe(true);
		});
	});
});
