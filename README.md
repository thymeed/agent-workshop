# Cursor Agents · Model Routing

Desktop dashboard for visualizing how a Cursor Agents session routes work across Opus (parent), Fable (advisor), Worker (Sonnet), Explorer / Researcher (Haiku).

**Primary product:** double-click the Windows GUI `.exe`, or run `npm start`. Window title: **Cursor Agents · Model Routing**. The live bridge runs **in-process** inside Electron — no CMD popup, no separate `node.exe` console.

A second launch focuses the existing window (single-instance lock); it does not start another bridge on the same port.

## Install & start (development)

```bat
cd /d "C:\Users\louje\OneDrive\Desktop\Custom TUI"
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

In the window, **Live** mode shows a **project** dropdown fed by `~/.cursor/projects/*/agent-transcripts` (newest first by default). Choosing another project calls `/api/select` and the SSE stream emits `reset` so the session view clears and resyncs.

## Build / run the Windows `.exe` (silent GUI)

```bat
npm run build
```

Artifacts in `dist\`:

| File | Use |
| --- | --- |
| `CursorAgentsModelRouting-Portable.exe` | Portable GUI app — double-click, no install |
| `Cursor Agents Model Routing Setup x.x.x.exe` | Optional NSIS installer |

Packaged apps use the Windows GUI subsystem: **no console window** on launch. There is no `.cmd` wrapper.

Faster unpackaged build:

```bat
npm run pack
```

Then run `dist\win-unpacked\Cursor Agents Model Routing.exe`.

## Demo mode (static HTML fallback)

No server required:

1. Open `model-routing-dashboard.html` in a browser (`file://`).
2. Leave **Demo** selected and click **Play**.

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

Options:

```bat
node live-bridge.js --port 3847
node live-bridge.js --dir "C:\Users\<you>\.cursor\projects\<project>\agent-transcripts"
```

`CURSOR_BRIDGE_PORT` / `--port` also apply here. `start-live.cmd` is a legacy headless helper only — **not** the primary desktop launch path.

### What Live mode wires

| Source | Use |
| --- | --- |
| `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` | Projects listed in the picker; newest selected by default |
| `GET /api/projects` | Project list + current selection |
| `GET /api/select?id=` | Switch transcripts folder + reset watch state |
| SSE `GET /api/stream` | Events + `reset` when the project changes |
| `GET /api/events`, `GET /api/status` | Debug / backlog |

Roles are inferred from `Task` / `CallDynamicTool` `subagent_type` and subagent prompt text (`advisor`, `worker`, `explore`→explorer, `researcher`). Unknown types map to parent/generic.

### Limits

- Near-real, not hook-level realtime (no Cursor hooks required for this slice).
- Read Bill token deltas are **estimates** from transcript activity, not official usage metering.
- Only sees chats that write into the selected transcripts folder.
- Hooks / statusline / Cursor SDK are complementary paths; this slice uses transcripts on disk.
