# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.1] - 2026-10-16

Hardening-only patch. No new features or dependency changes.

### Security

- **Strict CSP on bridge HTML.** Dashboard shell responses send `Content-Security-Policy` with
  `script-src 'self'` and `style-src 'self' 'unsafe-inline'` so inline styles from JS/SVG still work.
- **Electron navigation lockdown.** `setWindowOpenHandler` denies popups; `will-navigate` allows only
  the app’s loopback bridge URL.
- **Port 3847 identity.** `/api/status` exposes `bridgeId`; Electron verifies it before loading when
  reusing an existing listener, and the bridge refuses foreign `ok` responses without the id.
- **Atomic event-log replace.** Prune and clear write a temp file in the log directory and rename over
  the JSONL instead of truncating in place.
- **Status class escaping.** `formatStatusHtml` escapes wrapper class names via `SafeHtml`.

### Changed

- **CSV TOTAL label.** The TOTAL row notes that explorer and researcher lines are excluded because their
  tokens are already counted in Haiku (numbers unchanged).

## [1.4.0] - 2026-10-16

Correctness pass on the Live path. The bridge was reading a transcript shape Cursor does not
write, so several features could never fire. Everything below was checked against real
transcripts on disk, and the fixtures and the README's format list were corrected to match.

### Fixed

- **Terminal turns are actually read.** Cursor ends a turn with
  `{"type":"turn_ended","status":"success"|"error"}`. The bridge looked for `</final>` /
  `</error>` tags, which do not appear on disk, and the real `turn_ended` line carries no
  `role`, so the conversation handlers skipped it. No `done` or `error` history row and no
  finished/error alert could ever come from a real transcript. That line is now the
  terminal source.
- **The parent no longer claims to finish every turn.** A parent ends a turn on every user
  message (about 0.9 `turn_ended` lines per user line in the audited corpus). Alerting each
  one would stream a toast per turn, and each would say the session had finished when it
  had not. Subagent terminals alert; a parent success stays quiet, a parent error still
  alerts, and a user cancellation (`user_stopped_generation`,
  `composer_abort_controller_aborted`) does not.
- **A terminal error's own text reaches the log.** A quota notice such as `Other Models
usage limit reached` is now visible in the event feed. It stays out of the alert payload,
  which the project keeps to name + status so it cannot leak a path or a prompt.
- **Format drift is no longer silent.** A line that failed to parse, or parsed to a shape
  this build does not know, was dropped without a trace, so a drifted transcript made the
  dashboard look quiet rather than wrong. Both are now counted, reported once per session in
  the event feed, and exposed on `GET /api/status` as
  `drift: { unparsed, unknownShape, unknownStatus, lastAt, lastSample }`.
- **An unfamiliar terminal status is reported, not guessed.** A `turn_ended` status this
  build does not recognize (a real corpus holds `status:"aborted"`) was filed as an
  ordinary mid-turn row, so the agent never showed as finished and nothing said why. It now
  raises the drift counter and says so, and the turn is still recorded rather than being
  guessed as done or error. Repeat passes over a file's warm-up tail no longer re-count
  drift, so a project switch cannot look like a fresh format change.
- **The README's format list described a format that does not exist.** It documented a
  top-level `timestamp`, a `usage` block, `{"type":"user"}` conversation lines, and
  `agent-transcripts/*.jsonl` at the root. None of those appear on disk. The list now
  describes the two real line shapes and the real path layout, and states plainly that
  timestamps are ingest-time and tokens are estimated.

### Added

- **Stations name the model a delegation pinned.** `input.arguments.model` is read off the
  `Task` call and mapped to a label (`claude-haiku-5-5-thinking-high` -> Haiku). Route words
  (`inherit`, `fast`, `auto`, `default`) render as no label rather than as a model, and an
  unknown slug is shown verbatim and priced at nothing rather than at a guessed rate.
- `modelRaw` on the history contract, carrying that slug. `model` stays the billable bucket.
- `test/fixtures/transcripts/real/`: fixtures in the shape Cursor actually writes, kept
  beside the older hand-written ones, which still exercise the tolerant parser paths.
- `test/unit/real-transcript-format.test.js` pins that shape and the parsers that read it.
- `test/unit/real-transcript-ingest.test.js` drives real-shaped files through the real
  bridge and asserts the done and error rows, the finish alerts, that the parent stays
  quiet, and that drift is counted.

### Changed

- `touchAgentWatch` takes an `alertTerminal` hint. An error still surfaces after a success,
  while a repeated error does not repeat.
- A delegation with no resolvable child id is recorded as a parent `turn` row carrying the
  model, instead of being dropped.

## [1.3.1] - 2026-10-15

Refactors and test depth on top of 1.3.0. No user-visible behaviour change beyond one
audio fix; see Fixed.

### Added

- Seven more dashboard modules split out of `app.js`, each unit-tested in `test/unit/`:
  `activity.js` (Activity drawer, Session Log, empty states), `view-mode.js` (view
  switching, Panels toggle, drawer-sheet focus policy), `projects.js` (the Live project
  picker and the `/api/select` round-trip), `presence.js` (the presence state machine,
  coach, and bridge sync-age poll), `bill.js` (Session Bill state and DOM),
  `demo-playbook.js` (the scripted demo beats), and `safe-html.js` (one canonical HTML
  escaper). `app.js` drops from 3064 to 1977 lines.
- `dashboard/bill-math.js`: the DOM-free bill and usage math, so it can be unit-tested
  without a browser.
- `dashboard/safe-html.js` replaces four near-duplicate escapers in `app.js`,
  `insights.js`, `cards.js`, and `alerts.js`. The copies disagreed on null handling,
  and `cards.js` rendered `0` and `false` as empty strings. The shared version
  preserves falsy-but-meaningful values, renders `null`/`undefined` as empty, and
  escapes single quotes so the result is safe in an attribute quoted either way.
- `npm run build:check` now verifies that every dashboard script referenced by the HTML
  exists and that `safe-html.js` loads first. Verified by mutation: moving it out of
  first position, or referencing a nonexistent script, both fail the check.
- Focus is reclaimed when a drawer sheet is hidden. The sheets are non-modal panels
  behind `aria-pressed` toggles, so opening one deliberately does not steal focus; the
  hazard was the reverse - focus inside a sheet that a view change hid was destroyed and
  the next Tab restarted from the top of the document.
- `test/reconnect-smoke.test.js` covers the SSE reconnect loop end to end: it starts a
  real bridge, loads the dashboard, stops the bridge, and asserts the page reports
  `bridge-down`, schedules a bounded retry, and respects the cap.
- Unit coverage grew from 49 to 153 tests as the extracted modules gained direct tests.

### Changed

- `dashboard/demo-playbook.js` was lifted **verbatim** from `app.js`, verified
  byte-identical against the original block, with exactly one documented substitution:
  the final beat ends the run through a `setPlaying(false)` setter instead of assigning
  `app.js`'s private flag.
- The bridge-down banner reports the retry attempt and countdown rather than telling the
  user to click Reconnect while it is already retrying.

### Fixed

- **The bridge recovery cue never sounded.** It fired only on a direct
  `bridge-down` -> healthy transition, but a retry passes through `connecting` on the
  way back up, so the cue was effectively dead. It now tracks a "was down" flag that
  survives the transient `connecting` state and cues exactly once on recovery. Verified
  by mutation: restoring the old rule fails the suite.

### Notes

- `dashboard/app.js` remains partly split. `stage` (the workshop animation) and the
  Live SSE client are still in it: both are DOM- and animation-heavy and call back into
  `app.js` state from many places, so extracting them buys less isolation than the nine
  modules already done. Worth stating plainly: the split cost more code than it removed -
  `app.js` went 3064 -> 1977 lines, but the extracted modules total roughly 1950, so the
  dashboard is net larger. The indirection is not gratuitous (`<script type="module">`
  would remove all the window globals and `init(deps)` plumbing, but module scripts are
  CORS-blocked from `file://`, and Demo is promised to work by double-clicking the HTML),
  but future effort is better spent deleting dead code than adding a tenth module. See
  `docs/known-issues.md`.

## [1.3.0] - 2026-10-15

### Added

- Direct unit tests for `lib/transcript-parse.js` and `lib/transcript-tail.js` on the
  built-in `node:test` runner, with JSONL fixtures covering every subagent role, an
  unknown role, a tool edit, terminal signals, and a malformed line. 49 tests, run by
  `npm test` via `npm run test:unit`.
- `npm run typecheck` (`tsc --noEmit`) over `types/` and `lib/`, plus `types/events.js`:
  JSDoc `@typedef` shapes for the bridge <-> dashboard contract (`DashEvent`,
  `HistoryEvent`, `AgentAlert`, `ActivityItem`, `BridgeStatus`, `ProjectEntry`).
  Added to `npm run ci`.
- `scripts/checksums.js` writes a deterministic, `shasum`-compatible `SHA256SUMS.txt`
  for a build directory, and `.github/workflows/release.yml` builds all three
  platforms on a `v*` tag, hashes the artifacts, and attaches them plus a combined
  checksum manifest to the GitHub Release.
- [docs/release-verification.md](docs/release-verification.md): how to verify a
  downloaded artifact with `Get-FileHash` / `shasum -a 256` / `sha256sum -c`, and why
  the checksum is the meaningful control while builds are unsigned.
- Workshop audio is its own module (`dashboard/sound.js`). Cues now run through a
  master gain and a limiter, so overlapping cues cannot clip. Adds a volume slider
  beside the mute toggle, role-tinted timbres (an Opus crate and a Haiku crate no
  longer sound identical), and cues for error, stall, bridge down/up, snooze, and
  history scrubbing. Alerts that were visual-only now make a sound.
- Bounded SSE auto-reconnect with jittered exponential backoff (1s doubling to a 30s
  cap, six attempts). A dropped bridge now recovers on its own instead of needing a
  manual Reconnect; the transition is announced in the presence banner.
- Session summary export from the Session Bill drawer: a local JSON download (totals,
  per-model tokens and estimated cost, advisor calls, subagent count, and activity)
  and a CSV download (one row per model plus a total). Entirely client-side; nothing
  is uploaded.
- README "Format compatibility" section: the transcript path layout, line shape,
  timestamp fields, role mapping, terminal-signal rules, and usage rules the bridge
  assumes, with the month they were last checked.

### Changed

- `dashboard/sound.js` loads before `app.js`.
- An unrecognized `subagent_type` is now marked `unrecognized role` on its delegation
  line, so a Cursor format change is visible instead of silently becoming a worker.
  Telemetry stays local; nothing is sent anywhere.
- `CONTRIBUTING.md` documents `npm run typecheck`; the gate description matches the
  current `npm run ci` sequence.

### Fixed

- **Audio was silent whenever no volume had ever been stored.** `Number(localStorage.getItem(...))`
  is `0` for an absent key, so the new volume default read as zero and muted every cue.
  Caught by the existing snooze-sound smoke test.
- The empty `state/` directory is gone.

### Notes

- Code signing remains out of scope: it needs a purchased Windows Authenticode and
  Apple Developer ID certificate. Builds stay unsigned; checksums are the integrity story.
- `dashboard/app.js` is only partly split. `sound.js` was extracted; the remaining
  modules (stage, presence, view-mode, activity, bill) share a mutable `state` object
  and a widely-called stage director, so they were deliberately left in place rather
  than risk a behavior change. See `docs/known-issues.md`.

## [1.2.0] - 2026-10-15

### Added

- macOS (`dmg`, `zip`) and Linux (`AppImage`, `deb`) build targets, plus `npm run pack:win` / `pack:mac` / `pack:linux`. `npm run build` now targets the host platform instead of being Windows-only.
- macOS and Linux artifacts are produced but unsigned, so Gatekeeper and SmartScreen warn on first launch.
- A macOS CI leg. CI is now a three-platform matrix and runs an unpacked packaging build per platform, so the toolchain is exercised on macOS and Linux rather than Windows alone. The `dmg` / `AppImage` / `deb` artifact targets themselves are not built in CI.
- `test/electron-smoke.test.js`: launches the real Electron app and asserts the window title and the in-process bridge, covering the Electron upgrade end to end.
- Custom application icon (`assets/icon.png`, pixel-cast block agent). The packaged app no longer ships the default Electron icon.
- [SECURITY.md](SECURITY.md) (threat model, guards, accepted risks), [CONTRIBUTING.md](CONTRIBUTING.md), and issue / pull-request templates.
- `test/bridge-guards.test.js`: route x guard matrix across loopback enforcement, method guards, CSRF header/site guards, body validation, static traversal, and CORS posture.
- `test/dashboard-units.test.js`: unit layer for the dashboard formatters and the pixel-cast avatar/brand invariants.

### Changed

- `electron` 33.4.11 → 44.7.2 and `electron-builder` 25.1.8 → 26.15.3. This swaps the runtime of the packaged app.
  Electron 44 also removed its `postinstall` hook, so `npm install` no longer fetches the Electron binary; it is downloaded lazily on first use (`npm start`, or `npx electron --version`), roughly 200 MB, printing `Downloading Electron binary...`. Expect that on a fresh clone.
- `live-bridge.js` split into cohesive `lib/` modules (`bridge-http.js`, `transcript-parse.js`, `transcript-tail.js`) behind an unchanged module export surface. Behavior is unchanged; the file drops from 2233 to 1622 lines.
- README and CLAUDE.md document POSIX setup, and the build section is no longer Windows-only.

### Fixed

- **18 dependency advisories down to 8.** The critical `tar` advisory and every `electron` advisory are gone, including the runtime ones that applied to the shipped app (ASAR integrity, sandbox and `contextBridge` escapes). The 8 remaining are a single moderate `sprintf-js` denial-of-service in `electron-builder`'s build-time download chain, which never runs in the shipped app; npm's suggested fix is a downgrade, so it is deliberately not applied.
- `scripts/copy-exe.js` failed the build on non-Windows platforms and on any target that produces no portable artifact. It now skips with a message, and the `electron-builder` hook no longer treats a missing portable exe as an error.
- The event log narrowed the mode of its containing directory unconditionally. A `CURSOR_EVENT_LOG_DIR` override pointing at a shared directory (for example `$HOME`) silently chmod-ed unrelated data to `0700`. The directory is now narrowed only when it holds nothing but the log; the log file itself is still `0600`.
- Redaction missed signed-URL parameters that are not named `token`/`key`, so AWS presigned queries (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`), generic `Signature`/`code`/`session` parameters, `npm_` tokens, and credentials in URL userinfo could reach the local event log unredacted. Patterns added.
- Windows executables carried no icon or version metadata. `signAndEditExecutable: false` suppressed icon and metadata along with signing; replaced with `signExecutable: false`, which keeps both.

## [1.1.0] - 2026-10-15

### Added

- Indefinite alert snooze with an un-snooze control. Snoozing no longer expires on a 15-minute timer; the alert popover action toggles between **Snooze** and **Un-snooze**.
- `POST /api/snooze` on the bridge (POST-only, same-origin, `X-Cursor-Bridge: 1`) so the Electron desktop toast is suppressed while alerts are snoozed. The SSE `alert` event and the alert ring still flow.

### Changed

- Workshop audio is silenced while alerts are snoozed. The sound on/off preference is preserved and resumes on un-snooze.
- `POST /api/snooze` requires an explicit `{ "snoozed": boolean }` body. An empty or non-boolean body is now rejected with 400 instead of defaulting to snoozed, so the route never implies intent.
- CI and the declared engine floor move to Node 24 (active LTS). Node 20 is end of life, and both workflow jobs cache Playwright browsers per runner OS instead of downloading them on every run.

### Fixed

- Session Bill **Out** column shows Sonnet output tokens again (it was rendering Sonnet cost).
- Restore the dashboard app module this branch had dropped, which broke ESLint and CI.
- Alert snooze survives an app or bridge restart. The bridge holds snooze in memory and reset it on stop, so a fresh bridge started unsnoozed while the dashboard still showed snooze active and desktop toasts fired again. `hydrate()` now reconciles against `GET /api/status` and re-pushes the persisted state.
- `package-lock.json` recorded the root package license as `UNLICENSED` while `package.json` declares `MIT`.
- `CLAUDE.md` pointed at three `.cursor/` rule files that do not exist in the tree; the guidance they were meant to carry is now stated inline.

## [1.0.0] - 2026-10-10

### Added

- Electron desktop app with in-process live bridge (no separate console on launch).
- Workshop stage with five pixel-cast block agents at stations, Demo playbook, and Live SSE from Cursor agent transcripts.
- Drawer sheets: Stage, Insights (forecast + cost-ranked suggestions), History with replay transport.
- Station cards, TipLayer tooltips, alert center, ship celebration, and HUD session strip.
- Headless `live-bridge.js` for browser Live mode on loopback.
- Windows portable `AgentWorkshop.exe` and optional NSIS installer via `electron-builder`.
- Playwright smoke tests, ESLint/Prettier, and CI on Ubuntu and Windows.
- MIT license, preview screenshot, and README status badges.

### Security

- Bridge binds to loopback; Host/Origin guards on sensitive POST routes.
- Local event log redacts values that look like secrets before write.

### Notes

- Token and session cost figures are illustrative estimates, not official Cursor billing.

[Unreleased]: https://github.com/thymeed/agent-workshop/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/thymeed/agent-workshop/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/thymeed/agent-workshop/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/thymeed/agent-workshop/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/thymeed/agent-workshop/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/thymeed/agent-workshop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/thymeed/agent-workshop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/thymeed/agent-workshop/releases/tag/v1.0.0
