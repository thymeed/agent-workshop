# Cursor Agents · Model Routing Dashboard

Guidance for AI agents working in this repo.

## What this is

A **Cursor Agents** model-routing dashboard: visualize how a session routes work across parent (Opus), advisor (Fable), worker (Sonnet), and explorer/researcher (Haiku).

Stack:

- **HTML UI** — `model-routing-dashboard.html` (Demo + Live)
- **Live bridge** — `live-bridge.js` (Node localhost server; tails agent-transcripts JSONL, SSE)
- **Electron desktop** — windowed app; bridge runs in-process (`npm start` / packaged `.exe`)

Chrome: header **Stage | Insights | History** selects which **drawer sheet** owns the lower panel (workshop stage stays visible). **Replay** (History) drives the stage via `replay-stage.js` (play/pause/scrub/speed). **HUD** chips are the single status strip (session $, active role, subs, effort, haiku tokens).

This is **Cursor Agents** branding/product framing, not Claude Code product UI.

## Key files

| File                           | Role                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `model-routing-dashboard.html` | Dashboard markup shell (Demo + Live; Stage/Insights/History chrome)                         |
| `dashboard/styles.css`         | Dashboard styles                                                                            |
| `dashboard/insights.css`       | Insights / History drawer styles                                                            |
| `dashboard/app.js`             | Demo playbook + Live SSE client + workshop stage                                            |
| `dashboard/insights.js`        | Insights forecast + History/Replay UI                                                       |
| `dashboard/replay-stage.js`    | Replay transport → workshop stage (crates/characters)                                       |
| `dashboard/cards.js`           | Session Bill / Activity / Log card helpers                                                  |
| `live-bridge.js`               | Headless bridge: serves HTML + `/dashboard/*` + `/api/stream`, `/api/events`, `/api/status` |
| `start-live.cmd`               | Windows CLI fallback to start the bridge with a visible console                             |
| `package.json`                 | Electron/desktop scripts + lint/test/ci                                                     |
| `electron/main.js`             | Desktop window; start bridge in-process                                                     |
| `test/demo-smoke.test.js`      | Demo-mode smoke (Playwright)                                                                |
| `.github/workflows/ci.yml`     | Lint, format check, smoke test, packaging check                                             |
| `README.md`                    | User-facing run instructions and Live-mode limits                                           |

## How to run

**Desktop (primary):**

```bat
npm start
```

Opens the dashboard window. Bridge runs **in-process** (no separate CMD popup).

**Headless / browser:**

```bat
node live-bridge.js
```

Or double-click `start-live.cmd`. Open `http://127.0.0.1:3847/` and use **Live**.

Options: `--port N`, `--dir <agent-transcripts path>` (or `CURSOR_TRANSCRIPTS`).

**Demo vs Live**

- **Demo** — open `model-routing-dashboard.html` via `file://` or the bridge; Play runs a scripted routing story. No server required for Demo alone.
- **Live** — needs the bridge; streams near-real events from `~/.cursor/projects/.../agent-transcripts/**/*.jsonl`.

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
- Live bridge is localhost-only (loopback bind + Host/Origin checks pinned to bridge port; no CORS `*`; `Origin: null` rejected). Live from `file://` is unsupported — open `http://127.0.0.1:<port>/` or Electron.
- `/api/select` is POST-only with `X-Cursor-Bridge: 1`, plus Sec-Fetch-Site `same-origin`/`none` or a valid localhost Origin (blocks cross-site simple requests).
