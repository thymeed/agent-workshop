# Cursor Agents · Model Routing Dashboard

Guidance for AI agents working in this repo.

## What this is

A **Cursor Agents** model-routing dashboard: visualize how a session routes work across parent (Opus), advisor (Fable), worker (Sonnet), and explorer/researcher (Haiku).

The workshop stage and station cards use **pixel-cast block agents** (rect sprites, station pads/shelves, merge portal) under **Cursor Agents** branding — not Claude Code product UI.

Stack:

- **HTML UI** — `model-routing-dashboard.html` (Demo + Live)
- **Live bridge** — `live-bridge.js` (Node localhost server; tails agent-transcripts JSONL, SSE)
- **Electron desktop** — windowed app; bridge runs in-process (`npm start` / packaged `.exe`)

Chrome: header **Stage | Insights | History** selects which **drawer sheet** owns the lower panel (workshop stage stays visible). **Stations**, Bill, Activity, Log, and playful **Insights** sheets live under the stage. **Replay** (History) drives the stage via `replay-stage.js` (play/pause/scrub/speed). **HUD** chips are the single status strip (session $, active role, subs, effort, haiku tokens). **TipLayer** (`tips.js`) covers chrome, stage, cards, Insights, History, and alerts via `data-tip` / `data-tip-detail`.

## Key files

| File                           | Role                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `model-routing-dashboard.html` | Dashboard markup shell (Demo + Live; Stage/Insights/History chrome)                                         |
| `dashboard/styles.css`         | Dashboard styles                                                                                            |
| `dashboard/cards.css`          | Station card / avatar / ship-celebration styles                                                             |
| `dashboard/insights.css`       | Insights / History drawer styles                                                                            |
| `dashboard/tips.css`           | TipLayer floating tooltip styles                                                                            |
| `dashboard/alerts.css`         | Alert center bell / popover styles                                                                          |
| `dashboard/app.js`             | Demo playbook + Live SSE client + workshop stage + Live presence + inbound route tokens                     |
| `dashboard/insights.js`        | Insights forecast + cost-ranked suggestions + History/Replay UI                                             |
| `dashboard/replay-stage.js`    | Replay transport → workshop stage (crates/characters)                                                       |
| `dashboard/cards.js`           | Station cards, pixel-cast `faceMarkup` / `blockAgentSvgInner`, daily stats, privacy meter, ship celebration |
| `dashboard/tips.js`            | Unified TipLayer (`data-tip` / `data-tip-detail`)                                                           |
| `dashboard/alerts.js`          | In-app alert center (SSE `alert` + `GET /api/alerts`; mini faces via `AgentCards.faceMarkup`)               |
| `live-bridge.js`               | Headless bridge: HTML + `/dashboard/*` + `/api/stream`, `/api/events`, `/api/status`, `/api/alerts`         |
| `start-live.cmd`               | Windows CLI fallback to start the bridge with a visible console                                             |
| `package.json`                 | Electron/desktop scripts + lint/test/ci                                                                     |
| `scripts/copy-exe.js`          | After `build`/`pack`: copy **portable** `dist/AgentWorkshop.exe` → repo-root (never win-unpacked)           |
| `electron/main.js`             | Desktop window; start bridge in-process                                                                     |
| `test/demo-smoke.test.js`      | Demo-mode smoke (Playwright)                                                                                |
| `test/cards-smoke.test.js`     | Station cards / avatars / Live timing smoke                                                                 |
| `test/insights-smoke.test.js`  | Insights / suggestions / jump-to-agent smoke                                                                |
| `.github/workflows/ci.yml`     | Lint, format check, smoke test, packaging check                                                             |
| `README.md`                    | User-facing run instructions and Live-mode limits                                                           |

## How to run

**Desktop (primary):**

```bat
npm start
```

Opens the dashboard window. Bridge runs **in-process** (no separate CMD popup).

**Packaged root exe** (after `npm run pack` or `npm run build`):

```bat
AgentWorkshop.exe
```

Copied to the repo root by `scripts/copy-exe.js` from `dist\AgentWorkshop.exe` (portable only — never `win-unpacked`). Gitignored `*.exe` / `dist/`. Same silent GUI as Electron — no CMD popup.

**Local bloat:** `dist\`, root `*.exe`, and builder caches are rebuildable (`npm run pack`). Safe to delete; prefer keeping `node_modules` unless doing a deliberate `npm ci`. See README “Local disk cleanup”.

**Headless / browser:**

```bat
node live-bridge.js
```

Or double-click `start-live.cmd`. Open `http://127.0.0.1:3847/` and use **Live**.

Options: `--port N`, `--dir <agent-transcripts path>` (or `CURSOR_TRANSCRIPTS`).

**Demo vs Live**

- **Demo** — open `model-routing-dashboard.html` via `file://` or the bridge; Play runs a scripted routing story. No server required for Demo alone.
- **Live** — needs the bridge; streams near-real events from `~/.cursor/projects/.../agent-transcripts/**/*.jsonl`.

**Live presence** (hint + stage banner; `data-live-presence` on `#app`):

| State           | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `file-origin`   | Opened via `file://` — coach to use Electron or `http://127.0.0.1:port/` |
| `connecting`    | SSE connecting                                                           |
| `bridge-down`   | SSE failed — banner + manual Reconnect (no auto-reconnect loop)          |
| `no-projects`   | Bridge up but no Cursor projects found                                   |
| `quiet-healthy` | Connected, no recent events — idle workshop, not an error                |
| `streaming`     | Active transcript traffic                                                |

Dismissible first-Live coach sheet uses `localStorage` `ca.liveOnboard.v1` (never blocks Demo).

**Product surfaces (keep in mind when editing):**

- **Pixel-cast block agents** — stage `#char-*`, Stations avatars, Insights empty states, and alerts share rect-body + square-eye sprites via `AgentCards.faceMarkup` / `blockAgentSvgInner`. Role is **fill color only** (no round faces, blush, chrome, or mouths). Stage figures include stub arms/legs; `.avatar-sm` uses compact blocks.
- **History replay sheet** — `#historyReplayHost` mounts Insights replay transport with shared `--insights-*` tokens; History view closes competing drawers, focuses the drawer (grid order + scroll to Play), remounts replay after async Insights load and on drawer reopen; scrub/play drives the stage via `replay-stage.js`.
- **Inbound route tokens** — `stageDirector.spawnRouteToken(role)` flies a mini block-agent glyph along the pulse path into the station on ask/delegate (`animateRoute`); cap concurrent tokens; respect reduced motion / narrow layouts.
- **Cute station characters** — stage figures + card avatars stay soft/Claude-agent-like; keep Cursor Agents naming (Opus / Fable / Worker / Explore / Research).
- **Unique card faces** — Stations avatars (`data-avatar` + `cards.css`) are per-role (tuft/band/hat/glasses accents + real `.avatar-eye` dots), never letter-circle initials (Op/Fb/…). Shared `AgentCards.faceMarkup(role, { size })` builds the markup; `mountAvatar` uses the same path. `.avatar-sm` is for dense rows. Awake open eye dots on every state except `done` / `celebrating` (closed smile arcs). Per-role mouths via CSS for all non-done states; `inferAvatarFromStatus` / `setStatus` drive expression — `setActive` only toggles `.card.active` + timing. Reviewing/Analyzing → `typing` (mouth/pulse animation, eyes stay dots).
- **Per-role mouths** — idle mouths must be _structurally_ different (not one smile arc + stroke tweak): Opus calm wide flat path, Fable deep grin bowl, Worker/Sonnet straight dash line, Explore open U with risers, Research filled o — on stage SVG (`#char-*` + `.agent-mouth-*` in `styles.css`) and Stations card avatars (`cards.css`). Accents (crown/star/tool/hat/glasses) stay visible on stage.
- **Inbound route tokens** — `stageDirector.spawnRouteToken(role)` flies a small role-shaped glyph along the pulse path into the station on ask/delegate (`animateRoute`); cap concurrent tokens; respect reduced motion / narrow layouts.
- **History replay sheet** — `#historyReplayHost` mounts Insights replay transport (play/pause/scrub/speed) with shared `--insights-*` tokens; History view focuses the drawer (grid order + scroll) and drives the stage via `replay-stage.js`.
- **TipLayer** (`tips.js`) — one floating tip host for chrome, stage, cards, Insights, History, alerts; prefer `data-tip` / `data-tip-detail` over bare `title=` on primary controls.
- **Alert center** (`alerts.js`) — header bell; bridge SSE `event: alert` + `GET /api/alerts` (name/status/`agentId` only); loads after `cards.js` so rows can show role mini faces via `faceMarkup` + `roleFromAgentHint`; Electron desktop Notification stays on the same emit path.
- **Insights / Stations** — playful Insights forecast + cost-ranked suggestions; Stations drawer hosts living cards; row/alert click → `jumpToAgent` (does not change Cursor routing).
- **Ship celebration** — portal burst + avatar `done` on merge/ship; respect `prefers-reduced-motion`.
- **Live presence** — `data-live-presence` on `#app` (`file-origin` … `streaming`); see table above.

## Conventions

- Brand as **Cursor Agents**, not Claude Code (pixel-cast block agents are fine; do not relabel the product as Claude Code).
- Desktop exe: **no CMD popups** — keep the live bridge in-process inside Electron; root portable exe is the primary packaged launch path.
- After user-facing UI/desktop changes, refresh repo-root **`AgentWorkshop.exe`** via `npm run pack` (portable) or `npm run build` (`scripts/copy-exe.js` — portable only, never naked win-unpacked). `*.exe` is gitignored — still copy locally for the user (see `.cursor/rules/refresh-desktop-exe.mdc`).
- Keep `live-bridge.js` **reusable** from CLI and from Electron (same module/API surface).
- Prefer **minimal dependencies** (bridge today is Node stdlib only).
- **Do not commit secrets** (`.env*`, tokens, credentials). Ignore `dist/`, `*.exe`, and `node_modules` via `.gitignore`. Local `dist\` / stale exes are safe to delete and rebuild from git + npm.
- Before **commit + push** of product changes, run a **quick Advisor** go/fix gate (`.cursor/rules/advisor-before-commit-push.mdc`). Advisor instructions + CI foresight (lint, `format:check`, smoke, packaging) live in **`.cursor/agents/advisor.md`** (workflow: `.github/workflows/ci.yml`).

## Limits (don’t “fix” these away casually)

- Near-real file polling, not hook-level realtime.
- Token deltas are illustrative estimates from transcript activity.
- Only sees chats that write into the configured transcripts folder.
- Live bridge is localhost-only (loopback bind + Host/Origin checks pinned to bridge port; no CORS `*`; `Origin: null` rejected). Live from `file://` is unsupported — open `http://127.0.0.1:<port>/` or Electron.
- `/api/select` is POST-only with `X-Cursor-Bridge: 1`, plus Sec-Fetch-Site `same-origin`/`none` or a valid localhost Origin (blocks cross-site simple requests).
