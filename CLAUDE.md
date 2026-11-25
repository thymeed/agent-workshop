# Cursor Agents · Model Routing Dashboard

Guidance for AI agents working in this repo.

## What this is

A **Cursor Agents** model-routing dashboard: visualize how a session routes work across parent (Opus), advisor (Fable), worker (Sonnet), and explorer/researcher (Haiku).

The workshop stage and station cards use **pixel-cast block agents** (rect sprites, station pads/shelves, merge portal) under **Cursor Agents** branding.

Stack:

- **HTML UI.** `model-routing-dashboard.html` (Demo + Live)
- **Live bridge.** `live-bridge.js` (Node localhost server; tails agent-transcripts JSONL, SSE). In Claude Code mode (the default) it selects the newest project when none is selected (at start and on a switch to Claude Code; a pick is never overridden), and tails the selected project's newest session (`lib/claude-code-ingest.js`) and streams its rows as events: the first catch-up is a silent replay (rows marked `replay`, no alerts, not counted in today's stats, no ship celebration, no fastest timing), and the live phase starts only after a poll whose ingest facts say the parent was read to its end with nothing capped or waiting; only later finish/error rows alert; a new session clears the stage and replays; the Cursor event log is never written, and the Cursor History API stays off there (the History sheet instead lists the project's older sessions from the last 14 days, read-only, replay only)
- **Electron desktop.** Windowed app; bridge runs in-process (`npm start` / packaged `.exe`).

Chrome: header **Stage | Insights | History** selects which **drawer sheet** owns the lower panel (workshop stage stays visible). **Stations**, Bill, Activity, Log, **Insights**, and **History** sheets live under the stage. **Replay** (History) drives the stage via `replay-stage.js` (play/pause/scrub/speed). **HUD** chips are the single status strip (session $, active role, subs, effort, haiku tokens). **TipLayer** (`tips.js`) covers chrome, stage, cards, Insights, History, and alerts via `data-tip` / `data-tip-detail`.

## Key files

The per-file table lives in [docs/agent/key-files.md](docs/agent/key-files.md). Read it when you need to know which file owns a feature or which test pins it. Main entry points: `model-routing-dashboard.html` (markup), `dashboard/app.js` (Demo + Live client), `live-bridge.js` (bridge), `lib/claude-code-*.js` (Claude Code source), `electron/main.js` (desktop), `test/` (smoke + unit).

Parser decisions (dedupe key, model rank, usage maximum, row ids vs raw ids) are in [docs/agent/parser-decisions.md](docs/agent/parser-decisions.md); read them before changing `lib/claude-code-parse.js`.

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

Copied to the repo root by `scripts/copy-exe.js` from `dist\AgentWorkshop.exe` (portable only, never `win-unpacked`). Gitignored `*.exe` / `dist/`. Same silent GUI as Electron, no CMD popup.

**Local bloat:** `dist\`, root `*.exe`, and builder caches are rebuildable (`npm run pack`). Safe to delete; prefer keeping `node_modules` unless doing a deliberate `npm ci`. See README "Local disk cleanup".

**Headless / browser:**

```bat
node live-bridge.js
```

Or double-click `start-live.cmd`. Open `http://127.0.0.1:3847/` and use **Live**.

Options: `--port N`, `--dir <agent-transcripts path>` (or `CURSOR_TRANSCRIPTS`). The bridge starts on the Claude Code source (`DEFAULT_SOURCE` in `live-bridge.js`, same as the page default); naming a Cursor folder with `--dir` / `CURSOR_TRANSCRIPTS` starts it on Cursor instead, and that folder wins for the run: `hello` and `/api/status` carry `explicitDir: true` (boolean only), and the page then shows Cursor without POSTing a switch or writing the stored choice (a click on Claude Code still switches and stores).

**Demo vs live**

- **Demo.** Open `model-routing-dashboard.html` via `file://` or the bridge; Play runs a scripted routing story. No server required for Demo alone.
- **Live.** Needs the bridge. Default source is Claude Code (newest session of the selected project under `~/.claude/projects`, Windows and WSL); the Cursor source streams near-real events from `~/.cursor/projects/.../agent-transcripts/**/*.jsonl`.

**Live presence and product surfaces:** the presence-state table and the notes on block agents, Claude Code History, History replay, route tokens, TipLayer, alerts, snooze, Insights, ship celebration and the SSE connect backlog are in [docs/agent/product-surfaces.md](docs/agent/product-surfaces.md). Read it before editing those areas.

## Conventions

- Brand as **Cursor Agents** (pixel-cast block agents).
- Desktop exe: **no CMD popups.** Keep the live bridge in-process inside Electron; root portable exe is the primary packaged launch path.
- After user-facing UI/desktop changes, refresh repo-root **`AgentWorkshop.exe`** via `npm run pack` (portable) or `npm run build` (`scripts/copy-exe.js`, portable only, never naked win-unpacked). `*.exe` is gitignored; still copy locally for the user.
- Keep `live-bridge.js` **reusable** from CLI and from Electron (same module/API surface).
- Prefer **minimal dependencies** (bridge today is Node stdlib only).
- **Do not commit secrets** (`.env*`, tokens, credentials). Ignore `dist/`, `*.exe`, and `node_modules` via `.gitignore`. Local `dist\` / stale exes are safe to delete and rebuild from git + npm.
- Before **commit + push** of product changes, run the full local gate: `npm run ci` (ESLint, `format:check`, smoke tests, packaging check). That is the pre-push gate; `.github/workflows/ci.yml` re-runs the same sequence on Ubuntu, Windows, and macOS, plus an unpacked packaging build per platform.
- **Cross-platform builds.** `npm run build` targets the current platform; `npm run pack:win` / `pack:mac` / `pack:linux` target one explicitly, and `npm run pack` is the Windows portable shortcut. macOS and Linux artifacts are produced but unsigned.
- **Node 24** (active LTS) is the supported runtime, declared as `engines.node` in `package.json`. CI runs it on all three platforms.
- The repo is named **`agent-workshop`** while the product keeps the **Cursor Agents · Model Routing** name (`model-routing-dashboard.html`, appId `com.cursor.agents.model-routing`, the window/product name, and the `cursor-agents-model-routing` app-data folder). That split is deliberate; do not "fix" it into one name.

## Limits (don't "fix" these away casually)

**Cursor format facts, checked against real transcripts on disk (2026-10-16).** These are not
assumptions; they are what the files contain. `test/unit/real-transcript-format.test.js`
locks them, and `test/fixtures/transcripts/real/` holds the shape.

- There are exactly **two line shapes**: `{role, message}` conversation lines and
  `{type:"turn_ended", status, error?}` terminals. Nothing else.
- There is **no timestamp field** and **no `usage` block**. Time is prose inside the user
  text; tokens are estimated from character counts. Any code claiming a real usage count
  is wrong.
- The **old hand-written fixtures under `test/fixtures/transcripts/` describe a shape that
  does not exist** (`"timestamp"`, `"type":"user"`, `"usage"`, `"input_tokens"`). They are
  kept because they exercise the tolerant parser paths, not because they are real. Do not
  treat them as the format.
- A real delegation carries **no child agent id**, so the parent-side `spawn` row cannot be
  keyed to a child. The subagent's own transcript supplies its spawn row.
- The model slug lives at `input.arguments.model` on a `Task` call and **nowhere else**. A
  subagent transcript never records its own model, and only about a third of delegations
  name one at all (99 of 149 `Task` calls in a corpus audit carried no `model` key).

**Claude Code format facts** (`lib/claude-code-parse.js`; the shapes are pinned by `test/unit/claude-code-format.test.js`):

- Lines carry real timestamps (read through the shared `transcriptTimestamp`) and real `usage`. Usage is counted as the running maximum per `message.id`, listed below.
- Delegation uses the `Agent` tool. Its launch result has status `async_launched`.
- Completion arrives as a `<task-notification>` block inside `queue-operation` content. The same notification can repeat, and the parser counts it once.
- Claude Code usage (`lib/claude-code-parse.js`): per `message.id` the parser keeps a running maximum, not the last line's value. Intentional: usage only grows across the repeated lines of one id, and a drop comes from a partial line, so the maximum is the final count.

**Cursor source only**

- Token deltas are illustrative estimates from transcript activity.
- Only sees chats that write into the configured transcripts folder (Live project picker / `--dir`). (Claude Code mode reads the selected project under `~/.claude/projects` instead.)
- History ingest and API responses are scoped to session IDs under the current transcripts tree (`filterHistoryToCurrentProject`). (Claude Code mode does not use this API: its History sheet reads `/api/claude/sessions` instead, and `GET /api/history` returns no events there.)

**Both sources**

- Near-real file polling, not hook-level realtime.
- Live bridge is localhost-only (loopback bind + Host/Origin checks pinned to bridge port; no CORS `*`; `Origin: null` rejected). Live from `file://` is unsupported; open `http://127.0.0.1:<port>/` or Electron.
- `/api/select` is POST-only with `X-Cursor-Bridge: 1`, plus Sec-Fetch-Site `same-origin`/`none` or a valid localhost Origin (blocks cross-site simple requests).
- **Privacy words in CI.** `test/unit/fixture-privacy.test.js` also checks owner-specific words (username, sync-folder name). They are never committed: locally they come from gitignored `.privacy-words` or env `PRIVACY_WORDS` (comma-separated); in CI from the `PRIVACY_WORDS` repository secret, passed as `env:` on the `npm test` step and on the step just before it, which splits the secret on commas and masks each word individually (`::add-mask::`) before tests run, because GitHub masks only the whole secret value. GitHub cannot mask words shorter than 3 characters; the mask step prints a warning (without the word) when one is configured. `.privacy-words` is gitignored. Failures report masked file paths and line numbers, never the matched word. When the secret is missing (fork PRs never receive it, or it is not set yet; an empty value counts as missing) the test logs `privacy-words check SKIPPED: no secret` and only the generic path patterns run.
