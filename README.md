# Cursor Agents · Model Routing

[![CI](https://github.com/thymeed/agent-workshop/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/thymeed/agent-workshop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-informational)](CHANGELOG.md)

Desktop dashboard that shows how a Cursor Agents session routes work across Opus (parent), Fable (advisor), Worker (Sonnet), and Explorer / Researcher (Haiku).

![Demo workshop stage: block agents at stations, merge portal, and session HUD](docs/preview.png)

See [CHANGELOG.md](CHANGELOG.md) for release notes.

### Workshop overview

The main viewport is an agent workshop: five pixel-cast block agents at fixed stations (Opus desk, Fable consult, Sonnet build, Explore / Research shelves). Agents walk paths and carry code crates into a central Merge portal. On ask or delegate, a small inbound route token (mini block sprite) travels along the pulse path into the target station.

- **Avatars.** Rect body and square eyes. Role is fill color only: no mouths, round faces, or letter initials.
- **Chrome.** Header Stage | Insights | History picks which drawer sheet owns the lower panel. The workshop stage stays visible.
- **Drawers.** Session Bill, Activity, Insights, History/Replay, Session Log, and Stations under the stage.
- **HUD.** Session cost, active role, subagents, effort, and Haiku token chips.
- Demo scripted Play and Live SSE both drive the stage. History replay (play / pause / scrub / speed) uses the same workshop engine. Leaving History stops transport and leaves the last replay frame until Demo or Live runs again.
- Token and session figures are illustrative, not official Cursor billing.
- Optional Web Audio cues are muted by default. Use the header sound toggle (stored in `localStorage`). Alert **snooze** also silences workshop audio and desktop toasts until you un-snooze, and stays in effect across an app restart.

### Primary launch

Double-click repo-root `AgentWorkshop.exe` (from `npm run pack` or `npm run build` via `scripts/copy-exe.js`; gitignored `*.exe`), or run `npm start` while developing. Window title: Cursor Agents · Model Routing. The live bridge runs in-process in Electron. No CMD window and no separate `node.exe` console.

A second launch focuses the existing window (single-instance lock) and does not bind another bridge on the same port.

## Install and start (development)

```bat
cd /d path\to\agent-workshop
npm install
npm start
```

- Opens the Electron window only (`electron .`).
- Bridge listens on `http://127.0.0.1:3847/` in the same process.
- Optional port override: set `CURSOR_BRIDGE_PORT` before `npm start` (default `3847`).

```bat
set CURSOR_BRIDGE_PORT=3848
npm start
```

### Live project picker

In Live mode, a project dropdown lists Cursor projects that have `~/.cursor/projects/<id>/agent-transcripts` (newest activity first by default).

Choosing a project:

1. `POST`s `/api/select` with `X-Cursor-Bridge: 1` and switches the bridge transcripts folder.
2. Opens the History sheet and reloads Insights onto the latest non-empty transcript session for that project (`latestSessionId` from the bridge).
3. Remounts the History replay transport and restarts Live SSE (`reset` resyncs the workshop; it does not remount History replay or move the scrubber by itself).

While Live is connected, loading a session into History (project change or session picker) paints the replay frame on the stage but does not pause Live SSE until you scrub the timeline or press Play. Scrub or Play sets replay ownership so Live events no longer overwrite the stage until you leave History or run Demo/Live again.

## Build and run the Windows `.exe` (silent GUI)

```bat
npm run pack
```

Builds the portable single-file exe and copies it to repo-root `AgentWorkshop.exe` (via `scripts/copy-exe.js`). Double-click that root file. No install, no sibling DLLs.

Full portable + NSIS installer pass:

```bat
npm run build
```

| File                                          | Use                                       |
| --------------------------------------------- | ----------------------------------------- |
| `AgentWorkshop.exe` (repo root)               | Primary launch: portable GUI, no install  |
| `dist\AgentWorkshop.exe`                      | Same portable artifact before/after copy  |
| `Cursor Agents Model Routing Setup x.x.x.exe` | Optional NSIS installer (`npm run build`) |

Packaged apps use the Windows GUI subsystem: no console window on launch. There is no `.cmd` wrapper.

Do not copy `dist\win-unpacked\*.exe` to the repo root alone. That naked Electron binary needs `ffmpeg.dll` beside it. Use `npm run pack:dir` only to inspect an unpacked tree locally.

### Local disk cleanup (safe, rebuildable)

Git already ignores `dist/`, `*.exe`, and `node_modules/`. Source of truth is GitHub + `npm install` / `npm run pack`. Safe to delete locally anytime:

- Entire `dist\` folder (unpacked trees, portable duplicates, NSIS setup, blockmaps)
- Stale root `AgentWorkshop.exe` / legacy `*Portable*.exe` (recreate with `npm run pack`)
- Electron/builder caches under `%LOCALAPPDATA%\electron*` / `%LOCALAPPDATA%\electron-builder*` if you are reclaiming a lot of space (next pack re-downloads)

Keep `node_modules\` unless you are ready for a full `npm ci` / `npm install` (large reinstall). Never delete `.git` or source files.

## Project layout

| Path                           | Role                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `model-routing-dashboard.html` | Markup shell (Demo + Live UI)                                        |
| `dashboard/styles.css`         | Dashboard styles                                                     |
| `dashboard/cards.css`          | Station card / avatar / ship-celebration styles                      |
| `dashboard/insights.css`       | Insights / History drawer styles                                     |
| `dashboard/tips.css`           | TipLayer floating tooltip styles                                     |
| `dashboard/alerts.css`         | Alert center bell / popover styles                                   |
| `dashboard/app.js`             | Demo playbook, Live SSE client, workshop stage, Live presence        |
| `dashboard/insights.js`        | Insights forecast, cost-ranked suggestions, History/Replay UI        |
| `dashboard/replay-stage.js`    | Replay transport to workshop stage                                   |
| `dashboard/cards.js`           | Station cards, avatars, daily stats, privacy meter, ship celebration |
| `dashboard/tips.js`            | Unified TipLayer (`data-tip` / `data-tip-detail`)                    |
| `dashboard/alerts.js`          | In-app alert center (SSE `alert` + `GET /api/alerts`)                |
| `live-bridge.js`               | Headless/Electron bridge (HTML + `/dashboard/*` + APIs)              |
| `electron/main.js`             | Desktop window; starts bridge in-process                             |
| `test/demo-smoke.test.js`      | Demo-mode Playwright smoke test                                      |
| `test/cards-smoke.test.js`     | Station cards / avatars / Live timing smoke                          |
| `test/insights-smoke.test.js`  | Insights / suggestions / jump-to-agent smoke                         |

## Demo mode (static HTML fallback)

No server required:

1. Open `model-routing-dashboard.html` in a browser (`file://`). Relative links load `dashboard/styles.css` and `dashboard/app.js`.
2. Leave Demo selected and click Play. Watch the workshop narrative: asks, then explore/research, then worker edit, then advisor, then ship.
3. Click a character to filter Activity. Click the Merge portal to open Activity. Use Panels for Bill, Log, and Insights (Stage view). Switch Insights or History for forecast or replay. On History, play / pause / scrub / speed drives the workshop stage. Optional sound: header mute toggle.

## Lint, format, test

```bat
npm install
npm run lint
npm run format:check
npm test
npm run build:check
```

Or `npm run ci` for the same sequence. `npm test` needs Playwright Chromium once: `npx playwright install chromium`.

## Headless bridge (optional)

For browser-only Live mode without Electron:

```bat
npm run bridge
```

or:

```bat
node live-bridge.js
```

Then open http://127.0.0.1:3847/ and click Live.

The bridge listens on loopback only and rejects non-localhost `Host` / foreign `Origin` (including `Origin: null`; no `Access-Control-Allow-Origin: *`). Open the dashboard from the bridge URL or Electron, not from another website. Demo via `file://` does not need the bridge. Clicking Live from `file://` points at the client default `http://127.0.0.1:3847/` (file pages cannot read `CURSOR_BRIDGE_PORT` / `--port`).

Options:

```bat
node live-bridge.js --port 3847
node live-bridge.js --dir "C:\Users\<you>\.cursor\projects\<project>\agent-transcripts"
```

`CURSOR_BRIDGE_PORT` / `--port` also apply here. `start-live.cmd` is a legacy headless helper only. It is not the primary desktop launch path.

### What Live mode wires

| Source                                              | Use                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` | Projects listed in the picker; newest selected by default                   |
| `GET /api/projects`                                 | Project list + current selection                                            |
| `POST /api/select` + `X-Cursor-Bridge: 1`           | Switch transcripts folder + reset watch state (JSON `{id}`; Sec-Fetch-Site) |
| SSE `GET /api/stream`                               | Events + `reset` when the project changes; also `event: alert`              |
| `GET /api/alerts`                                   | Last ~50 in-memory alerts (`{ id, ts, name, status, agentId? }`)            |
| `GET /api/events`, `GET /api/status`                | Debug / backlog                                                             |
| `GET /api/history?since=&session=`                  | Persisted history events (JSONL-backed; localhost Host/Origin guards)       |
| `POST /api/history/clear` + `X-Cursor-Bridge: 1`    | Wipe local history (`{"ok":true}`)                                          |

Roles are inferred from `Task` / `CallDynamicTool` `subagent_type` and subagent prompt text (`advisor`, `worker`, `explore` maps to explorer, `researcher`). Unknown types map to parent/generic.

### Live presence

The Live UI tracks a single presence state for the header hint, stage banner, and empty copy:

| State           | What you see                                                                            |
| --------------- | --------------------------------------------------------------------------------------- |
| `file-origin`   | Coach: open Electron or `http://127.0.0.1:<port>/` (Live from `file://` is unsupported) |
| `connecting`    | Soft connecting banner                                                                  |
| `bridge-down`   | Persistent banner + Reconnect (manual; no auto-reconnect loop)                          |
| `no-projects`   | Coach when the picker has no Cursor projects                                            |
| `quiet-healthy` | Connected with no recent events. Idle workshop, not an error.                           |
| `streaming`     | Active traffic + project chip                                                           |

First time you enter Live, a dismissible coach sheet explains the project picker, what Live sees, and the estimate disclaimer (`localStorage` `ca.liveOnboard.v1`). Demo is never blocked.

### Insights, stations, and jump-to-agent

The Insights sheet shows a session forecast, cost-ranked Suggestions, and TipLayer help text. Suggestions sort by estimated dollar savings, then name. Clicking a row or an alert with a mappable agent runs `jumpToAgent`: it selects that station's block agent on the stage, opens Activity, and briefly highlights the card. The Stations drawer lists agent cards with pixel-cast block avatars, daily stats, and a privacy meter. None of this changes Cursor routing. It only navigates the dashboard.

### TipLayer and ship celebration

Chrome, stage stations, HUD chips, station cards, Insights, History/Replay, and the alert center share one TipLayer hover/focus tip (`data-tip` / `data-tip-detail`, ~300ms delay). Prefer that over bare `title=` on primary controls. Ship / merge plays a short portal celebration and marks avatars done (respects `prefers-reduced-motion`).

### History replay and project scope

History and `GET /api/history` show events for sessions that exist under the currently selected project's `agent-transcripts` tree. The bridge filters persisted history to those session IDs. If the folder is empty or has no JSONL yet, History shows no events for that project.

Replay transport lives in the History sheet and shares Insights replay UI. In Live mode, see Live project picker above for when SSE keeps streaming versus when replay takes the stage.

### Local event log and desktop alerts

The bridge also keeps a local event log (JSONL) under the OS app-data profile, not in the git repo:

| Platform | Default path                                                                |
| -------- | --------------------------------------------------------------------------- |
| Windows  | `%APPDATA%\cursor-agents-model-routing\event-log.jsonl`                     |
| macOS    | `~/Library/Application Support/cursor-agents-model-routing/event-log.jsonl` |
| Linux    | `~/.local/share/cursor-agents-model-routing/event-log.jsonl`                |

Overrides: `CURSOR_EVENT_LOG` (file) or `CURSOR_EVENT_LOG_DIR` (directory). Entries older than 30 days are pruned when the bridge starts. Values that look like API keys, tokens, passwords, or bearer secrets are redacted before write.

History event contract (stable):

```json
{
  "ts": "2026-01-01T00:00:00.000Z",
  "sessionId": "string",
  "agentId": "string",
  "parentId": null,
  "name": "string",
  "model": "string",
  "type": "spawn",
  "inputTokens": 0,
  "outputTokens": 0,
  "files": []
}
```

`type` is one of `spawn` | `turn` | `done` | `error`.

When an agent finishes, errors, or stalls (no activity for about 2 minutes), the bridge:

1. Broadcasts SSE `event: alert` with `{ id, ts, name, status, agentId? }` and keeps the last ~50 for `GET /api/alerts`.
2. In Electron, also fires a desktop Notification (name + status only).

The in-app alert center (header bell) lists the same alerts: mark read, snooze, clear, click to jump when a role/agent is mappable. Mappable roles show a small block-agent avatar beside the status (same cast as Stations, never letter initials). Alerts show only agent name and status, never prompt text or file paths. Backlog/SSE replay quiet gates skip spam the same way card timing does.

### Limits

- Near-real, not hook-level realtime (no Cursor hooks required for this slice).
- SESSION BILL is transcript-estimated tokens times published rates per 1M input/output: Opus $4/$20, Sonnet $2/$10, Haiku $0.10/$0.50, Fable $10/$50. Estimates are illustrative, not official Cursor invoices.
- ACTIVITY preview lists reads and edits from the transcript (path + short detail). It does not include full file contents.
- Only sees chats that write into the selected project's transcripts folder.
- History API responses omit events whose `sessionId` is not present under the current transcripts tree.
- Hooks, statusline, and Cursor SDK are separate integration paths. This dashboard reads transcripts on disk.
