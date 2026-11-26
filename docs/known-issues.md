# Known issues

Audit findings for the dashboard, the alert-snooze work, CI, and the dependency
tree. Each item says whether it is fixed, open, or verified as a non-issue, so
nobody re-litigates a settled question or assumes an open one is closed.

Last reviewed: 2026-10-16 (post-audit of the Live transcript path).

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

- **The six-process salt-lock test failed on the Windows CI runner.**
  The six-process test in `test/unit/claude-code-sources.test.js` failed on master
  after the merge of #30
  (https://github.com/thymeed/agent-workshop/actions/runs/44223223126, green on
  re-run) and twice on the CI of #33
  (https://github.com/thymeed/agent-workshop/actions/runs/44268318813). The cause
  was in `takeSaltLock`: while several processes broke a stale lock, a Windows
  sharing error (`EPERM`, `EACCES` or `EBUSY`) on reading, linking or removing
  the lock ended the wait at once, and that process used a temporary salt with the
  "Labels change after restart" note. Those errors are now waited out inside the
  existing 3 s lock budget (a persistent one still ends in the note at the
  deadline), and a sharing error on the hard link never leads to removing the lock
  directly. Reproduced locally only with the processes pinned to 2 cores under
  load. See known issue 37 for what is left.

- **Claude Code role labels were not applied.**
  Nothing called `RoleProfiles.apply`, so the stations kept the Cursor labels in
  Claude Code mode. `dashboard/app.js` now calls
  `RoleProfiles.apply(profileFor(mode, source))` from `setMode` and from the source
  switch's `onSourceShown`: the Claude Code profile in Live on the Claude Code
  source, the Cursor profile in Cursor and in Demo. Item 34 below keeps its number
  so the items after it do not move.

- **A reload with Claude Code stored replaced a stored History view with Stage.**
  History was off on that source, so `dashboard/view-mode.js` moved the view to
  Stage. History is now available on Claude Code (it lists the project's older
  sessions for replay), so a stored History view is restored. Item 30 below keeps
  its number.

- **Choosing a Claude Code session wiped the Live stage, Bill and log.**
  Loading a session into the History replay sent a "session" frame to the stage,
  which reset the Live state, and leaving History never restored it. Choosing a
  session now leaves the Live stage alone; only a scrub or Play takes the stage,
  and the Live state it covered (Bill, log, stage calls and active roles, cards)
  comes back when the replay ends, together with the Live rows that arrived
  meanwhile, applied quietly and in order; today's Runs, tokens and fastest stay
  frozen while it runs.

- **A replay start recorded a cut-off Live role as today's fastest.**
  Starting a replay (Cursor or Claude Code) while a Live role was lit ended that
  role through the timing path, so its partial time could become "fastest". The
  replay reset now skips timing.

## Open

1. **A release asset that is renamed between runs accumulates rather than being
   replaced.** The workflow uploads with `gh release upload --clobber`, which
   replaces an asset only when the name matches. Renaming an artifact (as 1.3.0 did,
   dropping spaces) leaves the old name on the release beside the new one, so v1.3.0
   briefly carried 24 assets instead of 16. Cleaned up by hand with
   `gh release delete-asset`. Worth fixing if artifact names ever change again:
   delete the release's existing assets at the start of `publish`.

2. **`dashboard/app.js` is only partly split.** Nine modules have been extracted:
   `dashboard/sound.js` (audio), `dashboard/bill-math.js` (the DOM-free usage math),
   `dashboard/bill.js` (Session Bill state and DOM), `dashboard/demo-playbook.js` (the
   scripted demo beats), `dashboard/safe-html.js` (the single HTML escaper),
   `dashboard/activity.js` (Activity drawer, Session Log, empty states),
   `dashboard/view-mode.js` (view switching, Panels, focus policy),
   `dashboard/projects.js` (the Live project picker), and `dashboard/presence.js`
   (presence state, coach, sync-age poll). The first eight are unit-tested in `test/unit/`.

   **Worth stating plainly: the split cost more code than it removed.** `app.js` went
   3064 -> 1978 lines, but the extracted modules total ~1950 lines, so the dashboard is
   net larger. The indirection is not gratuitous - `<script type="module">` would remove
   all the window globals and `init(deps)` plumbing, but module scripts are CORS-blocked
   from `file://`, and the README promises Demo works by double-clicking the HTML. That
   constraint is the reason for the pattern. Even so, two modules remain and neither is
   clearly worth the churn; future effort is better spent deleting dead code from
   `app.js` than adding a tenth module.

   Still inside `dashboard/app.js` (~1980 lines): stage (the workshop animation) and the
   Live SSE client. These are the most DOM- and animation-heavy parts, and both call back
   into app.js state from many places, so an extraction is slow to prove safe and buys
   less isolation than the ones already done.

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

8. **Renaming a CI job will hang every pull request.** The `Branch Master`
   ruleset requires three status checks by their exact context names —
   `Lint, test, build check (ubuntu-latest)`, `(windows-latest)`, `(macos-latest)` —
   which embed the job name from `.github/workflows/ci.yml`. Rename that job and the
   required contexts no longer match anything, so every PR waits on "Expected — waiting
   for status to be reported" with no failing check to explain it. Update
   `.github/rulesets/branch-master.json` in the same commit as any job rename. Related:
   never add a `paths:` filter to `ci.yml`, which would leave docs-only PRs permanently
   unreported and therefore unmergeable.

9. **The `code_quality` rule may be inert.** The ruleset requires code quality results at
   `errors` severity, but no workflow produces a code quality analysis. GitHub's own
   description of the rule says an analysis "must be done on the pull request before the
   changes can be merged", so if it is enforced literally a PR could wait on an analysis
   that never runs. It has not bitten yet: with the rule active and CI green, PR #4
   reached a `CLEAN` merge state, so it is not blocking merges today. If a pull request
   ever sits on "code quality" with no evident cause, drop that rule from
   `.github/rulesets/branch-master.json` first.

Claude Code source (known limits, found while building it; none of them is a crash):

10. **A finish in the first ~4.5 s of a brand-new session never alerts.** The switch waits 5 polls (5 x 900 ms) before the new session takes over, and its catch-up then replays silently.

11. **Child lstat faults during a long parent catch-up can use up the fault budget.** During a parent catch-up longer than about 5 MB, a child's transient lstat faults can spend its 3-poll budget (`FAULT_WAIT_POLLS`) before the child is read.

12. **Path cleaning decodes at most four rounds of percent-encoding.** A path encoded five or more times is not fully decoded, so it may not be judged an absolute path and can show a folder name that the check would otherwise hide.

13. **8.3 short names other than `DOCUME~n` are not recognised as home folders.** A path such as `C:\USERS~1\user` shows `user`, because only `DOCUME~n` is mapped to "documents and settings" before the home check.

14. **A `\\?\UNC\wsl...` or mapped-drive WSL folder would trust creation time.** Through a WSL share, creation time is the Linux modification time. Discovery never produces these forms, so this only matters if a typed folder ever reaches the ingest.

15. **Replayed delegate rows still run route animations.** A replayed delegation plays its route animation, though the replay skips the counters and the ship celebration.

16. **Claude error rows play the error sound only for failed, error and killed.** A finished subagent whose notification status is `failed`, `error` or `killed` is marked `failed` by the wire, shows as an error line and plays the error sound once, live only (never during the silent catch-up, a History replay or the SSE backlog). `stopped`, `cancelled` and `canceled` rows are still error rows and alerts but stay silent. Cursor live rows are unchanged: they never play it. The notification is the only source of Claude error rows, so a failure of the parent session itself has no row and no sound.

17. **Cache tokens are ignored by the usage read in `dashboard/app.js`.** The Bill prices input and output only.

18. **`GET /api/status` has no `replaying` flag.** A client cannot tell from status alone that a replay is in progress.

19. **Stale Claude Code models stay in RoleProfiles after switching back to Cursor.** `applyBridgeModels` only sets models when the bridge sends them, and nothing clears them on the switch back.

20. **A parse exception loses the rest of its read chunk.** The read offset advances before the chunk's lines are parsed, so an exception drops the chunk's remaining lines and counts one `drift.unreadable`.

21. **An idle child can take up to 10 polls (about 9 s) to wake.** Idle children are lstat'ed only every 10th poll (`IDLE_EVERY`), at the 900 ms poll interval.

22. **The subagent listing caps at 2000 entries before filtering.** Each child has a `.meta.json` beside it, so the real limit is about 1000 children per session.

23. **A partial line longer than the per-poll read cap is rescanned on every poll.** The bridge rescans to the end of the file each poll until the line's newline arrives.

24. **On a WSL share or POSIX, a larger replacement file that shows the same ids is not detected.** Creation time is not used there, and the shrink check only catches a smaller file.

25. **A parent read failure leaves `more` false.** The next regular poll retries the parent.

26. **The top-level scan cut at 20000 `.jsonl` candidates has no test.** `MAX_SCAN_CANDIDATES` is set, but nothing exercises it.

27. **The label salt can still race on disks without hard links.** On FAT, exFAT and most SMB shares, two processes starting together on a first run can end with different salts. Separately, a salt lock holder paused for more than 10 s can be broken, so labels can differ for one run; the salt on disk stays valid.

28. **A second client that switches the bridge leaves this page's stored choice different.** The difference lasts until the next connect, when the page reconciles once.

29. **Two windows with different stored choices switch the bridge back and forth.** Each one reconciles the bridge to its own stored choice on every connect.

30. **Reload with Claude Code stored replaces a stored History view with Stage: fixed.** See the Fixed section.

31. **The `app.js` hello, reset and onChanged call sites have only browser checks.** The source-switch module has unit tests; the call sites in `app.js` are covered only by the real-bridge browser checks.

32. **A hello with no `source` leaves the page on its own choice.** An older bridge sends none, so the page does not reconcile and the chip shows the stored or default source (Claude Code with no stored choice) even if that bridge reads Cursor. The app and its bridge ship together, so this only shows with a mismatched standalone bridge.

33. **An explicit Cursor folder wins per run, without touching the stored choice.** A bridge started with `--dir` or `CURSOR_TRANSCRIPTS` reports `explicitDir: true`; while it reads Cursor the page shows Cursor and sends no switch, and the stored choice stays as it was (so a later run without a folder is back on the stored or default source). If another client has switched that bridge to Claude Code, the page follows it. The flag describes how the process started and stays true after switches.

34. **Claude Code role labels: fixed.** See the Fixed section.

35. **A WSL clock that disagrees with Windows weakens the racy-listing rule.** A folder mtime in the future (WSL clock ahead) keeps every listing racy, so the top-level scan runs on every poll over the share and `drift.dirCut` counts every poll on a capped folder. A WSL clock behind by more than 2.5 s (WSL2 drift after host sleep) stops the rule protecting a same-tick listing; the 30 s `RESCAN_MS` backstop still applies.

36. **The label salt folder has limits.** The salt now lives in its own config folder, not the event-log folder. On Windows it is protected only by the profile's folder permissions (no `icacls` call); on POSIX the folder is 0700 and the file 0600. On disks without hard links (FAT, exFAT, most SMB shares) two processes starting together on a first run can still end with different salts (see item 27). A migration from the old event-log folder copies and verifies the salt first, then deletes the old copy; if that delete fails (file in use, read-only folder) the old copy stays behind and keeps working as a leftover, and nothing tells the user. A valid salt already in the config folder wins, and the old copy is then deleted too. If the old copy cannot be looked at or read at start (a failed stat of the old folder, a failed real-path lookup, or a read that fails after the sharing-error retries), that run uses a per-process salt with the "Labels change after restart" note: nothing is published in the config folder and the old file is left alone (a valid salt already in the config folder is used instead, with no note), so the next start migrates it and ids return to what they were. The old folder counts only when it is provably a different folder from the config folder (device and inode, else real path: a case variant, symlink or junction does not), and the old salt file is never deleted when it is the same file as the new one; when that cannot be told, the delete is skipped. A lasting fault on the old copy (no permission on the file, a folder named like the salt file) never heals by itself: every start then uses a temporary salt with the note until the fault is fixed or a valid salt is already in the config folder. A missing old folder or file (ENOENT) is trusted as "nothing to migrate". Someone who ran earlier versions with two different `CURSOR_EVENT_LOG_DIR` folders had two salts; only one survives (the first migrated, or one already in the config folder), so the other folder's ids change once. Paths: `%LOCALAPPDATA%\cursor-agents-model-routing-config` (Windows), `~/Library/Application Support/cursor-agents-model-routing-config` (macOS), `$XDG_CONFIG_HOME/cursor-agents-model-routing-config` or `~/.config/cursor-agents-model-routing-config` (Linux; a relative `XDG_CONFIG_HOME` or home is ignored).

37. **The salt lock still gives up on two cases.** The first read of `label-salt.bin`, before any lock is taken, gives a temporary salt with the "Labels change after restart" note on any error other than a missing file, so a sharing error there (another process replacing a corrupt file at that moment, Windows) is not retried. Separately, when a stale lock has to be broken, a hard-link attempt that fails with `EPERM`, `EACCES` or `EBUSY` is treated as a sharing error and waited out, never as "no hard links": a disk that reports one of those codes for every hard link keeps the stale lock, and each start waits the 3 s lock budget and then uses a temporary salt with the note until the lock is removed by hand. Disks that report another code (for example `ENOTSUP`) still use the direct removal. Also, if removing the temporary `.stale-` link made while breaking a stale lock fails, the link stays behind: the next start finds it, waits for it to age past the 10 s stale limit (longer than the 3 s lock budget) and that run uses a temporary salt with the note. Follow-up: give up on, or clear, that link sooner.

38. **The Claude Code session list shows an event count only once a session is opened.** The list endpoint returns `events: null` (counting would mean reading every file), so a label shows local time and duration, and the count appears after the session is opened.

39. **The Claude Code session list includes the session Live is tailing right now.** Replaying it shows rows Live also shows. Choosing it does not touch the stage until Play or a scrub.

40. **A very long Claude Code replay can lose Live rows.** While a replay owns the stage the Live state is held as a snapshot and the Live rows that arrive are queued, up to 20,000; past that cap the queue is dropped and leaving the replay rebuilds Live from the bridge instead, which carries only its recent backlog (about 40 rows), so rows from the middle of a very long replay are lost. Queued rows are applied quietly: no crate, spark or error sound, ship celebration or fastest timing, but they count in today's stats, and a Live finish or error during a replay still alerts.

41. **A crate in flight when a Claude Code replay starts does not come back.** Leaving the replay restores the stationary state (characters, active roles, calls, Bill, log, cards; today's counters are frozen during the replay, not restored) but not the transient crates, route tokens or sparks that the replay's own reset clears. One that was mid-flight is gone for good; the reset at the start would have removed it anyway.

42. **Insights Suggestions and What-if are not available for a live Claude Code session.** The sheets show "Not available for live sessions yet." there; the session picker, the event count and the Forecast (which equals the Bill) work. Per-agent pricing from the usage rows is planned. An older session loaded from history keeps both sheets.

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
