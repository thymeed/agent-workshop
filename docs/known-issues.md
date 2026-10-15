# Known issues

Audit findings for the dashboard, the alert-snooze work, CI, and the dependency
tree. Each item says whether it is fixed, open, or verified as a non-issue, so
nobody re-litigates a settled question or assumes an open one is closed.

Last reviewed: 2026-10-15.

## Fixed

- **Snooze did not silence the stall sound.**
  The dashboard has no audio path for stalls, so the sound was the Windows
  notification sound from `new Notification({ silent: false })` in
  `electron/main.js`. Snooze only hid the unread badge. Fixed by making snooze
  indefinite: the bridge now skips creating the desktop notification while
  snoozed. The SSE `alert` event and the in-memory ring still flow.

- **Snooze did not survive a restart.**
  The bridge holds snooze in memory and reset it on `stopBridge()`, so a fresh
  bridge started unsnoozed while the renderer's `localStorage` still said
  snoozed, so the dashboard showed snooze active while desktop toasts fired again.
  Fixed by reconciling on load: `hydrate()` in `dashboard/alerts.js` reads
  `GET /api/status` and re-pushes the persisted state. Renderer wins, because
  `localStorage` is the durable user choice.

- **Session Bill `Out` column rendered Sonnet cost instead of output tokens.**
  Fixed; `formatTokens` restored.

- **`POST /api/snooze` with an empty body defaulted to `snoozed: true`.**
  An absent field used to be an affirmative signal: `snoozed` defaulted to `true`
  before the body was read. The route now requires an explicit
  `{ "snoozed": boolean }` and answers 400 otherwise, so intent is always stated.
  Covered by `testSnoozeRouteGuards` in `test/transcript-history.test.js`:
  empty body → 400, non-boolean → 400, invalid JSON → 400, explicit boolean → 200
  with `GET /api/status` agreeing.

- **CI re-downloaded Chromium on every run.**
  `.github/workflows/ci.yml` ran `npx playwright install --with-deps chromium` on
  both jobs with no browser cache, fetching roughly 320 MB per run. Both jobs now
  cache `~/.cache/ms-playwright` (Windows `%USERPROFILE%\AppData\Local\ms-playwright`)
  via `actions/cache`, keyed per runner OS on `package-lock.json`.

- **`package-lock.json` disagreed with `package.json` about the root license.**
  The lock recorded `UNLICENSED` while `package.json` declares `MIT`. Regenerated
  with `npm install --package-lock-only`, which also recorded `engines`.

- **`CLAUDE.md` cited rule files that do not exist.**
  It pointed at `.cursor/rules/refresh-desktop-exe.mdc`,
  `.cursor/rules/advisor-before-commit-push.mdc`, and `.cursor/agents/advisor.md`;
  there is no `.cursor/` directory in the tree. The guidance those files were meant
  to carry is now stated inline in `CLAUDE.md`.

## Open

1. **The alert list still records entries while snoozed.** Only the unread badge
   is hidden. This is inherited master behavior, deliberate in #25, and a product
   decision rather than a defect. Change it only if the list is meant to go quiet
   too.

2. **Snooze reconciliation is last-client-wins, not strictly renderer-wins.**
   A second client with its own `localStorage` (a genuinely separate browser
   profile hitting the bridge URL) will POST `snoozed: false` and silently clear a
   snooze set elsewhere. Same-origin tabs share the key and are unaffected.

3. **`notifyBridge()` is fire-and-forget with no read-back.** A dropped POST
   leaves the bridge out of sync until the next `hydrate()` / reconnect. Accepted
   for now; the reconcile on load covers the common case.

4. **Dependency advisories in the toolchain — including the packaged runtime.**
   `npm audit` on 2026-10-15 reports 18 vulnerabilities (4 moderate, 13 high,
   1 critical). Most are build-time packages, but `electron` is the runtime of the
   packaged desktop app, so its advisories are not purely build-time. Reported:
   `electron` ≤ 41.10.5 (ASAR integrity bypass, sandbox and `contextBridge`
   escapes, protocol-handler cross-origin reads, and more), `electron-builder` /
   `app-builder-lib` ≤ 26.14.0, `builder-util-runtime` < 9.7.0, `extract-zip`,
   `sprintf-js` (via `@electron/get`), and `tar` ≤ 7.5.20 — the critical one,
   reached through `electron-builder`. `npm audit fix --force` clears them by
   installing `electron@44.7.2` and `electron-builder@26.15.3`, both breaking major
   jumps from the current `electron@^33`. This is its own piece of work: upgrade,
   then re-verify the in-process bridge, the single-instance lock, desktop
   notifications, and a real `npm run pack`.

## Verified as non-issues

- **A `Â·` seen in shell output was not file corruption.** The middle-dot
  separator renders correctly in the tracked files; the artifact was the shell's
  console encoding.

- **There is no in-app stall audio path.** `app.js` owns the only Web Audio
  module, and no `sound.play()` call site fires on a stall. `cards.js` "Stalled"
  is a visual avatar expression only.

- **The `AlertCenter` snooze exports are intentional public surface.**
  `snooze()`, `unSnooze()`, and `toggleSnooze()` have no in-app caller because the
  popover button in `dashboard/alerts.js` calls the module-internal functions
  directly, but they are the console and test entry points —
  `test/cards-smoke.test.js` drives `toggleSnooze()`. Kept deliberately. An earlier
  note here claimed `sound.isMuted()` had no internal caller; that was wrong.
  `dashboard/app.js` calls it from the exported `App.isSoundSuppressed()`, which
  the smoke tests read.

- **`.cursorignore` was redundant with `.gitignore`.** The file duplicated roughly
  95% of `.gitignore` — the same `node_modules/`, `dist/`, `*.exe`, `*.log`,
  `.cache/`, `.codewhale/`, and `*.event-log.jsonl` patterns — and its only unique
  content was four credential patterns. It also could never be ignored by
  `.gitignore`, because ignore rules do not apply to tracked files. Removed: one
  ignore file, and `.gitignore` now ignores a locally regenerated `.cursorignore`
  instead of the other way round.

## Housekeeping

- The merged branch `fix/snooze-sound-suppression` is gone locally and on the
  remote; there is nothing to delete.
- Repo-root `AgentWorkshop.exe` is rebuilt via `npm run pack` after user-facing
  changes; it is gitignored and never committed.
- The top-level `state/` directory is empty and is referenced nowhere in the tree.
  Git cannot track an empty directory, so it has no effect on the repo. Left in
  place rather than deleted, since its origin is unknown.
