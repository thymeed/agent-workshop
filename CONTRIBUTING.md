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

`npm run ci` is the pre-push gate. It runs ESLint, `prettier --check`, every test suite, and the packaging check:

```sh
npm run ci
```

CI runs the same sequence on Ubuntu, Windows, and macOS, plus an unpacked
packaging build per platform. It runs on pull requests to `master` and on pushes
to `master`.

Useful individual commands:

```sh
npm run lint          # eslint .
npm run typecheck     # tsc --noEmit (checked JSDoc contract in lib/ + types/)
npm run format        # prettier --write .
npm test              # smoke, unit, and guard suites
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

`master` is always releasable: every commit on it passes `npm run ci`.

## Releases

Work lands on `master` through a pull request, so CI runs against the exact change set
before it merges. For a release, branch as `release/<version>`.

**The changelog boundary is the part that goes wrong.** Follow it literally:

1. While developing, add entries **only** to `## [Unreleased]`. Never touch a section
   that already has a version and a date — that section describes a tag that exists, and
   editing it makes the published changelog disagree with the published artifact.
2. To cut a release, rename `## [Unreleased]` to `## [<version>] - <date>`, then add a
   fresh, **empty** `## [Unreleased]` above it.
3. Bump `package.json` (and regenerate `package-lock.json`) in the same commit, and update
   the README version badge.
4. Add the `[<version>]:` compare link at the bottom, and point `[Unreleased]:` at
   `compare/v<version>...HEAD`.
5. Merge the branch, then tag `v<version>` on the merge commit.

**Tagging publishes.** `.github/workflows/release.yml` fires on any `v*` tag, runs the
full gate on that commit, builds all three platforms, and attaches the artifacts and a
combined `SHA256SUMS.txt` to the GitHub Release. That upload is public and immediate —
the tag is the irreversible step, not the merge. Verify the tag points where you think
before pushing it:

```sh
git rev-parse --short 'v1.3.1^{commit}'   # must be the merge you intend
```

Before tagging, confirm the version is consistent everywhere
(`package.json`, the lockfile, the README badge, and the changelog heading all agree),
and that the changelog section describes what is actually on the tagged commit.

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
