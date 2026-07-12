import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, 'tests/__mocks__/obsidian.ts'),
		},
	},
	oxc: {
		decorator: { legacy: true },
	},
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: ['tests/', 'node_modules/', '*.config.*', 'main.js', 'version-bump.mjs'],
			// NOTE: these are set to what the current suite actually achieves, not
			// aspirational targets — the UI layer (settings.ts, folderBrowserModal.ts,
			// conflictView.ts, statusBar.ts, progressNotice.ts), main.ts wiring, and
			// eventManager's vault-event registration are not yet covered by tests.
			// Raise thresholds as coverage is added; don't lower them silently.
			thresholds: {
				lines: 55,
				branches: 45,
				functions: 70,
				statements: 55,

				'src/sync/syncState.ts': {
					lines: 80,
				},
				'src/sync/conflictResolver.ts': {
					lines: 90,
				},
				'src/sync/conflictQueue.ts': {
					lines: 90,
				},
			},
		},
	},
});
