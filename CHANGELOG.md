# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[1.2.0]: https://github.com/thymeed/agent-workshop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/thymeed/agent-workshop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/thymeed/agent-workshop/releases/tag/v1.0.0
