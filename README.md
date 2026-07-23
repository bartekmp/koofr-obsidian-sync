# Obsidian Koofr Sync

[![CI](https://github.com/bartekmp/koofr-obsidian-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/bartekmp/koofr-obsidian-sync/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sync your Obsidian vault with **[Koofr](https://koofr.eu)** cloud storage. Event-driven, bidirectional, mobile-friendly.

> [!NOTE]
> This plugin is not affiliated with Koofr. It's built against Koofr's public REST API v2. Its architecture (sync engine, conflict resolution, settings UI) is adapted from [obsidian-onedrive](https://github.com/jeffsteinbok/obsidian-onedrive) by Jeff Steinbok.

## Features

- **Zero OAuth setup** — Koofr auth uses just an email + a revocable app-specific password you generate in the Koofr web app. No Azure, no consent screen.
- **Event-driven sync** — Syncs on file changes, not polling. Better for battery life.
- **Bidirectional** — Automatic two-way sync with configurable conflict resolution.
- **Any mount, any folder** — Sync your own Koofr storage or anything shared with you, into any subfolder.
- **Pull-only mode** — (Experimental) One-way sync from Koofr for read-only vaults or backup recovery.
- **Conflict resolution** — Last-write-wins, create-duplicate, or a manual review pane with inline diffs.
- **Mobile-friendly** — Works on iOS and Android; no desktop-only APIs.

## Why this over Koofr's native client or a WebDAV mount?

- **Skips device clutter** — workspace UI state files (`.obsidian/workspace*.json`) are intentionally excluded.
- **Event-driven, not filesystem polling** — reacts to Obsidian vault events directly.
- **Built-in conflict handling** — choose overwrite, duplicate, or manual diff-based resolution.

## Installation

### Community Plugins (recommended)

1. Settings → Community Plugins → Browse → search **"Koofr Sync"**
2. Install → Enable

### Via BRAT (beta / pre-release)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. BRAT settings → **Add Beta Plugin** → `bartekmp/koofr-obsidian-sync`

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/bartekmp/koofr-obsidian-sync/releases/latest)
2. Place them in `<vault>/.obsidian/plugins/koofr-sync/`
3. Settings → Community Plugins → enable **Koofr Sync**

## Setup

1. Generate an app-specific password: Koofr web app → **Profile → Preferences → Password → App passwords**. Your regular Koofr account password will not work — Koofr requires a scoped, revocable app password for third-party connections.
2. In Obsidian: Settings → Koofr Sync → enter your email and the app password → **Connect to Koofr**.
3. Click **Browse…** under Sync Folder, pick a mount (your own Koofr storage or anything shared with you) and a folder within it.
4. Done — your vault syncs automatically on file changes.

### Settings reference

| Setting | Description |
| --- | --- |
| **Sync Interval** | Periodic sync interval. Set to "Manual" to disable timer-based sync. |
| **Sync on file change** | Disable to only sync on the interval or manually. |
| **Startup Sync Delay** | Delay before first sync after launch (0 = disabled, 10 s recommended). |
| **Conflict Resolution** | Last write wins (default), create duplicate, or manual review. |
| **Sync App Settings** | Optional — sync `.obsidian/app.json`, `appearance.json`, `hotkeys.json`. |
| **Sync Plugins** | Optional — sync plugin lists, manifests, and binaries (not plugin data files). |
| **Sync CSS Snippets** | Optional — sync `.obsidian/snippets/`. |
| **Pull-Only Mode** | (Experimental) Download only, never upload local edits. |
| **Debug Logging** | Writes a daily log under `_KoofrSyncLogs/YYYY-MM-DD.md` (device-local, never synced). |

### Commands

Available via the command palette (`Ctrl/Cmd+P`):

| Command | Description |
| --- | --- |
| **Sync now** | Trigger an immediate sync. |
| **Disconnect from Koofr** | Clear stored credentials and sync state. |
| **Force full sync** | Clear tracked state so the next sync re-evaluates everything from scratch. |
| **Reconcile from cloud** | Destructive recovery — cloud version wins for every file, confirmation required for large deletes. |
| **Show sync conflicts** | Open the manual conflict review pane. |

## How sync works

Koofr's REST API has no incremental "what changed since X" endpoint. Every sync fetches a single recursive listing of your chosen Koofr folder and diffs it against what this device last saw, by content hash — new, changed, and deleted files are all detected from that diff. This is simpler than a delta-cursor design and works well for typical vault sizes (hundreds to low thousands of files); very large vaults will produce proportionally larger listing payloads per sync.

## Known limitations

- **Large file uploads**: Koofr's upload endpoint accepts a whole file in a single request — there's no chunked/resumable upload API for very large attachments.
- **Token expiry**: Koofr has no documented refresh-token flow. The plugin re-authenticates from your stored app password whenever a request returns 401.
- **English only**: The i18n infrastructure is in place (`src/i18n/`), but only English strings ship currently. Contributions welcome.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build (typecheck + bundle)
npm test         # unit tests
npm run lint
```

See [src/sync/syncEngine.ts](src/sync/syncEngine.ts) for the sync algorithm and [src/api/koofrClient.ts](src/api/koofrClient.ts) for the Koofr REST API v2 wrapper.

## License

MIT — see [LICENSE](LICENSE). Architecture adapted from [obsidian-onedrive](https://github.com/jeffsteinbok/obsidian-onedrive) (also MIT).
