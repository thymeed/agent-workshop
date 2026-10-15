# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-10-15

### Added

- Direct unit tests for `lib/transcript-parse.js` and `lib/transcript-tail.js` on the
  built-in `node:test` runner, with JSONL fixtures covering every subagent role, an
  unknown role, a tool edit, terminal signals, and a malformed line. 66 tests, run by
  `npm test` via `npm run test:unit`.
- `dashboard/activity.js`: the Activity drawer, Session Log, and their empty states,
  split out of `app.js` (~210 lines). The module owns its row list, log clock, and role
  filter, and takes every DOM and session dependency through one `init(deps)`. 15 unit
  tests cover kind bucketing, the row cap, the role filter, escaping of transcript-derived
  fields, empty-state copy, and the log clock. Verified by mutation: removing the cap,
  ignoring the filter, or dropping the escaping each fails the suite.
- `dashboard/safe-html.js`: one canonical HTML escaper replacing four near-duplicate
  copies in `app.js`, `insights.js`, `cards.js`, and `alerts.js`. The copies disagreed
  on null handling, and `cards.js` rendered `0` and `false` as empty strings. The
  shared version preserves falsy-but-meaningful values, renders `null`/`undefined` as
  empty, and escapes single quotes so the result is safe in an attribute quoted either
  way. 9 unit tests cover the escaping and inert-ness of hostile transcript payloads.
- `npm run build:check` now verifies that every dashboard script referenced by the
  HTML exists, and that `safe-html.js` loads first. Verified by mutation: moving it out
  of first position and referencing a nonexistent script both fail the check.
- `dashboard/bill-math.js`: the DOM-free bill and usage math (rate table, token and
  money formatting, model normalization, summary CSV) split out of `app.js` so it can
  be unit-tested without a browser. `test/unit/bill-math.test.js` loads it in a `vm`
  sandbox and covers the boundaries: formatter thresholds, rate lookups, unknown-model
  fallback, CSV quoting, and the empty-usage contract.
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
- **Focus is reclaimed when a drawer sheet is hidden.** The drawer sheets are non-modal
  panels behind `aria-pressed` toggle buttons, so opening one deliberately does not steal
  focus. The real hazard was the reverse: if focus sat inside a sheet that a view change
  hid, it was destroyed and the next Tab restarted from the top of the document. Focus
  now returns to the active view control. Covered by `test/dashboard-units.test.js` and
  verified by mutation.
- Bounded SSE auto-reconnect with jittered exponential backoff (1s doubling to a 30s
  cap, six attempts). A dropped bridge now recovers on its own instead of needing a
  manual Reconnect, and the presence banner reports the retry attempt and countdown
  rather than telling you to click Reconnect while it is already retrying. Covered
  end to end by `test/reconnect-smoke.test.js`, which kills a live bridge under a
  loaded dashboard.
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
- `dashboard/app.js` is only partly split. `sound.js` (audio) and `bill-math.js`
  (DOM-free usage math) were extracted, and the extracted math is unit-tested.
  The remaining modules (stage, presence, view-mode, activity, and the DOM half of
  bill) are still in `app.js`: they are DOM- and animation-heavy with no cheap
  verification path, so they were left in place rather than risk a behavior change.
  See `docs/known-issues.md` for the recommended next step.

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

[1.3.0]: https://github.com/thymeed/agent-workshop/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/thymeed/agent-workshop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/thymeed/agent-workshop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/thymeed/agent-workshop/releases/tag/v1.0.0
