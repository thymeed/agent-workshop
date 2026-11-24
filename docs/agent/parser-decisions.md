# Claude Code parser decisions (unit 2)

Owner decisions for `lib/claude-code-parse.js`. Read before changing the parser or the ingest that feeds it.

- Notification dedupe key = JSON.stringify([toolUseId,status,subagentTokens,toolUses,durationMs]).
- WebFetch URLs host+path only, http/https allowlist.
- Model rank own 4 > resolvedModel 3 > call model 2 > meta 1.
- Spawn row falls back to `worker` when no model is known (ingest feeds the PARENT file before child files).
- Remember-first-family per child.
- `pickedEffortModel` is never used.
- Per-`message.id` usage is a running maximum on purpose.
- `parseMeta()` strings and `parseTaskNotification().status` are raw on purpose.
- Rows carry ids with invisible/bidi characters stripped while `state` keeps raw ids, so match on row ids, never raw transcript ids.
