# Obsidian Koofr Sync

[![CI](https://github.com/REPLACE_ME/koofr-obsidian-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/REPLACE_ME/koofr-obsidian-sync/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sync your Obsidian vault with **[Koofr](https://koofr.eu)** cloud storage. Event-driven, bidirectional, mobile-friendly.

> [!NOTE]
> This plugin is not affiliated with Koofr. It's built against Koofr's public REST API v2. Its architecture (sync engine, conflict resolution, settings UI) is adapted from [obsidian-onedrive](https://github.com/jeffsteinbok/obsidian-onedrive) by Jeff Steinbok.

## ✨ Features

- **Zero Azure/OAuth setup** — Koofr auth is just an email + an app-specific password, generated in the Koofr web app.
- **Event-Driven Sync** — Syncs on file changes, not polling. Great for battery life.
- **Bidirectional** — Automatic two-way sync with configurable conflict resolution.
- **Any mount, any folder** — Sync your own Koofr storage or anything shared with you, into any subfolder.
- **Pull-Only Mode** — (Experimental) One-way sync from Koofr for read-only vaults or backup recovery.
- **Conflict resolution** — last-write-wins, create-duplicate, or a manual review pane with inline diffs.

## Why this over Koofr's native sync client / WebDAV mount?

- **Skips device-specific clutter** — workspace UI state files (`.obsidian/workspace*.json`) are intentionally excluded.
- **Event-driven, not filesystem polling** — reacts to Obsidian vault events directly.
- **Built-in merge/conflict handling** — choose overwrite, duplicate, or manual resolution instead of relying on last-writer-wins file sync.

## 🚀 Installation

### Via BRAT (Beta Testing, recommended until published)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. BRAT settings → **Add Beta Plugin** → point it at this repository

### Manual

1. Build the plugin (`npm install && npm run build`) or download `main.js`, `manifest.json`, and `styles.css` from a release
2. Place them in `.obsidian/plugins/koofr-sync/`
3. Enable the plugin in Settings → Community Plugins

## 🔧 Setup

1. Generate an app-specific password: Koofr web app → **Profile → Preferences → Password → App passwords**. Your regular Koofr account password will not work here — Koofr requires a scoped, revocable password for third-party app connections.
2. In Obsidian: Settings → Koofr Sync → enter your email and the app password → **Connect to Koofr**.
3. Click **Browse...** under Sync Folder, pick a mount (your own Koofr storage, or anything shared with you) and a folder within it.
4. Done — your vault syncs automatically on file changes.

### Configuration

| Setting | Description |
| --- | --- |
| **Sync Interval** | Set to 0 for manual-only sync (recommended for battery life) |
| **Sync on file change** | Disable to only sync on the periodic interval / manually |
| **Startup Sync Delay** | Delay before first sync after launch (0 = disabled, 10s recommended) |
| **Conflict Resolution** | Last write wins (default), create duplicate, or manual |
| **Sync App Settings** | Optional — sync `.obsidian/app.json`, `appearance.json`, `hotkeys.json` |
| **Sync Plugins** | Optional — sync plugin lists, manifests, and binaries (not plugin data files) |
| **Sync CSS Snippets** | Optional — sync `.obsidian/snippets/` |
| **Pull-Only Mode** | (Experimental) Download only, never upload local edits |
| **Debug Logging** | Writes a daily log under `_KoofrSyncLogs/YYYY-MM-DD.md` (device-local, never synced) |

### Commands

Available via the command palette (`Ctrl/Cmd+P`):

- **Sync now**
- **Disconnect from Koofr**
- **Force full sync (re-download everything)** — clears tracked sync state
- **Reconcile from cloud (cloud-as-truth recovery)** — destructive, cloud always wins, confirmation required for large deletes
- **Show sync conflicts**

## How sync works

Koofr's REST API has no incremental "what changed since X" endpoint (unlike some providers). Every sync fetches one full recursive listing of your chosen Koofr folder in a single request and diffs it against what this device last saw, by content hash — new/changed/deleted files are all detected from that diff. This is simpler than a delta-cursor design and works well for typical vault sizes (hundreds to low thousands of files); very large vaults will see proportionally larger listing payloads each sync.

## Known limitations / not yet verified

- **Large file uploads**: Koofr's upload endpoint takes the whole file in a single request — there's no chunked/resumable upload API to fall back to for very large attachments.
- **Folder auto-creation on upload**: unconfirmed whether Koofr auto-creates missing parent folders when uploading — the plugin checks and creates them explicitly by default (see the "Skip folder existence checks" experimental setting, off by default until this is verified).
- **Token expiry**: Koofr has no documented refresh-token flow. The plugin re-authenticates from your stored email/app password whenever a request returns 401 — this hasn't been stress-tested against real-world token lifetimes yet.
- Only English strings are included for now; the i18n infrastructure supports additional locales (see `src/i18n/`), contributions welcome.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build (typecheck + bundle)
npm test         # unit tests
npm run lint
```

See `src/sync/syncEngine.ts` for the sync algorithm and `src/api/koofrClient.ts` for the Koofr REST API v2 wrapper.

## License

MIT — see [LICENSE](LICENSE). Architecture adapted from [obsidian-onedrive](https://github.com/jeffsteinbok/obsidian-onedrive) (also MIT).
