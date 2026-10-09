# Cursor Agents · Model Routing Dashboard

Guidance for AI agents working in this repo.

## What this is

A **Cursor Agents** model-routing dashboard: visualize how a session routes work across parent (Opus), advisor (Fable), worker (Sonnet), and explorer/researcher (Haiku).

Stack (target):

- **HTML UI** — `model-routing-dashboard.html` (Demo + Live)
- **Live bridge** — `live-bridge.js` (Node localhost server; tails agent-transcripts JSONL, SSE)
- **Electron desktop** — windowed app that runs the bridge in-process (scaffold may land via `package.json` + Electron main)

This is **Cursor Agents** branding/product framing, not Claude Code product UI.

## Key files

| File                           | Role                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `model-routing-dashboard.html` | Dashboard markup shell (Demo + Live)                                                        |
| `dashboard/styles.css`         | Dashboard styles (extracted from the former monolith)                                       |
| `dashboard/app.js`             | Demo playbook + Live SSE client + workshop stage                                            |
| `live-bridge.js`               | Headless bridge: serves HTML + `/dashboard/*` + `/api/stream`, `/api/events`, `/api/status` |
| `start-live.cmd`               | Windows CLI fallback to start the bridge with a visible console                             |
| `package.json`                 | Electron/desktop scripts + lint/test/ci                                                     |
| `electron/main.js`             | Desktop window; start bridge in-process                                                     |
| `test/demo-smoke.test.js`      | Demo-mode smoke (Playwright)                                                                |
| `.github/workflows/ci.yml`     | Lint, format check, smoke test, packaging check                                             |
| `README.md`                    | User-facing run instructions and Live-mode limits                                           |

## How to run

**Desktop (once Electron scaffold exists):**

```bat
npm start
```

Opens the dashboard window. Bridge should run **in-process** (no separate CMD popup).

**Headless / browser (works today, no npm install):**

```bat
node live-bridge.js
```

Or double-click `start-live.cmd`. Open `http://127.0.0.1:3847/` and use **Live**.

Options: `--port N`, `--dir <agent-transcripts path>` (or `CURSOR_TRANSCRIPTS`).

**Demo vs Live**

- **Demo** — open `model-routing-dashboard.html` via `file://` or the bridge; Play runs a scripted routing story. No server required for Demo alone.
- **Live** — needs the bridge; streams near-real events from `~/.cursor/projects/.../agent-transcripts/**/*.jsonl`.

If `package.json` is missing, prefer `node live-bridge.js` / `start-live.cmd` until the Electron scaffold is present; then use `npm start` for the desktop window.

## Conventions

- Brand as **Cursor Agents**, not Claude Code.
- Desktop exe: **no CMD popups** — keep the live bridge in-process inside Electron.
- Keep `live-bridge.js` **reusable** from CLI and from Electron (same module/API surface).
- Prefer **minimal dependencies** (bridge today is Node stdlib only).
- **Do not commit secrets** (`.env*`, tokens, credentials). Ignore build/`node_modules` via `.gitignore`.

## Limits (don’t “fix” these away casually)

- Near-real file polling, not hook-level realtime.
- Token deltas are illustrative estimates from transcript activity.
- Only sees chats that write into the configured transcripts folder.
