# Security policy

## Supported versions

Only the latest release on `master` is supported. There are no backports.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Please do not open a public issue for
anything exploitable.

Include the version or commit, what you did, what happened, and what you expected.
A proof of concept helps. You will get an acknowledgement, and credit in the fix
notes unless you ask otherwise.

## Design posture

The dashboard reads Cursor agent transcripts from disk and renders them. It has no
server component, no telemetry, and no outbound network calls.

- **Zero runtime dependencies.** `dependencies` is empty. The bridge is Node
  standard library only, so the shipped app's supply chain is Electron plus code in
  this repository.
- **Localhost only.** The bridge binds loopback. Requests are rejected unless the
  socket address is loopback, the `Host` header names localhost/loopback, and any
  `Origin` is `http(s)` on the bridge's own port. `Origin: null` is rejected. There
  is no `Access-Control-Allow-Origin: *`.
- **State-changing routes are POST-only and guarded.** `/api/select`,
  `/api/snooze`, and `/api/history/clear` require the `X-Cursor-Bridge: 1` header
  plus `Sec-Fetch-Site: same-origin`/`none` or a valid localhost `Origin`. This
  blocks cross-site simple requests (a cross-site `<img>` cannot set a custom
  header).
- **Secrets are redacted before write.** The local event log runs strings through
  pattern matching for API keys, tokens, passwords, bearer headers, and private key
  blocks before persisting.
- **Event log is local and short-lived.** It lives in the OS app-data profile, never
  the repository, is mode `0o600` in a `0o700` directory on POSIX, and entries older
  than 30 days are pruned on start.
- **Alerts carry no content.** Desktop and in-app alerts include agent name and
  status only — never prompt text, file paths, or file contents.
- **Electron renderer is locked down.** `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`.

## Accepted risks

These are deliberate and known, not defects:

- **No authentication on the bridge.** Any process or user already on your machine
  can reach `127.0.0.1:3847` and read events or switch projects. The loopback bind
  and origin checks defend against _other websites_, not against local code. Do not
  run the bridge on a shared or untrusted machine.
- **Redaction is best-effort.** It matches known credential shapes. A secret in an
  unrecognized format can still be written to the local event log.
- **Builds are unsigned.** No code-signing certificate is configured, so Windows
  and macOS will warn on first launch. Verify the artifact hash if that matters to
  you.
- **Transcript trust.** Transcript JSONL under `~/.cursor/projects/` is parsed and
  rendered. Malicious content there is treated as data; the dashboard does not
  execute it, but it is rendered in the activity preview.
