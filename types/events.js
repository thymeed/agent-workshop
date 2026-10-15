/**
 * Shared event-shape typedefs for the bridge <-> dashboard contract.
 * Types only: nothing here runs, and nothing is exported at runtime.
 *
 * Reference from either side with
 *   /** @type {import("../types/events").DashEvent} *\/
 * so a change to the bridge payload surfaces here instead of drifting silently.
 */

/**
 * Event type recorded to persisted history (the stable, documented contract).
 * @typedef {"spawn"|"turn"|"done"|"error"} HistoryEventType
 */

/**
 * One persisted history row. Mirrored by the README "History event contract" block.
 * @typedef {object} HistoryEvent
 * @property {string} ts ISO-8601 timestamp.
 * @property {string} sessionId Transcript session this row belongs to.
 * @property {string} agentId Agent id (subagent uuid, or parent id).
 * @property {string|null} parentId Parent agent id, null for the parent itself.
 * @property {string} name Human-readable agent name.
 * @property {string} model Model key (opus | fable | sonnet | haiku, or raw).
 * @property {HistoryEventType} type
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {string[]} files Paths touched by the turn (may be empty).
 */

/**
 * Live event pushed to `/api/events` and broadcast over SSE (`GET /api/stream`).
 * Shape comes from `pushEvent()` in live-bridge.js.
 * @typedef {object} DashEvent
 * @property {number} id Monotonic id within a bridge session.
 * @property {string} ts Clock label used by the stage (mm:ss style).
 * @property {string} iso ISO-8601 timestamp.
 * @property {"parent"|"advisor"|"worker"|"explorer"|"researcher"|string} role
 * @property {string} kind Stage verb (asks | delegates | edits | status | ...).
 * @property {string} message Display line.
 * @property {string[]} active Roles the stage should highlight.
 * @property {string|null} route Route token to fly, when the kind maps to one.
 * @property {string|null} routeTo Destination station for the route token.
 * @property {number} tokensDelta
 * @property {TokenUsage|null} usage Real transcript usage when present.
 * @property {ActivityItem|null} activity Crate to spawn on the stage, when any.
 * @property {string} source "transcript" unless the bridge synthesizes it.
 * @property {boolean} [replayError] Set on a replayed error row.
 * @property {boolean} [sseBacklog] Set for connect-time SSE backfill.
 */

/**
 * Token usage for one event or aggregate.
 * @typedef {object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {string} [model]
 */

/**
 * Activity row (Activity drawer + crate payload).
 * @typedef {object} ActivityItem
 * @property {"read"|"edit"|string} kind
 * @property {string} path
 * @property {string} detail Short detail. Never full file contents.
 * @property {string} [role]
 * @property {string} [time]
 */

/**
 * Agent alert. Name + status only, never prompt text or file paths.
 * Shape comes from `emitAgentAlert()` in live-bridge.js.
 * @typedef {object} AgentAlert
 * @property {number} id
 * @property {string} ts
 * @property {string} name
 * @property {"finished"|"error"|"stalled"|string} status
 * @property {string} [agentId]
 */

/**
 * Entry in `GET /api/projects`.
 * @typedef {object} ProjectEntry
 * @property {string} id Project directory name.
 * @property {string} label Humanized label.
 * @property {string} path Absolute transcripts path.
 * @property {number} [mtime] Newest transcript mtime in ms.
 */

/**
 * `GET /api/status` payload.
 * @typedef {object} BridgeStatus
 * @property {true} ok
 * @property {number} port
 * @property {string} transcripts
 * @property {string|null} projectId
 * @property {string|null} projectLabel
 * @property {boolean} exists
 * @property {number} events
 * @property {number} sseClients
 * @property {number} watching
 * @property {string|null} lastScanError
 * @property {boolean} snoozed
 * @property {string|null} lastScanAt
 * @property {number} pollMs
 * @property {string} time
 */

module.exports = {};
