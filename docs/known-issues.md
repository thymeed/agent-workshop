# Known issues

Audit findings for the dashboard, the alert-snooze work, CI, and the dependency
tree. Each item says whether it is fixed, open, or verified as a non-issue, so
nobody re-litigates a settled question or assumes an open one is closed.

Last reviewed: 2026-10-15 (post-review of the 1.2.0 work).

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

- **The fallback transcripts path ignored `CURSOR_PROJECTS_ROOT`.**
  The placeholder watch path was built from the hardcoded home directory, so a
  bridge started with an isolated projects root still reported (and watched) the
  real `~/.cursor/projects/_none/agent-transcripts`. Found by the new
  `test/electron-smoke.test.js` on its first run. Now derived from the resolved
  projects root.

- **The event log chmod-ed a caller-supplied directory.** `secureLogDir` narrowed
  any existing directory to `0700`, so `CURSOR_EVENT_LOG_DIR=$HOME` silently
  restricted everything in the home directory. It now narrows the directory only
  when it holds nothing but the log file; the log file itself stays `0600`.
  Covered by `testSharedLogDirNotChmodded`.

- **Redaction missed signed-URL parameters not named `token`/`key`.** AWS presigned
  queries (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`), generic
  `Signature`/`Sig`/`code`/`session` parameters, `npm_` tokens, and credentials in
  URL userinfo reached the local event log unredacted. Patterns added; covered by
  `testRedactionSignedUrls`.

- **`CLAUDE.md` cited rule files that do not exist.**
  It pointed at `.cursor/rules/refresh-desktop-exe.mdc`,
  `.cursor/rules/advisor-before-commit-push.mdc`, and `.cursor/agents/advisor.md`;
  there is no `.cursor/` directory in the tree. The guidance those files were meant
  to carry is now stated inline in `CLAUDE.md`.

- **The dependency advisories are cleared.**
  `npm audit` reported 18 (4 moderate, 13 high, 1 critical), including
  `electron` ≤ 41.10.5 — the runtime of the packaged app, not only a build tool.
  Upgraded to `electron@44.7.2` and `electron-builder@26.15.3`. The critical `tar`
  advisory and every `electron` advisory are gone. 8 moderate remain, all one
  `sprintf-js` denial-of-service reached through `electron-builder`'s build-time
  download chain (`@electron/get` → `global-agent` → `roarr`), which never runs in
  the shipped app. npm's suggested fix is a downgrade to `electron-builder@26.5.0`,
  so it is left alone deliberately. `package.json` `allowScripts` was repinned from
  `electron@33.4.11` to `electron@44.7.2` and `electron-winstaller` denied, because
  Electron 44 dropped its `postinstall` hook and fetches its binary on first use.

## Open

1. **Type checking covers the shared contract, not the whole tree.**
   `npm run typecheck` (`tsc --noEmit`) checks `types/` and `lib/` only. Those are the
   modules the `@typedef` event shapes in `types/events.js` describe, and they pass
   clean. `live-bridge.js`, `scripts/`, and `dashboard/` are not checked: turning on
   `checkJs` across them surfaces implicit-any noise and a few JSDoc gaps (notably
   the `module.exports = fn` plus attached-properties pattern in `scripts/copy-exe.js`)
   that are not worth churning for their own sake. Widening the include list is a
   contained follow-up whenever someone touches those files.

2. **The release workflow fires on any `v*` tag push and publishes publicly.**
   `.github/workflows/release.yml` builds on all three platforms, hashes the artifacts,
   and attaches them plus a combined `SHA256SUMS.txt` to the GitHub Release. A tag
   push therefore publishes without a further confirmation step. Builds stay unsigned
   (no certificate); the checksums are the integrity control.

3. **The alert list still records entries while snoozed.** Only the unread badge
   is hidden. This is inherited master behavior, deliberate in #25, and a product
   decision rather than a defect. Change it only if the list is meant to go quiet
   too.

4. **Snooze reconciliation is last-client-wins, not strictly renderer-wins.**
   A second client with its own `localStorage` (a genuinely separate browser
   profile hitting the bridge URL) will POST `snoozed: false` and silently clear a
   snooze set elsewhere. Same-origin tabs share the key and are unaffected.

5. **`notifyBridge()` is fire-and-forget with no read-back.** A dropped POST
   leaves the bridge out of sync until the next `hydrate()` / reconnect. Accepted
   for now; the reconcile on load covers the common case.

## Verified as non-issues

- **`scripts/checksums.js` is deterministic.** Ran it twice over the same two files in
  a temp directory: `SHA256SUMS.txt` was byte-identical both times, entries sorted
  ascending, and it exited 1 on both a missing directory and a directory with no
  files. Deterministic output is load-bearing: a manifest that reorders between runs
  would make release verification meaningless.

- **`package.json` had no install-script approval mechanism.** The `allowScripts`
  key is not an npm field and nothing in the tree consumed it, so it enforced
  nothing. Removed rather than left as false assurance. Electron 44 fetches its
  binary lazily on first run anyway (`install.js` via `index.js`), confirmed by
  clearing the binary state and watching `npx electron --version` re-download it —
  so a fresh clone needs no install-script approval to work.

- **The `live-bridge.js` split changed no behavior.** The only logic delta in the
  refactor is a `port` parameter threaded into `isAllowedOrigin`,
  `allowProjectSelect`, and `rejectIfNotLocal`; every other changed line is moved
  code. The 17-name `module.exports` surface is unchanged, and
  `test/bridge-guards.test.js` exercises the parameterized guards over real HTTP.

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
