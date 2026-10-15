# Known issues

Audit findings for the alert-snooze work and the surrounding notification paths.
Each item says whether it is fixed, open, or verified as a non-issue, so nobody
re-litigates a settled question or assumes an open one is closed.

Last reviewed: 2026-10-12.

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

## Open

1. **`POST /api/snooze` with an empty body defaults to `snoozed: true`.**
   (`live-bridge.js`, the `/api/snooze` route.) The dashboard client always sends
   an explicit boolean, so this is harmless today, but it is asymmetric with
   intent. Either require the field (400 when absent) or document the default.
   Low priority.

2. **The alert list still records entries while snoozed.** Only the unread badge
   is hidden. This is inherited master behavior, deliberate in #25, and a product
   decision rather than a defect. Change it only if the list is meant to go quiet
   too.

3. **Snooze reconciliation is last-client-wins, not strictly renderer-wins.**
   A second client with its own `localStorage` (a genuinely separate browser
   profile hitting the bridge URL) will POST `snoozed: false` and silently clear a
   snooze set elsewhere. Same-origin tabs share the key and are unaffected.

4. **`notifyBridge()` is fire-and-forget with no read-back.** A dropped POST
   leaves the bridge out of sync until the next `hydrate()` / reconnect. Accepted
   for now; the reconcile on load covers the common case.

5. **Unused public surface.** `AlertCenter.snooze()`, `unSnooze()` and
   `toggleSnooze()` are exported but no in-app caller uses them (the popover
   button and tests do). `sound.isMuted()` is now snooze-aware and has no internal
   caller. Harmless; candidates for removal if the API should stay minimal.

6. **CI re-downloads Chromium every run.** `.github/workflows/ci.yml` runs
   `npx playwright install --with-deps chromium` on both jobs with no browser
   cache, fetching roughly 320 MB per run (Chrome for Testing ~198 MB, Headless
   Shell ~118 MB, plus FFmpeg). Not a correctness problem, since both jobs finish
   well inside the 20-minute timeout. If it ever matters, cache
   `~/.cache/ms-playwright` (Windows: `%USERPROFILE%\AppData\Local\ms-playwright`)
   keyed on the Playwright version, or use the `mcr.microsoft.com/playwright`
   image on Linux.

## Verified as non-issues

- **A `Â·` seen in shell output was not file corruption.** The middle-dot
  separator renders correctly in the tracked files; the artifact was the shell's
  console encoding.

- **There is no in-app stall audio path.** `app.js` owns the only Web Audio
  module, and no `sound.play()` call site fires on a stall. `cards.js` "Stalled"
  is a visual avatar expression only.

## Housekeeping

- The merged branch `fix/snooze-sound-suppression` (local and remote) can be
  deleted.
- Repo-root `AgentWorkshop.exe` is rebuilt via `npm run pack` after user-facing
  changes; it is gitignored and never committed.
