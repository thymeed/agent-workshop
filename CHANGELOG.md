# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[1.1.0]: https://github.com/thymeed/agent-workshop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/thymeed/agent-workshop/releases/tag/v1.0.0
