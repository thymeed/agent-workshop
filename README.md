# Cursor Agents · Model Routing

Desktop dashboard for visualizing how a Cursor Agents session routes work across Opus (parent), Fable (advisor), Worker (Sonnet), Explorer / Researcher (Haiku).

The first viewport is an **agent workshop**: five station characters (Opus desk, Fable consult, Sonnet build, Explore / Research shelves) walk paths and carry code crates into a central **Merge portal**. Demo Play and Live SSE drive the stage; Session Bill, Activity, and Session Log live in drawers under the stage (HUD chips show session $, active role, and subagent count). Optional cute Web Audio blips are **muted by default** — toggle 🔊/🔇 in the header (persisted in `localStorage`).

**Primary product:** double-click the Windows GUI `.exe`, or run `npm start`. Window title: **Cursor Agents · Model Routing**. The live bridge runs **in-process** inside Electron — no CMD popup, no separate `node.exe` console.

A second launch focuses the existing window (single-instance lock); it does not start another bridge on the same port.

## Install & start (development)

```bat
cd /d path\to\cursor-agents-model-routing
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

In the window, **Live** mode shows a **project** dropdown fed by `~/.cursor/projects/*/agent-transcripts` (newest first by default). Choosing another project `POST`s `/api/select` (with `X-Cursor-Bridge`) and the SSE stream emits `reset` so the session view clears and resyncs.

## Build / run the Windows `.exe` (silent GUI)

```bat
npm run build
```

Artifacts in `dist\`:

| File                                          | Use                                         |
| --------------------------------------------- | ------------------------------------------- |
| `CursorAgentsModelRouting-Portable.exe`       | Portable GUI app — double-click, no install |
| `Cursor Agents Model Routing Setup x.x.x.exe` | Optional NSIS installer                     |

Packaged apps use the Windows GUI subsystem: **no console window** on launch. There is no `.cmd` wrapper.

Faster unpackaged build:

```bat
npm run pack
```

Then run `dist\win-unpacked\Cursor Agents Model Routing.exe`.

## Project layout

| Path                           | Role                                                    |
| ------------------------------ | ------------------------------------------------------- |
| `model-routing-dashboard.html` | Markup shell (Demo + Live UI)                           |
| `dashboard/styles.css`         | Dashboard styles                                        |
| `dashboard/app.js`             | Demo playbook, Live SSE client, workshop stage          |
| `live-bridge.js`               | Headless/Electron bridge (HTML + `/dashboard/*` + APIs) |
| `electron/main.js`             | Desktop window; starts bridge in-process                |
| `test/demo-smoke.test.js`      | Demo-mode Playwright smoke test                         |

## Demo mode (static HTML fallback)

No server required:

1. Open `model-routing-dashboard.html` in a browser (`file://`). Relative links load `dashboard/styles.css` and `dashboard/app.js`.
2. Leave **Demo** selected and click **Play** — watch the workshop narrative (asks → explore/research → worker edit → advisor → ship).
3. Click a character to filter Activity; click the Merge portal to open Activity; use **Panels** for Bill & Log; unmute with 🔊 for soft blips.

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

Then open **http://127.0.0.1:3847/** and click **Live**.

The bridge listens on loopback only and rejects non-localhost `Host` / foreign `Origin` (including `Origin: null`; no `Access-Control-Allow-Origin: *`). Open the dashboard from the bridge URL or Electron — not from another website. Demo via `file://` does not need the bridge; clicking **Live** from `file://` points at the client default `http://127.0.0.1:3847/` (file pages cannot read `CURSOR_BRIDGE_PORT` / `--port`).

Options:

```bat
node live-bridge.js --port 3847
node live-bridge.js --dir "C:\Users\<you>\.cursor\projects\<project>\agent-transcripts"
```

`CURSOR_BRIDGE_PORT` / `--port` also apply here. `start-live.cmd` is a legacy headless helper only — **not** the primary desktop launch path.

### What Live mode wires

| Source                                              | Use                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` | Projects listed in the picker; newest selected by default                   |
| `GET /api/projects`                                 | Project list + current selection                                            |
| `POST /api/select` + `X-Cursor-Bridge: 1`           | Switch transcripts folder + reset watch state (JSON `{id}`; Sec-Fetch-Site) |
| SSE `GET /api/stream`                               | Events + `reset` when the project changes                                   |
| `GET /api/events`, `GET /api/status`                | Debug / backlog                                                             |
| `GET /api/history?since=&session=`                  | Persisted history events (JSONL-backed; localhost Host/Origin guards)       |
| `POST /api/history/clear` + `X-Cursor-Bridge: 1`    | Wipe local history (`{"ok":true}`)                                          |

Roles are inferred from `Task` / `CallDynamicTool` `subagent_type` and subagent prompt text (`advisor`, `worker`, `explore`→explorer, `researcher`). Unknown types map to parent/generic.

### History & desktop alerts

The bridge keeps a **local event log** (JSONL) under the OS app-data profile — not in the git repo:

| Platform | Default path                                                                |
| -------- | --------------------------------------------------------------------------- |
| Windows  | `%APPDATA%\cursor-agents-model-routing\event-log.jsonl`                     |
| macOS    | `~/Library/Application Support/cursor-agents-model-routing/event-log.jsonl` |
| Linux    | `~/.local/share/cursor-agents-model-routing/event-log.jsonl`                |

Overrides: `CURSOR_EVENT_LOG` (file) or `CURSOR_EVENT_LOG_DIR` (directory). Entries older than **30 days** are pruned when the bridge starts. Values that look like API keys, tokens, passwords, or bearer secrets are **redacted before write**.

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

In the Electron app, desktop notifications fire when an agent **finishes**, **errors**, or **stalls** (no activity for ~2 minutes). Alerts show **only agent name and status** — never prompt text or file paths.

### Limits

- Near-real, not hook-level realtime (no Cursor hooks required for this slice).
- **SESSION BILL** is transcript-estimated tokens × published rates per 1M input/output: Opus $4/$20, Sonnet $2/$10, Haiku $0.10/$0.50, Fable $10/$50. Estimated · not official Cursor invoices.
- **ACTIVITY** preview lists reads and edits from the transcript (path + short detail). It does not include full file contents.
- Only sees chats that write into the selected transcripts folder.
- Hooks / statusline / Cursor SDK are complementary paths; this slice uses transcripts on disk.
