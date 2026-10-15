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

1. **A release asset that is renamed between runs accumulates rather than being
   replaced.** The workflow uploads with `gh release upload --clobber`, which
   replaces an asset only when the name matches. Renaming an artifact (as 1.3.0 did,
   dropping spaces) leaves the old name on the release beside the new one, so v1.3.0
   briefly carried 24 assets instead of 16. Cleaned up by hand with
   `gh release delete-asset`. Worth fixing if artifact names ever change again:
   delete the release's existing assets at the start of `publish`.

2. **`dashboard/app.js` is only partly split.** Seven modules have been extracted:
   `dashboard/sound.js` (audio), `dashboard/bill-math.js` (the DOM-free usage math),
   `dashboard/safe-html.js` (the single HTML escaper), `dashboard/activity.js` (Activity
   drawer, Session Log, empty states), `dashboard/view-mode.js` (view switching, Panels,
   focus policy), `dashboard/projects.js` (the Live project picker), and
   `dashboard/presence.js` (presence state, coach, sync-age poll). All seven are
   unit-tested - six of them via a `vm` sandbox with element/fetch/timer stubs, so they
   have direct coverage without a browser.

   Still inside `dashboard/app.js` (~1950 lines): stage, the DOM half of bill, the Live
   SSE client, and the demo playbook. These are the most DOM- and animation-heavy parts,
   so an extraction is slow to prove safe. The pattern that works (used for `activity.js`,
   `view-mode.js`, `projects.js`, and `presence.js`): map the dependency list first, move
   ownership of the module's own state into it, pass everything else through one
   `init(deps)`, and rewrite the call sites.

   A correction worth keeping: an earlier note here blamed a shared `state` object.
   An advisory review disproved that. `state` is a five-key, module-private
   session-metrics bag (`calls`, `subs`, `liveSubs`, `usage`, `activity`) with an
   existing setter seam, not a god-object. The blocker is verification cost, not
   coupling — which is why the fix is to keep pulling DOM-free code out first (as
   `bill-math.js` now does) until the DOM-heavy extractions have a cheap safety net.
   `sessionCostTotal` and `buildSessionSummary` are the next candidates: they read
   `state.usage` and can take it as an argument.

3. **Type checking covers the shared contract, not the whole tree.**
   `npm run typecheck` (`tsc --noEmit`) checks `types/` and `lib/` only. Those are the
   modules the `@typedef` event shapes in `types/events.js` describe, and they pass
   clean. `live-bridge.js`, `scripts/`, and `dashboard/` are not checked: turning on
   `checkJs` across them surfaces implicit-any noise and a few JSDoc gaps (notably
   the `module.exports = fn` plus attached-properties pattern in `scripts/copy-exe.js`)
   that are not worth churning for their own sake. Widening the include list is a
   contained follow-up whenever someone touches those files.

4. **The release workflow fires on any `v*` tag push and publishes publicly.**
   `.github/workflows/release.yml` builds on all three platforms, hashes the artifacts,
   and attaches them plus a combined `SHA256SUMS.txt` to the GitHub Release. A tag
   push therefore publishes without a further confirmation step. Builds stay unsigned
   (no certificate); the checksums are the integrity control.

5. **The alert list still records entries while snoozed.** Only the unread badge
   is hidden. This is inherited master behavior, deliberate in #25, and a product
   decision rather than a defect. Change it only if the list is meant to go quiet
   too.

6. **Snooze reconciliation is last-client-wins, not strictly renderer-wins.**
   A second client with its own `localStorage` (a genuinely separate browser
   profile hitting the bridge URL) will POST `snoozed: false` and silently clear a
   snooze set elsewhere. Same-origin tabs share the key and are unaffected.

7. **`notifyBridge()` is fire-and-forget with no read-back.** A dropped POST
   leaves the bridge out of sync until the next `hydrate()` / reconnect. Accepted
   for now; the reconcile on load covers the common case.

## Verified as non-issues

- **Focus is not lost when a drawer sheet closes.** `setViewMode` checks whether the
  focused element sits inside a sheet the view change will hide, and if so returns focus
  to the active view control. Opening a sheet still does not steal focus, which is
  correct for a non-modal `aria-pressed` toggle. `test/dashboard-units.test.js` asserts
  both halves, and removing the reclaim makes it fail.

- **The SSE reconnect loop is covered end to end.** `test/reconnect-smoke.test.js`
  starts a real bridge, loads the dashboard from it, stops the bridge, and asserts
  the page notices the drop, reports `bridge-down`, schedules a bounded retry with
  `attempts` set and `pending` true, and never exceeds the cap. Verified by mutation:
  removing the `scheduleLiveReconnect()` call makes it fail with "a scheduled retry
  did not happen", and the file was restored byte-identical. That test also caught a
  real defect - the bridge-down banner was hardcoded to say "click Reconnect", which
  contradicted the automatic retry. The banner now reports the retry state.

- **Releases are gated.** `.github/workflows/release.yml` runs `npm run ci` in a
  `verify` job on the tagged commit, and both `create-release` and `publish` depend on
  it, so a tag cannot publish an artifact that has not passed the gate. All three
  pinned action SHAs were re-verified against their upstream tags
  (`actions/checkout@3d3c42e5…` = v7.0.1, `actions/setup-node@949feb24…` = v7.1.0,
  `actions/cache@55cc8345…` = v6.1.0).

- **The `HistoryEventType` union cannot silently drift from the runtime Set.** The
  JSDoc cast in `lib/event-log.js` asserts what a runtime guard already checked, so
  `test/unit/event-contract.test.js` proves `EVENT_TYPES` and the documented union
  agree, and that the `HistoryEvent` typedef matches what `normalizeEvent` returns.
  Verified by mutation: adding a fifth type to `EVENT_TYPES` makes the test fail with
  "have drifted apart", and the file was restored byte-identical afterwards.

- **Stage token count and Activity list are already bounded.** `dashboard/app.js` caps
  in-flight route tokens at `MAX_ROUTE_TOKENS = 3` and evicts the oldest, and the
  Activity drawer caps at `ACTIVITY_CAP = 40`. The performance item that asked to
  "virtualize long Activity/History lists, cap DOM stage tokens" was therefore mostly
  already satisfied by existing design. The one genuinely unbounded list was History:
  a long session returned every persisted event. `/api/history` now returns the newest
  2000 (`MAX_HISTORY_EVENTS`), and `eventLog.query` accepts an optional `limit` that
  keeps the newest rows. Full virtualization was not added, because the cap removes
  the unbounded growth the item was about.

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

- **In-app audio now covers alerts and stalls.** `dashboard/sound.js` owns all Web
  Audio and is called from `app.js` (crates, routes, ship, scrub, bridge presence)
  and from `alerts.js` (finished / error / stalled). An earlier note here claimed
  there was no in-app stall audio path; that was true before the cue was added and
  is no longer. `cards.js` "Stalled" remains a visual avatar expression.

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
