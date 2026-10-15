# Contributing

## Requirements

- Node 24 (active LTS) — declared in `engines.node`
- npm

## Setup

```sh
npm install
npx playwright install chromium   # once, for the smoke tests
npm start                         # Electron window with the in-process bridge
```

## The gate

`npm run ci` is the pre-push gate. It runs ESLint, `prettier --check`, all nine
test suites, and the packaging check:

```sh
npm run ci
```

CI runs the same sequence on Ubuntu, Windows, and macOS, plus an unpacked
packaging build per platform. It runs on pull requests to `master` and on pushes
to `master`.

Useful individual commands:

```sh
npm run lint          # eslint .
npm run format        # prettier --write .
npm test              # nine smoke/unit suites
npm run build:check   # dashboard assets + bridge exports
npm run pack          # Windows portable exe -> repo-root AgentWorkshop.exe
```

## Style

ESLint and Prettier enforce the mechanical parts. Beyond that:

- **Comments explain why, never what.** The code says what it does. Do not add
  comments that restate a line, narrate a change, or label a section. If a
  contract is non-obvious — an ordering requirement, a security guard, a workaround
  for a specific upstream behavior — say so in one line.
- Keep the bridge reusable: `live-bridge.js` must stay require-able both as a CLI
  and in-process from Electron.
- Prefer the Node standard library. That is the entire production dependency
  budget, and there is no plan to spend it.

## Commits

History uses `type(scope): summary` — `fix`, `feat`, `docs`, `chore`, `test`,
`ci`, `style`. Keep the summary in the imperative and under about 70 characters.

## Pull requests

- One concern per PR.
- Say what you changed, how you verified it, and what you did not check.
- If you changed user-facing behavior, note the version impact. Breaking changes
  are major.

## Security

Read [SECURITY.md](SECURITY.md) before changing anything in the bridge's request
handling, static serving, or the event log. The loopback bind, the origin guards,
and the redaction pass are load-bearing. Report vulnerabilities privately, not in
an issue.
