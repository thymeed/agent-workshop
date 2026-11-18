#!/usr/bin/env node
/**
 * Minimal localhost bridge: tails Cursor agent-transcripts JSONL and serves
 * JSON + SSE for model-routing-dashboard.html Live mode.
 *
 * Usage (CLI):
 *   node live-bridge.js
 *   node live-bridge.js --port 3847
 *   node live-bridge.js --dir "C:\\Users\\...\\agent-transcripts"
 *
 * Usage (Electron / require):
 *   const { startBridge, stopBridge } = require("./live-bridge");
 *   await startBridge({ port: 3847, quiet: true });
 *   // … later …
 *   await stopBridge();
 *
 * Then open http://127.0.0.1:3847/
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createEventLog, resolveLogDir } = require("./lib/event-log");
const { loadOrCreateSalt, resolveSaltDir } = require("./lib/claude-code-sources");
const { createClaudeCodeMode } = require("./lib/claude-code-bridge");
const { createClaudeCodeIngest } = require("./lib/claude-code-ingest");
const wire = require("./lib/claude-code-wire");
const { subagentUuidFromTranscriptPath } = require("./lib/path-segments");
const {
  sendJson,
  readRequestBody,
  allowProjectSelect,
  rejectIfNotLocal,
  serveDashboard,
  serveStatic
} = require("./lib/bridge-http");
const {
  nowIso,
  transcriptTimestamp,
  extractToolResults,
  lineShape,
  turnEndedFromLine,
  terminalTypeFromTranscript,
  resolveTaskChildAgentId,
  agentIdFromFile,
  isSubagentFile,
  roleDisplayName,
  filesFromActivity,
  snippet,
  mapSubagentType,
  isKnownSubagentType,
  roleToCard,
  roleToModel,
  extractDelegationModel,
  estimateUsage,
  toolArgs,
  resolveToolName,
  toolActivity,
  toolEstimateChars,
  onceUsage,
  inferRoleFromSubagentText,
  extractToolUses,
  extractText,
  estimateReadTokens
} = require("./lib/transcript-parse");
const {
  TRANSCRIPT_READ_MAX_PER_POLL,
  readBytesAtSync,
  newlineByteLength,
  findFirstNewlineByte,
  completeLinesEndExclusive,
  forEachCompleteLine,
  findNextNewlineOffset
} = require("./lib/transcript-tail");

const PROJECTS_ROOT = path.join(os.homedir(), ".cursor", "projects");
/** @type {string|null} */
let projectsRootOpt = null;

function projectsRootPath() {
  if (projectsRootOpt) return projectsRootOpt;
  const override = process.env.CURSOR_PROJECTS_ROOT;
  return override ? path.resolve(override) : PROJECTS_ROOT;
}

/**
 * When BRIDGE_TEST=1, refuse to start unless tests pass isolated dirs/port (never relaxes other checks).
 * @param {object} opts
 */
function assertBridgeTestOpts(opts) {
  if (process.env.BRIDGE_TEST !== "1") return;
  opts = opts || {};
  const missing = [];
  if (!opts.eventLogDir) missing.push("eventLogDir");
  if (!opts.projectsRoot && !process.env.CURSOR_PROJECTS_ROOT) {
    missing.push("projectsRoot (opts) or CURSOR_PROJECTS_ROOT");
  }
  const port = opts.port;
  if (port == null || !Number.isFinite(Number(port)) || Number(port) <= 0) {
    missing.push("explicit nonzero port (opts.port)");
  }
  if (missing.length) {
    throw new Error(
      "BRIDGE_TEST=1: startBridge requires isolated test paths. missing " + missing.join(", ")
    );
  }
}

/** Placeholder watch path when no --dir / env / discovered project exists yet. */
function emptyTranscripts() {
  return path.join(projectsRootPath(), "_none", "agent-transcripts");
}
const MAX_EVENTS = 400;
/** In-memory ring for agent alerts (SSE + GET /api/alerts). */
const MAX_ALERTS = 50;
const POLL_MS = 900;
/** Max transcript JSONL files polled per scan (newest by mtime). */
const TRANSCRIPT_SCAN_LIMIT = 40;
/** Newest history events returned per request; bounds the replay list on long sessions. */
const MAX_HISTORY_EVENTS = 2000;
const TRANSCRIPT_TAIL_BYTES = 8192;
/** Default agent stall threshold for desktop alerts (no activity). */
const DEFAULT_STALL_MS = 120000;
const STALL_CHECK_MS = 15000;
/** @type {number} */
let stallMs = DEFAULT_STALL_MS;
/** When false, transcript handlers skip history persistence and alerts (warm-up tail). */
let historyIngestRecording = false;
/** Dedupe keys for persisted transcript history within a bridge session. */
const seenHistoryKeys = new Set();
/** @type {string} */
let currentIngestFile = "";
/** @type {number} */
let currentIngestLine = 0;

let PORT = 3847;
/** Identity token for /api/status; Electron refuses foreign listeners on the bridge port. */
const BRIDGE_ID = "cursor-agents-model-routing-v1";
/** What a fresh bridge reads and what the dashboard assumes before it is told otherwise. */
const DEFAULT_SOURCE = "claude-code";
/** @type {string} */
let TRANSCRIPTS = emptyTranscripts();
/** @type {string|null} */
let currentProjectId = null;
/** @type {string|null} */
let currentProjectLabel = null;
/**
 * Data source: "claude-code" (default) or "cursor". In memory only. The Claude Code side keeps
 * its own selection inside `claudeCode`, so switching never clobbers the Cursor project above.
 * @type {"cursor"|"claude-code"}
 */
let source = DEFAULT_SOURCE;
/**
 * True when this process started with an explicit Cursor folder. It describes how the process
 * started, so it stays true after a later switch to Claude Code and back. Only a boolean is
 * ever served, never the folder.
 */
let explicitCursorDir = false;
/** @type {ReturnType<typeof createClaudeCodeMode>|null} */
let claudeCode = null;
/** Claude Code tail for the selected project (one per selection), or null. Never serialised.
 * @type {null|{ingest:ReturnType<typeof createClaudeCodeIngest>, sessions:number, caughtUp:boolean, models:string, driftTotal:number, unknownStatus:number}} */
let claudeTail = null;
/** Latest slot -> model id map sent to the dashboard (Claude Code mode), '{}' until known. */
let claudeModels = {};
/** Ingest polls per scan while capped unread bytes remain (keeps catch-up fast, bounded). Waits
 * the ingest counts in polls (meta wait, child hold, session hold) are never spun through. */
const MAX_CATCHUP_POLLS = 20;
/** ISO time the Claude Code drift counters last grew. */
let claudeDriftAt = null;

/** @type {Array<object>} */
const events = [];
/** @type {Array<{alert:{id:number,ts:string,name:string,status:string,agentId?:string}, source:string}>} */
const alerts = [];
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
/** filePath -> { size, warm, lineSeq } */
const fileState = new Map();
/** Transcript JSONL paths present at last inventory snapshot (startup / project reset). */
const transcriptFilesAtStart = new Set();
/** filePath -> byte length at last inventory snapshot */
const transcriptSnapshotSizes = new Map();
/** Files in the first scan slice after inventory. Use 8 KB tail warm-up, not snapshot offset. */
const transcriptStartupWarmFiles = new Set();
/** True until the first scan() pass marks warm-up files after snapshotTranscriptInventory(). */
let warmScanAfterInventory = false;
/** subagent uuid -> role */
const subagentRoles = new Map();
let eventSeq = 0;
let alertSeq = 0;
let lastScanError = null;
/** ISO time of the most recent scan() pass (near-real poll, not hook-level). */
let lastScanAt = null;

/**
 * Transcript drift counters. Cursor owns the on-disk format and changes it without
 * notice, and a reshaped line used to be dropped in silence: the dashboard simply looked
 * quiet. Counting unreadable and unrecognized lines turns that into a visible signal.
 */
const drift = { unparsed: 0, unknownShape: 0, unknownStatus: 0, lastAt: null, lastSample: "" };
/** Report the first drift of a bridge session once, not once per line. */
let driftReported = false;

/** @type {http.Server|null} */
let server = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let stallTimer = null;
let quiet = false;
let started = false;

/** @type {ReturnType<typeof createEventLog>|null} */
let eventLog = null;
/** @type {((alert:{name:string,status:string})=>void)|null} */
let onAgentAlert = null;
/** True while alert snooze is on: gates Electron desktop toasts (SSE + ring still flow). */
let snoozeIndefinite = false;
/** agentId -> { name, lastSeen, terminal, stallAlerted } */
const agentWatch = new Map();

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function log(...args) {
  if (!quiet) console.log(...args);
}

function logErr(...args) {
  if (!quiet) console.error(...args);
}

function clock() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function humanizeProjectId(id) {
  return (
    String(id || "")
      .replace(/^c-Users-[^-]+-/i, "")
      .replace(/-/g, " ")
      .trim() || id
  );
}

/**
 * Discover Cursor projects that have an agent-transcripts folder.
 * @returns {Array<{id:string,label:string,path:string,mtime:number}>}
 */
function discoverProjects() {
  const out = [];
  const root = projectsRootPath();
  if (!fs.existsSync(root)) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const transcriptsPath = path.join(root, id, "agent-transcripts");
    if (!fs.existsSync(transcriptsPath)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(transcriptsPath).mtimeMs;
      // Bump with newest top-level entry mtime (cheap; avoids full walk)
      const kids = fs.readdirSync(transcriptsPath, { withFileTypes: true });
      for (const kid of kids) {
        try {
          mtime = Math.max(mtime, fs.statSync(path.join(transcriptsPath, kid.name)).mtimeMs);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
    out.push({
      id,
      label: humanizeProjectId(id),
      path: transcriptsPath,
      mtime
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function projectById(id) {
  if (!id) return null;
  const projects = discoverProjects();
  return projects.find((p) => p.id === id) || null;
}

function isPathUnderProjectsRoot(absPath) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(projectsRootPath());
  const rel = path.relative(root, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * True when the user named a Cursor transcripts folder (`--dir`, `opts.dir` or
 * CURSOR_TRANSCRIPTS). That is an explicit ask for Cursor, so the bridge starts in Cursor
 * mode instead of the Claude Code default.
 */
function hasExplicitCursorDir(opts) {
  return !!((opts && opts.dir) || flag("--dir") || process.env.CURSOR_TRANSCRIPTS);
}

function resolveDefaultTranscripts(opts) {
  opts = opts || {};
  const fromFlag = opts.dir || flag("--dir") || process.env.CURSOR_TRANSCRIPTS;
  if (fromFlag) {
    const abs = path.resolve(fromFlag);
    TRANSCRIPTS = abs;
    // Try to map back to a known project id
    if (isPathUnderProjectsRoot(abs)) {
      const parts = path.relative(path.resolve(projectsRootPath()), abs).split(path.sep);
      if (parts.length >= 1) {
        currentProjectId = parts[0];
        currentProjectLabel = humanizeProjectId(parts[0]);
      }
    } else {
      currentProjectId = null;
      currentProjectLabel = path.basename(abs);
    }
    return TRANSCRIPTS;
  }

  const projects = discoverProjects();
  if (projects.length) {
    const newest = projects[0];
    TRANSCRIPTS = newest.path;
    currentProjectId = newest.id;
    currentProjectLabel = newest.label;
    return TRANSCRIPTS;
  }

  // Runtime placeholder under the projects root. No hardcoded machine/user path
  TRANSCRIPTS = emptyTranscripts();
  currentProjectId = null;
  currentProjectLabel = "no Cursor projects found";
  return TRANSCRIPTS;
}

function broadcastSse(eventName, data) {
  const payload = (eventName ? `event: ${eventName}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function pushEvent(partial) {
  const ev = {
    id: ++eventSeq,
    ts: clock(),
    iso: nowIso(),
    role: partial.role || "parent",
    kind: partial.kind || "status",
    message: partial.message || "",
    active: partial.active || [],
    route: partial.route || null,
    routeTo: partial.routeTo || null,
    tokensDelta: partial.tokensDelta || 0,
    usage: partial.usage != null ? partial.usage : null,
    /* Raw model slug a delegation pinned, when the transcript names one. Display only:
       billed usage still follows the role's rate bucket. */
    modelRaw: partial.modelRaw || null,
    modelLabel: partial.modelLabel || null,
    activity: partial.activity != null ? partial.activity : null,
    source: partial.source || "transcript"
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcastSse(null, ev);
  return ev;
}

/**
 * Push one Claude Code event (fields from lib/claude-code-wire.js). Separate from pushEvent so
 * Cursor events stay byte for byte as they were. Never touches the event log or History.
 * @param {Record<string, any>} fields
 */
function pushClaudeEvent(fields, replay) {
  const ev = {
    id: ++eventSeq,
    ...fields,
    ...(replay ? { replay: true } : {}),
    ts: fields.ts || clock(),
    iso: fields.iso || nowIso()
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcastSse(null, ev);
  return ev;
}

/**
 * Push an agent alert to the in-memory ring, SSE-broadcast it, and notify Electron.
 * Privacy: name + status (+ optional agentId) only. Never prompts or file paths.
 * While alert snooze is on the desktop toast is suppressed; the ring and SSE still flow.
 * @param {string} name
 * @param {string} status
 * @param {string} [agentId]
 */
function emitAgentAlert(name, status, agentId) {
  const alert = {
    id: ++alertSeq,
    ts: nowIso(),
    name: String(name || "agent"),
    status: String(status || "")
  };
  const id = agentId != null && String(agentId) ? String(agentId) : "";
  if (id) alert.agentId = id;

  /* The ring keeps an internal source tag so GET /api/alerts can serve only the current
     source's alerts. The tag never leaves the process: SSE and the response use `alert`. */
  alerts.push({ alert, source });
  if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);

  broadcastSse("alert", alert);

  if (!snoozeIndefinite && typeof onAgentAlert === "function") {
    try {
      // Desktop notifications: name + status only (same privacy rule).
      onAgentAlert({ name: alert.name, status: alert.status });
    } catch (_e) {
      /* ignore alert handler failures */
    }
  }
}

function isStallTrackedAgent(agentId) {
  const id = String(agentId || "");
  if (!id || id.startsWith("parent:")) return false;
  return true;
}

/**
 * @param {string} agentId
 * @param {string} name
 * @param {"finished"|"error"|null} terminalStatus
 * @param {{stallTrack?:boolean}} [opts]
 */
function touchAgentWatch(agentId, name, terminalStatus, opts) {
  opts = opts || {};
  const id = String(agentId || "");
  if (!id) return;
  const trackStall = opts.stallTrack != null ? opts.stallTrack : isStallTrackedAgent(id);
  const prev = agentWatch.get(id) || {
    name: name || id,
    lastSeen: Date.now(),
    terminal: null,
    stallAlerted: false
  };
  prev.name = name || prev.name || id;

  if (terminalStatus) {
    const already = !!prev.terminal;
    /* Repeat terminals are deduped so a long session cannot stream one alert per turn.
       An error still surfaces after a success, but a repeated error does not repeat. */
    if (already && terminalStatus !== "error") {
      agentWatch.set(id, prev);
      return;
    }
    if (already && prev.terminal === "error") {
      agentWatch.set(id, prev);
      return;
    }
    prev.terminal = terminalStatus;
    prev.stallAlerted = true;
    agentWatch.set(id, prev);
    /* The caller decides whether this terminal is worth a toast. A parent `success` is
       the end of every user turn, so alerting it would be noise and a false "finished". */
    if (opts.alertTerminal !== false) emitAgentAlert(prev.name, terminalStatus, id);
    return;
  }

  if (!trackStall) return;
  prev.lastSeen = Date.now();
  agentWatch.set(id, prev);
}

function checkStalledAgents() {
  if (source !== "cursor") return; // stall watch belongs to the Cursor tree only
  const now = Date.now();
  for (const [id, state] of agentWatch) {
    if (!state || state.terminal || state.stallAlerted) continue;
    if (!isStallTrackedAgent(id)) continue;
    if (now - state.lastSeen >= stallMs) {
      state.stallAlerted = true;
      agentWatch.set(id, state);
      emitAgentAlert(state.name, "stalled", id);
    }
  }
}

function sessionIdFromFile(filePath, transcriptsRoot) {
  const root = transcriptsRoot || TRANSCRIPTS;
  try {
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith("..")) return currentProjectId || "session";
    const parts = rel.split(path.sep).filter(Boolean);
    return parts[0] || currentProjectId || "session";
  } catch (_e) {
    return currentProjectId || "session";
  }
}

/** Session ids present under the current transcripts tree (top-level folder per file). */
function sessionIdsInTranscripts(root) {
  const ids = new Set();
  const transcriptsRoot = root || TRANSCRIPTS;
  if (!transcriptsRoot) return ids;
  for (const f of listJsonlFiles(transcriptsRoot)) {
    ids.add(sessionIdFromFile(f, transcriptsRoot));
  }
  return ids;
}

/**
 * Newest session for this project: first non-empty transcript by mtime (listJsonlFiles order).
 * @param {string} [root] defaults to TRANSCRIPTS
 * @returns {string|null}
 */
function latestSessionIdForTranscripts(root) {
  const transcriptsRoot = root || TRANSCRIPTS;
  if (!transcriptsRoot || !fs.existsSync(transcriptsRoot)) return null;
  const files = listJsonlFiles(transcriptsRoot);
  for (const f of files) {
    try {
      if (fs.statSync(f).size > 0) return sessionIdFromFile(f, transcriptsRoot);
    } catch (_e) {
      /* try next */
    }
  }
  if (files.length) return sessionIdFromFile(files[0], transcriptsRoot);
  return null;
}

function filterHistoryToCurrentProject(events) {
  const allowed = sessionIdsInTranscripts(TRANSCRIPTS);
  if (!allowed.size) return [];
  return (events || []).filter((ev) => allowed.has(String(ev.sessionId || "")));
}

/**
 * Persist a contract-shaped history event (redacted inside event-log).
 * @param {object} partial
 * @param {{stallTrack?:boolean, record?:boolean}} [meta]
 * @returns {object|null}
 */
function recordHistoryEvent(partial, meta) {
  meta = meta || {};
  if (meta.record === false) return null;
  if (!eventLog) return null;
  const ev = eventLog.append(partial);
  if (!ev) return null;
  const stallTrack = meta.stallTrack != null ? meta.stallTrack : isStallTrackedAgent(ev.agentId);
  const alertTerminal = meta.alertTerminal !== false;
  if (ev.type === "done") {
    touchAgentWatch(ev.agentId, ev.name, "finished", { stallTrack, alertTerminal });
  } else if (ev.type === "error") {
    touchAgentWatch(ev.agentId, ev.name, "error", { stallTrack, alertTerminal });
  } else {
    touchAgentWatch(ev.agentId, ev.name, null, { stallTrack });
  }
  return ev;
}

function historyKeyForIngest(partial) {
  if (!currentIngestFile || !currentIngestLine) return null;
  const type = partial && partial.type ? partial.type : "";
  const agentId = partial && partial.agentId ? partial.agentId : "";
  const ts = partial && partial.ts ? partial.ts : "";
  return currentIngestFile + ":" + currentIngestLine + ":" + type + ":" + agentId + ":" + ts;
}

/** Gate history + alerts to transcript bytes after per-file warm-up. */
function recordHistoryFromTranscript(partial, meta) {
  if (!historyIngestRecording) return null;
  meta = meta || {};
  const historyKey = meta.historyKey || historyKeyForIngest(partial);
  if (historyKey && seenHistoryKeys.has(historyKey)) return null;
  const ev = recordHistoryEvent(partial, meta);
  if (ev && historyKey) seenHistoryKeys.add(historyKey);
  return ev;
}

function clearWatchState() {
  events.length = 0;
  fileState.clear();
  subagentRoles.clear();
  seenHistoryKeys.clear();
  drift.unparsed = 0;
  drift.unknownShape = 0;
  drift.unknownStatus = 0;
  drift.lastAt = null;
  drift.lastSample = "";
  driftReported = false;
  // Keep eventSeq monotonic so client after= / seenLiveIds stay valid across project switches
  lastScanError = null;
}

/**
 * Enter (or refresh) Claude Code mode: no Cursor event, stall watch or alert is shown or sent
 * (Cursor alerts stay in the ring tagged "cursor" and are served again after switching back).
 */
function resetClaudeWatch() {
  clearWatchState();
  agentWatch.clear();
  const sel = claudeCode.selection();
  broadcastSse("reset", { ok: true, source, projectId: sel.id, projectLabel: sel.label });
  pushEvent({
    role: "parent",
    kind: "status",
    message: sel.label
      ? "bridge online · watching " + sel.label
      : "bridge online · choose a Claude Code project",
    active: [],
    source: "bridge"
  });
}

/** Start tailing the selected project (drops any earlier tail). No selection: no tail. */
function beginClaudeTail() {
  claudeTail = null;
  claudeModels = {};
  claudeDriftAt = null;
  const dir = claudeCode && claudeCode.projectDir();
  if (!dir) return;
  claudeTail = {
    ingest: createClaudeCodeIngest({ projectDir: dir }),
    sessions: 0,
    caughtUp: false,
    models: "",
    driftTotal: 0,
    unknownStatus: 0
  };
}

/** Send the slot -> model map when it changed (the dashboard feeds it to RoleProfiles.setModels). */
function publishClaudeModels(t) {
  const map = wire.resolveSlotModels(t.ingest.models());
  const text = JSON.stringify(map);
  if (text === t.models) return;
  t.models = text;
  claudeModels = map;
  broadcastSse("models", { models: map });
}

/** One row of a Claude Code session: event always, alert only when live. */
function ingestClaudeRow(t, row, live) {
  const fields = wire.eventFromRow(row);
  if (fields.statusKnown === false) t.unknownStatus += 1;
  pushClaudeEvent(fields, !live);
  const alert = live ? wire.alertFromRow(row) : null;
  if (alert) emitAgentAlert(alert.name, alert.status, alert.agentId);
}

/**
 * Poll the Claude Code tail: one regular poll per scan, then catch-up polls (which advance no
 * poll-counted wait) while capped unread bytes remain, bounded. Rows before the live phase, and
 * rows of a newer session, are a replay: they fill the stage (marked `replay`) but never alert.
 * The live phase starts only after a poll whose ingest facts say the current session's parent
 * was read to its end without error, nothing is capped, and no wait is pending. A failed read,
 * a vanished parent or an empty folder therefore never starts it, and a new session or reset
 * restarts the replay.
 */
function scanClaudeCode() {
  const t = claudeTail;
  if (!t) return;
  for (let i = 0; i < MAX_CATCHUP_POLLS; i++) {
    const rows = t.ingest.poll({ catchUp: i > 0 });
    const st = t.ingest.stats();
    const d = st.drift;
    const driftSum = d.unparsed + d.oversize + d.metaBad + d.unreadable + d.dirCut;
    if (t.sessions > 0 && st.sessions !== t.sessions) {
      // a newer session (or a rewritten file) replays from its start: clear first
      resetClaudeWatch();
      t.caughtUp = false;
      t.models = "";
      t.unknownStatus = 0;
      t.driftTotal = driftSum;
      claudeDriftAt = null;
    }
    t.sessions = st.sessions;
    for (const row of rows) ingestClaudeRow(t, row, t.caughtUp);
    publishClaudeModels(t);
    const total = driftSum + t.unknownStatus;
    if (total !== t.driftTotal) {
      t.driftTotal = total;
      claudeDriftAt = nowIso();
    }
    if (st.parentRead && !st.capped && !st.more && !st.waiting) t.caughtUp = true;
    if (!st.capped) break;
  }
}

function resetWatchState() {
  if (source === "claude-code") {
    resetClaudeWatch();
    return;
  }
  clearWatchState();
  snapshotTranscriptInventory();
  broadcastSse("reset", {
    ok: true,
    source,
    transcripts: TRANSCRIPTS,
    projectId: currentProjectId,
    projectLabel: currentProjectLabel,
    latestSessionId: latestSessionIdForTranscripts(TRANSCRIPTS)
  });
  scan();
  if (!events.length) {
    pushEvent({
      role: "parent",
      kind: "status",
      message: "bridge online · watching " + (currentProjectLabel || TRANSCRIPTS),
      active: [],
      source: "bridge"
    });
  }
}

function selectProject(id) {
  if (source !== "cursor") return { ok: false, error: "Unknown or disallowed project id" };
  const proj = projectById(id);
  if (!proj) {
    return { ok: false, error: "Unknown or disallowed project id" };
  }
  if (!isPathUnderProjectsRoot(proj.path)) {
    return { ok: false, error: "Path escapes Cursor projects root" };
  }
  TRANSCRIPTS = proj.path;
  currentProjectId = proj.id;
  currentProjectLabel = proj.label;
  resetWatchState();
  const latestSessionId = latestSessionIdForTranscripts(TRANSCRIPTS);
  return {
    ok: true,
    projectId: currentProjectId,
    projectLabel: currentProjectLabel,
    transcripts: TRANSCRIPTS,
    latestSessionId
  };
}

function statusPayload() {
  return {
    ok: true,
    bridgeId: BRIDGE_ID,
    source,
    explicitDir: explicitCursorDir,
    port: PORT,
    transcripts: TRANSCRIPTS,
    projectId: currentProjectId,
    projectLabel: currentProjectLabel,
    exists: fs.existsSync(TRANSCRIPTS),
    events: events.length,
    sseClients: sseClients.size,
    watching: fileState.size,
    lastScanError,
    /** Transcript lines this build could not read. Non-zero means the on-disk format moved. */
    drift: {
      unparsed: drift.unparsed,
      unknownShape: drift.unknownShape,
      unknownStatus: drift.unknownStatus,
      lastAt: drift.lastAt,
      lastSample: drift.lastSample
    },
    /** Alert snooze state (gates Electron desktop toasts; ring/SSE still flow). */
    snoozed: snoozeIndefinite,
    /** Last transcript poll time. Near-real file polling (~pollMs), not hook-level realtime. */
    lastScanAt,
    pollMs: POLL_MS,
    time: nowIso()
  };
}

/** /api/status in Claude Code mode: no transcripts path, no `exists`, no drift sample text. */
async function claudeStatusPayload(cc) {
  const sel = cc.selection();
  const pub = await cc.statusBody();
  const ing = claudeTail ? claudeTail.ingest.stats() : null;
  return {
    ok: true,
    bridgeId: BRIDGE_ID,
    port: PORT,
    ...pub,
    explicitDir: explicitCursorDir,
    projectId: sel.id,
    projectLabel: sel.label,
    events: events.length,
    sseClients: sseClients.size,
    watching: ing ? ing.files : 0,
    lastScanError: ing && ing.projectMissing ? "project folder missing" : null,
    /* Counts only, never samples: the ingest's own drift is folded in. */
    drift: {
      unparsed: drift.unparsed + (ing ? ing.drift.unparsed : 0),
      unknownShape: drift.unknownShape,
      unknownStatus: drift.unknownStatus + (claudeTail ? claudeTail.unknownStatus : 0),
      oversize: ing ? ing.drift.oversize : 0,
      metaBad: ing ? ing.drift.metaBad : 0,
      unreadable: ing ? ing.drift.unreadable : 0,
      dirCut: ing ? ing.drift.dirCut : 0,
      lastAt: claudeDriftAt || drift.lastAt,
      lastSample: ""
    },
    models: claudeModels,
    ingest: ing
      ? {
          files: ing.files,
          lines: ing.lines,
          rows: ing.rows,
          sessions: ing.sessions,
          more: ing.more,
          heldChildren: ing.heldChildren
        }
      : null,
    snoozed: snoozeIndefinite,
    lastScanAt,
    pollMs: POLL_MS,
    time: nowIso()
  };
}

/** POST /api/select in Claude Code mode: the id must come from the last discovery. */
async function selectClaudeProject(cc, id) {
  /* The guard runs inside select(), right before the selection is stored, so a select that
     raced a source switch or a stop is refused without changing the stored selection. */
  const r = await cc.select(id, () => source === "claude-code" && claudeCode === cc);
  if (!r.ok || source !== "claude-code" || claudeCode !== cc) {
    return { status: 400, body: { ok: false, error: "Unknown or disallowed project id" } };
  }
  resetClaudeWatch();
  beginClaudeTail();
  const sel = cc.selection();
  return {
    status: 200,
    body: { ok: true, projectId: sel.id, projectLabel: sel.label, source }
  };
}

/**
 * Claude Code mode with nothing selected: select the newest project (the picker's first entry,
 * as Cursor does at startup) so tailing starts and the picker shows what the bridge reads. Never
 * replaces a selection (the user's, or one kept from before a switch away); zero projects or a
 * failed discovery leave things as they are. Uses the stable project id only.
 */
async function autoSelectNewestClaude() {
  const cc = claudeCode;
  const stillOurs = () => source === "claude-code" && claudeCode === cc && !cc.selection().id;
  try {
    if (!cc || !stillOurs()) return;
    const body = await cc.projectsBody();
    const newest = body.projects[0];
    if (!newest || !stillOurs()) return;
    const r = await cc.select(newest.id, stillOurs);
    if (!r.ok || source !== "claude-code" || claudeCode !== cc) return;
    resetClaudeWatch();
    beginClaudeTail();
  } catch (_e) {
    /* discovery failed: the picker and notes already say so; the next switch or start retries */
  }
}

/** Switch source. Cursor selection and watch state are restored by a normal reset. */
function setSource(next) {
  if (next === source) {
    if (source === "claude-code") claudeCode.invalidate();
    return;
  }
  source = next;
  if (next === "claude-code") {
    claudeCode.invalidate();
    resetClaudeWatch();
    beginClaudeTail();
    void autoSelectNewestClaude();
  } else {
    claudeTail = null;
    claudeModels = {};
    resetWatchState();
  }
}

/**
 * Record one unreadable or unrecognized transcript line and report the first one.
 * A silent drop is the failure mode that hid a real format drift: the dashboard looks
 * quiet rather than wrong, so the user has to notice an absence. This makes it loud.
 * @param {"unparsed"|"unknown"} kind
 * @param {string} sample
 */
function noteDrift(kind, sample) {
  /* Warm-up and project-switch rescans re-read a file's tail. Those bytes were already
     observed, so counting them again would inflate the totals and make a switch look like
     fresh drift. Only lines arriving now are new evidence about the format. */
  if (!historyIngestRecording) return;
  if (kind === "unparsed") drift.unparsed += 1;
  else if (kind === "status") drift.unknownStatus += 1;
  else drift.unknownShape += 1;
  drift.lastAt = nowIso();
  drift.lastSample = snippet(sample, 120);
  if (driftReported) return;
  driftReported = true;
  const what =
    kind === "unparsed"
      ? "unparsed line"
      : kind === "status"
        ? "unrecognized terminal status"
        : "unrecognized line shape";
  pushEvent({
    role: "parent",
    kind: "status",
    message: "transcript drift · " + what + " · this build may be behind Cursor's format",
    active: [],
    source: "bridge"
  });
}

/**
 * Terminal reasons that mean the user stopped the turn, not that anything broke.
 * These still record as an error row (that is what the transcript says) but do not toast.
 * @param {string} reason
 */
function isCancellation(reason) {
  const r = String(reason || "")
    .toLowerCase()
    .trim();
  return r === "user_stopped_generation" || r === "composer_abort_controller_aborted";
}

/**
 * Real transcripts end a turn with {"type":"turn_ended","status":...}. Those lines carry
 * no `role`, so the conversation handlers skip them and the legacy assistant tag path
 * never fires on disk. Recording them here is what makes `done` / `error` rows exist and
 * lets a subagent's completion reach the alert center.
 * @param {object} obj
 * @param {string} filePath
 * @param {boolean} isSub
 */
function handleTerminalLine(obj, filePath, isSub) {
  const terminal = turnEndedFromLine(obj);
  if (!terminal) return;
  /* A turn_ended status this build does not recognize is vocabulary drift, not an unknown
     shape: Cursor added a terminal state. Report it rather than quietly filing the line as
     a mid-turn row, which is what hid `status:"aborted"` in a real corpus audit. */
  if (!terminal.known) noteDrift("status", JSON.stringify(obj));
  const role = isSub ? roleForFile(filePath) || "worker" : "parent";
  const name = roleDisplayName(role);
  const type = /** @type {"done"|"error"|"turn"} */ (terminal.type || "turn");
  const src = path.basename(filePath);

  /* The reason rides the event stream (local UI), never the alert payload, which the
     project keeps to name + status so it cannot leak a path or a prompt. */
  if (terminal.reason) {
    pushEvent({
      role,
      kind: "status",
      message: "turn ended · " + (terminal.status || "?") + " · " + terminal.reason,
      active: [roleToCard(role)],
      source: src
    });
  }

  recordHistoryFromTranscript(
    {
      ts: transcriptTimestamp(obj),
      sessionId: sessionIdFromFile(filePath),
      agentId: agentIdFromFile(filePath, role),
      parentId: isSub ? "parent:parent" : null,
      name,
      model: roleToModel(role),
      type,
      inputTokens: 0,
      outputTokens: 0,
      files: []
    },
    {
      /* A subagent is short-lived, so its terminal is the real finish and worth a toast.
         The parent ends a turn on every user message, so only its errors do. */
      alertTerminal: isSub || (type === "error" && !isCancellation(terminal.reason))
    }
  );
}

function handleParentLine(obj, filePath) {
  if (!obj || !obj.role) return;
  const src = path.basename(filePath);

  if (obj.role === "user") {
    const text = extractText(obj);
    const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    const body = snippet(q ? q[1] : text, 96);
    if (!body) return;
    const usage = estimateUsage("parent", obj, { inText: text, outText: "" });
    pushEvent({
      role: "parent",
      kind: "message",
      message: "task / turn · " + body,
      active: ["opus"],
      usage,
      source: src
    });
    recordHistoryFromTranscript({
      ts: transcriptTimestamp(obj),
      sessionId: sessionIdFromFile(filePath),
      agentId: agentIdFromFile(filePath, "parent"),
      parentId: null,
      name: roleDisplayName("parent"),
      model: roleToModel("parent"),
      type: "turn",
      inputTokens: usage.in,
      outputTokens: usage.out,
      files: []
    });
    return;
  }

  if (obj.role !== "assistant") return;

  const text = extractText(obj);
  const tools = extractToolUses(obj);
  let outChars = String(text || "").length;
  for (const t of tools) outChars += toolEstimateChars(t);
  const takeUsage = onceUsage(estimateUsage("parent", obj, { inText: "", outChars }));
  const parentFiles = [];

  for (const tool of tools) {
    const name = tool.name || "";
    const input = tool.input || {};
    const args = toolArgs(tool);

    const isTask =
      name === "Task" ||
      (name === "CallDynamicTool" && (input.toolName === "Task" || (args && args.subagent_type)));

    if (isTask) {
      const subType = args.subagent_type || input.subagent_type || "";
      const role = mapSubagentType(subType);
      /* Local, log-only marker: Cursor can add a subagent type we do not know yet,
         and silently showing it as a worker hides a format drift. */
      const unknownRole = !!subType && !isKnownSubagentType(subType);
      const desc = snippet(args.description || args.prompt || subType || "subagent", 72);
      /* The model the delegation pinned, read from the same args the role comes from.
         Empty label when the child inherits, so a station never shows "inherit". */
      const model = extractDelegationModel(tool);
      const card = roleToCard(role);
      const delegate = card !== "opus";
      const usage = takeUsage();
      pushEvent({
        role: delegate ? role : "parent",
        kind: "delegates",
        message:
          "delegates · " +
          (subType || role) +
          (unknownRole ? " · unrecognized role" : "") +
          (model.label ? " · " + model.label : "") +
          " · " +
          desc,
        active: delegate ? [card] : ["opus"],
        route: "delegates",
        routeTo: card,
        tokensDelta: role === "explorer" || role === "researcher" ? 24000 : 0,
        usage,
        modelRaw: model.slug || null,
        modelLabel: model.label || null,
        source: src
      });
      const childId = resolveTaskChildAgentId(args, input);
      if (childId) {
        recordHistoryFromTranscript({
          ts: transcriptTimestamp(obj),
          sessionId: sessionIdFromFile(filePath),
          agentId: childId,
          parentId: agentIdFromFile(filePath, "parent"),
          name: roleDisplayName(role),
          model: roleToModel(role),
          modelRaw: model.slug || "",
          type: "spawn",
          inputTokens: usage ? usage.in : 0,
          outputTokens: usage ? usage.out : 0,
          files: []
        });
      } else {
        /* Real delegations carry no child id, so the spawn row cannot be keyed to the
           child and the model would be lost with it. The subagent's own file already
           attributes the role; what only this line knows is the model it routed to.
           Record that on the parent so History replay can name it too. */
        recordHistoryFromTranscript({
          ts: transcriptTimestamp(obj),
          sessionId: sessionIdFromFile(filePath),
          agentId: agentIdFromFile(filePath, "parent"),
          parentId: null,
          name: roleDisplayName("parent"),
          model: roleToModel(role),
          modelRaw: model.slug || "",
          type: "turn",
          inputTokens: 0,
          outputTokens: 0,
          files: []
        });
      }
      continue;
    }

    if (
      name === "UpdateCurrentStep" ||
      (name === "CallDynamicTool" && input.toolName === "UpdateCurrentStep")
    ) {
      const step = args.current_step || input.current_step;
      if (step) {
        pushEvent({
          role: "parent",
          kind: "status",
          message: "step · " + snippet(step, 80),
          active: ["opus"],
          usage: takeUsage(),
          source: src
        });
      }
      continue;
    }

    const activity = toolActivity(tool);
    if (activity) {
      if (activity.path) parentFiles.push(activity.path);
      const label =
        activity.kind +
        " · " +
        snippet(activity.path || activity.detail || resolveToolName(tool), 72);
      pushEvent({
        role: "parent",
        kind: "status",
        message: label,
        active: ["opus"],
        usage: takeUsage(),
        activity,
        source: src
      });
    }
  }

  if (text && tools.length === 0) {
    const usage = takeUsage();
    pushEvent({
      role: "parent",
      kind: "message",
      message: "reply · " + snippet(text, 90),
      active: ["opus"],
      usage,
      source: src
    });
    recordHistoryFromTranscript({
      ts: transcriptTimestamp(obj),
      sessionId: sessionIdFromFile(filePath),
      agentId: agentIdFromFile(filePath, "parent"),
      parentId: null,
      name: roleDisplayName("parent"),
      model: roleToModel("parent"),
      type: "turn",
      inputTokens: usage ? usage.in : 0,
      outputTokens: usage ? usage.out : 0,
      files: parentFiles
    });
  } else {
    // Tools emitted nothing (or only non-activity tools). Still bill the turn once.
    const leftover = takeUsage();
    if (leftover && text) {
      pushEvent({
        role: "parent",
        kind: "message",
        message: "reply · " + snippet(text, 90),
        active: ["opus"],
        usage: leftover,
        source: src
      });
    }
    if (leftover || parentFiles.length || tools.length) {
      recordHistoryFromTranscript({
        ts: transcriptTimestamp(obj),
        sessionId: sessionIdFromFile(filePath),
        agentId: agentIdFromFile(filePath, "parent"),
        parentId: null,
        name: roleDisplayName("parent"),
        model: roleToModel("parent"),
        type: "turn",
        inputTokens: leftover ? leftover.in : 0,
        outputTokens: leftover ? leftover.out : 0,
        files: parentFiles
      });
    }
  }
}

function handleSubagentLine(obj, filePath, roleHint) {
  if (!obj || !obj.role) return;
  let role = roleHint || "worker";
  const src = path.basename(filePath);

  if (obj.role === "user") {
    if (extractToolResults(obj).length) {
      return;
    }

    const text = extractText(obj);
    const ts = transcriptTimestamp(obj);
    const sessionId = sessionIdFromFile(filePath);
    const inferred = inferRoleFromSubagentText(text);
    if (inferred !== "parent") role = inferred;
    const uuid = subagentUuidFromTranscriptPath(filePath);
    if (uuid) subagentRoles.set(uuid, role);
    const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    const body = snippet(q ? q[1] : text, 80);
    const usage = estimateUsage(role, obj, { inText: text, outText: "" });
    pushEvent({
      role,
      kind: "delegates",
      message: "spawned · " + body,
      active: [roleToCard(role)],
      route: role === "advisor" ? "asks" : "delegates",
      routeTo: roleToCard(role),
      tokensDelta: role === "explorer" || role === "researcher" ? estimateReadTokens(text) : 0,
      usage,
      source: src
    });
    recordHistoryFromTranscript({
      ts,
      sessionId,
      agentId: agentIdFromFile(filePath, role),
      parentId: "parent:parent",
      name: roleDisplayName(role),
      model: roleToModel(role),
      type: "spawn",
      inputTokens: usage.in,
      outputTokens: usage.out,
      files: []
    });
    return;
  }

  if (obj.role === "assistant") {
    const text = extractText(obj);
    const tools = extractToolUses(obj);
    const toolNames = tools.map((t) => resolveToolName(t)).filter(Boolean);
    let msg = toolNames.length
      ? "tools · " + toolNames.slice(0, 4).join(", ")
      : "working · " + snippet(text, 80);
    const readish = toolNames.some((n) =>
      /^(Read|Grep|Glob|WebFetch|WebSearch|GetDynamicTools)$/i.test(n)
    );
    let outChars = String(text || "").length;
    for (const t of tools) outChars += toolEstimateChars(t);
    const takeUsage = onceUsage(estimateUsage(role, obj, { inText: "", outChars }));
    const tokensDelta =
      (role === "explorer" || role === "researcher") && readish
        ? 18000 + Math.min(40000, toolNames.length * 4000)
        : 0;

    const activities = [];
    for (const tool of tools) {
      const activity = toolActivity(tool);
      if (activity) activities.push(activity);
    }

    const terminal = terminalTypeFromTranscript(obj);
    const historyType = terminal === "error" ? "error" : terminal === "done" ? "done" : "turn";

    if (activities.length === 0) {
      const usage = takeUsage();
      pushEvent({
        role,
        kind: "status",
        message: msg,
        active: [roleToCard(role)],
        tokensDelta,
        usage,
        source: src
      });
      recordHistoryFromTranscript({
        ts: transcriptTimestamp(obj),
        sessionId: sessionIdFromFile(filePath),
        agentId: agentIdFromFile(filePath, role),
        parentId: "parent:parent",
        name: roleDisplayName(role),
        model: roleToModel(role),
        type: historyType,
        inputTokens: usage ? usage.in : 0,
        outputTokens: usage ? usage.out : 0,
        files: []
      });
      return;
    }

    const usage = takeUsage();
    pushEvent({
      role,
      kind: "status",
      message: msg,
      active: [roleToCard(role)],
      tokensDelta,
      usage,
      activity: activities[0],
      source: src
    });
    for (let i = 1; i < activities.length; i++) {
      const a = activities[i];
      pushEvent({
        role,
        kind: "status",
        message: a.kind + " · " + snippet(a.path || a.detail || "", 72),
        active: [roleToCard(role)],
        tokensDelta: 0,
        usage: null,
        activity: a,
        source: src
      });
    }
    recordHistoryFromTranscript({
      ts: transcriptTimestamp(obj),
      sessionId: sessionIdFromFile(filePath),
      agentId: agentIdFromFile(filePath, role),
      parentId: "parent:parent",
      name: roleDisplayName(role),
      model: roleToModel(role),
      type: historyType,
      inputTokens: usage ? usage.in : 0,
      outputTokens: usage ? usage.out : 0,
      files: filesFromActivity(activities)
    });
  }
}

function listJsonlFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      lastScanError = String(e.message || e);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
    }
  }
  walk(root);
  return out.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch (_) {
      return 0;
    }
  });
}

function roleForFile(filePath) {
  if (!isSubagentFile(filePath)) return null;
  const uuid = path.basename(filePath, ".jsonl");
  return subagentRoles.get(uuid) || null;
}

function primeSubagentRole(filePath) {
  if (!isSubagentFile(filePath)) return;
  const uuid = path.basename(filePath, ".jsonl");
  if (subagentRoles.has(uuid)) return;
  try {
    const size = fs.statSync(filePath).size;
    const headLen = Math.min(12000, size);
    const buf = readBytesAtSync(filePath, 0, headLen);
    const firstLine = buf
      .toString("utf8")
      .split(/\r?\n/)
      .find((l) => l.trim());
    if (!firstLine) return;
    const obj = JSON.parse(firstLine);
    const text = extractText(obj);
    const role = inferRoleFromSubagentText(text);
    if (role && role !== "parent") subagentRoles.set(uuid, role);
  } catch (_) {
    /* ignore priming failures */
  }
}

/**
 * Skip a line with no newline in the first read window; advance offset without parsing body.
 * Never writes to history or SSE. No placeholder and no substring from the skipped bytes
 * (partial reads could split secrets past redaction).
 */
function skipOversizedLine(filePath, lineStartOffset, fileSize, state) {
  if (lineStartOffset >= fileSize) return false;
  if (fileSize <= lineStartOffset) return false;
  const after = findNextNewlineOffset(filePath, lineStartOffset, fileSize);
  if (after < 0) return false;
  historyIngestRecording = false;
  currentIngestFile = "";
  currentIngestLine = 0;
  state.size = after;
  state.warm = true;
  return true;
}

function snapshotTranscriptInventory() {
  transcriptFilesAtStart.clear();
  transcriptSnapshotSizes.clear();
  transcriptStartupWarmFiles.clear();
  warmScanAfterInventory = true;
  if (!fs.existsSync(TRANSCRIPTS)) return;
  for (const f of listJsonlFiles(TRANSCRIPTS)) {
    transcriptFilesAtStart.add(f);
    try {
      transcriptSnapshotSizes.set(f, fs.statSync(f).size);
    } catch (_e) {
      transcriptSnapshotSizes.set(f, 0);
    }
  }
}

function ingestNewBytes(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_) {
    return;
  }
  let state = fileState.get(filePath);
  if (!state) {
    if (isSubagentFile(filePath)) primeSubagentRole(filePath);
    const existedAtStart = transcriptFilesAtStart.has(filePath);
    let start = 0;
    if (existedAtStart) {
      if (transcriptStartupWarmFiles.has(filePath)) {
        start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
      } else if (transcriptSnapshotSizes.has(filePath)) {
        start = Math.max(0, transcriptSnapshotSizes.get(filePath));
      } else {
        start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
      }
    }
    state = {
      size: start,
      warm: !existedAtStart,
      lineSeq: 0,
      existedAtStart
    };
    fileState.set(filePath, state);
  }
  if (state.existedAtStart == null) {
    state.existedAtStart = transcriptFilesAtStart.has(filePath);
  }
  if (state.lineSeq == null) state.lineSeq = 0;
  if (st.size < state.size) {
    state.size = 0;
  }
  if (st.size === state.size) return;

  const readFrom = state.size;
  const remaining = st.size - readFrom;
  if (remaining <= 0) return;

  const len = Math.min(remaining, TRANSCRIPT_READ_MAX_PER_POLL);
  let buf;
  try {
    buf = readBytesAtSync(filePath, readFrom, len);
  } catch (e) {
    lastScanError = String(e.message || e);
    return;
  }

  const snapshotByteAtRead = transcriptSnapshotSizes.get(filePath);
  const resumeFromSnapshot = snapshotByteAtRead != null && readFrom === snapshotByteAtRead;
  const startedMidFile = !state.warm && readFrom > 0 && !resumeFromSnapshot;
  let work = buf;
  let workBase = readFrom;

  if (startedMidFile) {
    const firstNl = findFirstNewlineByte(buf, 0);
    if (firstNl < 0) {
      if (
        st.size > readFrom + buf.length &&
        skipOversizedLine(filePath, readFrom, st.size, state)
      ) {
        ingestNewBytes(filePath);
      }
      return;
    }
    const skip = firstNl + newlineByteLength(buf, firstNl);
    work = buf.subarray(skip);
    workBase = readFrom + skip;
  }

  const completeEnd = completeLinesEndExclusive(work);
  if (completeEnd < 0) {
    if (st.size > workBase + work.length && skipOversizedLine(filePath, workBase, st.size, state)) {
      ingestNewBytes(filePath);
    }
    return;
  }

  state.size = workBase + completeEnd;

  const snapshotByte = transcriptSnapshotSizes.get(filePath);
  const existedAtStart = state.existedAtStart;
  currentIngestFile = filePath;
  const sub = isSubagentFile(filePath);
  const workComplete = work.subarray(0, completeEnd);

  forEachCompleteLine(workComplete, workBase, (lineStartByte, trimmed) => {
    if (!trimmed) return;
    const recordHistory = !existedAtStart || snapshotByte == null || lineStartByte >= snapshotByte;
    historyIngestRecording = recordHistory;
    state.lineSeq += 1;
    currentIngestLine = state.lineSeq;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      /* A line we cannot parse is drift, not noise. Report it instead of dropping it. */
      noteDrift("unparsed", trimmed);
      return;
    }
    const shape = lineShape(obj);
    if (shape === "terminal") {
      handleTerminalLine(obj, filePath, sub);
      return;
    }
    if (shape !== "conversation") {
      noteDrift("unknown", trimmed);
      return;
    }
    if (sub) handleSubagentLine(obj, filePath, roleForFile(filePath));
    else handleParentLine(obj, filePath);
  });

  historyIngestRecording = false;
  currentIngestFile = "";
  currentIngestLine = 0;
  state.warm = true;
}

function scan() {
  if (source !== "cursor") {
    try {
      scanClaudeCode();
    } catch (_e) {
      /* a failed poll is retried on the next scan; the ingest counts its own drift */
    }
    lastScanAt = nowIso();
    return;
  }
  try {
    const files = listJsonlFiles(TRANSCRIPTS).slice(0, TRANSCRIPT_SCAN_LIMIT);
    if (warmScanAfterInventory) {
      for (const f of files) {
        if (transcriptFilesAtStart.has(f)) {
          transcriptStartupWarmFiles.add(f);
        }
      }
      warmScanAfterInventory = false;
    }
    for (const f of files) ingestNewBytes(f);
    lastScanError = fs.existsSync(TRANSCRIPTS) ? null : "transcripts dir missing";
  } catch (e) {
    lastScanError = String(e.message || e);
  }
  lastScanAt = nowIso();
}

/** Fixed-text 500 for a failed async Claude Code route; never the error message. */
function sendInternalError(res) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    try {
      res.end();
    } catch (_e) {
      /* already gone */
    }
    return;
  }
  sendJson(res, 500, { ok: false, error: "Internal error" });
}

function createServer() {
  return http.createServer((req, res) => {
    if (rejectIfNotLocal(req, res, PORT)) return;
    if (!claudeCode) {
      // stopBridge ran: a request still arriving on a kept-alive socket has nothing to answer with
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Bridge stopped");
      return;
    }

    let url;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    } catch (_e) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad URL");
      return;
    }

    // No CORS: same-origin Live/Electron only. Reject preflight without ACAO *.
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveDashboard(res);
      return;
    }

    if (serveStatic(url.pathname, res)) {
      return;
    }

    if (url.pathname === "/api/status") {
      if (source === "claude-code") {
        const cc = claudeCode;
        claudeStatusPayload(cc)
          .then((body) => sendJson(res, 200, body))
          .catch(() => sendInternalError(res));
        return;
      }
      sendJson(res, 200, statusPayload());
      return;
    }

    if (url.pathname === "/api/projects") {
      if (source === "claude-code") {
        const cc = claudeCode;
        cc.projectsBody()
          .then((body) => {
            const sel = cc.selection();
            sendJson(res, 200, { ok: true, ...body, selectedId: sel.id, selectedLabel: sel.label });
          })
          .catch(() => sendInternalError(res));
        return;
      }
      const projects = discoverProjects();
      sendJson(res, 200, {
        ok: true,
        projects,
        selectedId: currentProjectId,
        selectedLabel: currentProjectLabel,
        transcripts: TRANSCRIPTS
      });
      return;
    }

    /** POST /api/source · switch between "cursor" and "claude-code". Same guards as select. */
    if (url.pathname === "/api/source") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (!allowProjectSelect(req, PORT)) {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · same-origin required for source switch"
        });
        return;
      }
      if (String(req.headers["x-cursor-bridge"] || "") !== "1") {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · missing X-Cursor-Bridge header"
        });
        return;
      }
      readRequestBody(req)
        .then((raw) => {
          let value = url.searchParams.get("source");
          if (raw && String(raw).trim()) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed.source === "string") value = parsed.source;
            } catch (_e) {
              sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
              return;
            }
          }
          if (value !== "cursor" && value !== "claude-code") {
            sendJson(res, 400, { ok: false, error: "Unknown source" });
            return;
          }
          setSource(value);
          sendJson(res, 200, { ok: true, source });
        })
        .catch(() => {
          sendJson(res, 400, { ok: false, error: "Bad request body" });
        });
      return;
    }

    if (url.pathname === "/api/select") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (!allowProjectSelect(req, PORT)) {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · same-origin required for project select"
        });
        return;
      }
      if (String(req.headers["x-cursor-bridge"] || "") !== "1") {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · missing X-Cursor-Bridge header"
        });
        return;
      }
      readRequestBody(req)
        .then((raw) => {
          let id = url.searchParams.get("id");
          if (raw && String(raw).trim()) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && parsed.id != null && parsed.id !== "") {
                id = String(parsed.id);
              }
            } catch (_e) {
              sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
              return;
            }
          }
          if (!id) {
            sendJson(res, 400, { ok: false, error: "Missing id" });
            return;
          }
          if (source === "claude-code") {
            const cc = claudeCode;
            return selectClaudeProject(cc, id)
              .then((r) => sendJson(res, r.status, r.body))
              .catch(() => sendInternalError(res));
          }
          const result = selectProject(id);
          sendJson(res, result.ok ? 200 : 400, result);
        })
        .catch(() => {
          sendJson(res, 400, { ok: false, error: "Bad request body" });
        });
      return;
    }

    if (url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") || 0);
      if (source === "claude-code") {
        const cc = claudeCode;
        cc.eventsBody(events.filter((e) => e.id > after))
          .then((body) => {
            const sel = cc.selection();
            sendJson(res, 200, { ...body, projectId: sel.id, projectLabel: sel.label });
          })
          .catch(() => sendInternalError(res));
        return;
      }
      sendJson(res, 200, {
        events: events.filter((e) => e.id > after),
        transcripts: TRANSCRIPTS,
        projectId: currentProjectId,
        projectLabel: currentProjectLabel
      });
      return;
    }

    /**
     * GET /api/claude/sessions and GET /api/claude/session?id=<opaque> · older Claude Code
     * sessions of the selected project, read-only. Claude Code mode only; every answer is built
     * from numbers, ISO times, opaque ids and fixed strings (lib/claude-code-history.js).
     */
    if (url.pathname === "/api/claude/sessions" || url.pathname === "/api/claude/session") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "GET required" });
        return;
      }
      if (source !== "claude-code") {
        sendJson(res, 409, { ok: false, error: "Claude Code mode only" });
        return;
      }
      let r;
      try {
        if (url.pathname === "/api/claude/sessions") {
          r = claudeCode.sessionsBody();
        } else {
          // only an opaque id is accepted: any other key (a path, a file name) is refused
          const keys = [...url.searchParams.keys()];
          if (keys.length !== 1 || keys[0] !== "id") {
            sendJson(res, 400, { ok: false, error: "Unknown session" });
            return;
          }
          r = claudeCode.sessionBody(url.searchParams.get("id"));
        }
      } catch (_e) {
        sendInternalError(res);
        return;
      }
      sendJson(res, r.status, r.body);
      return;
    }

    if (url.pathname === "/api/alerts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "GET required" });
        return;
      }
      sendJson(res, 200, { alerts: alerts.filter((a) => a.source === source).map((a) => a.alert) });
      return;
    }

    /**
     * POST /api/snooze · set indefinite alert snooze so the bridge can gate Electron
     * desktop toasts. Same-origin + X-Cursor-Bridge guard, mirroring /api/select.
     * The SSE `alert` event and the in-memory ring keep flowing while snoozed.
     */
    if (url.pathname === "/api/snooze") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (!allowProjectSelect(req, PORT)) {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · same-origin required for snooze"
        });
        return;
      }
      if (String(req.headers["x-cursor-bridge"] || "") !== "1") {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · missing X-Cursor-Bridge header"
        });
        return;
      }
      readRequestBody(req)
        .then((raw) => {
          let parsed = null;
          try {
            parsed = raw && String(raw).trim() ? JSON.parse(raw) : null;
          } catch (_e) {
            sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
            return;
          }
          /* Explicit intent only: an absent body must not mean "snooze on". */
          if (!parsed || typeof parsed.snoozed !== "boolean") {
            sendJson(res, 400, {
              ok: false,
              error: "Body must be JSON { snoozed: boolean }"
            });
            return;
          }
          snoozeIndefinite = parsed.snoozed;
          sendJson(res, 200, { ok: true, snoozed: snoozeIndefinite });
        })
        .catch(() => {
          sendJson(res, 400, { ok: false, error: "Bad request body" });
        });
      return;
    }

    if (url.pathname === "/api/history") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "GET required" });
        return;
      }
      if (source === "claude-code") {
        sendJson(res, 200, {
          events: [],
          latestSessionId: null,
          notes: [{ code: "history-off", text: "History is not available for Claude Code yet" }]
        });
        return;
      }
      const since = url.searchParams.get("since") || undefined;
      const session = url.searchParams.get("session") || undefined;
      const list = filterHistoryToCurrentProject(
        eventLog ? eventLog.query({ since, session, limit: MAX_HISTORY_EVENTS }) : []
      );
      sendJson(res, 200, {
        events: list,
        latestSessionId: latestSessionIdForTranscripts(TRANSCRIPTS)
      });
      return;
    }

    if (url.pathname === "/api/history/clear") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (!allowProjectSelect(req, PORT)) {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · same-origin required for history clear"
        });
        return;
      }
      if (String(req.headers["x-cursor-bridge"] || "") !== "1") {
        sendJson(res, 403, {
          ok: false,
          error: "Forbidden · missing X-Cursor-Bridge header"
        });
        return;
      }
      if (source !== "cursor") {
        // History is off in Claude Code mode, and the log on disk is the Cursor one
        sendJson(res, 409, { ok: false, error: "History is off in this mode" });
        return;
      }
      if (eventLog) eventLog.clear();
      agentWatch.clear();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      const hello = {
        ok: true,
        source,
        explicitDir: explicitCursorDir,
        transcripts: TRANSCRIPTS,
        projectId: currentProjectId,
        projectLabel: currentProjectLabel,
        lastScanAt,
        pollMs: POLL_MS
      };
      if (source === "claude-code") {
        const sel = claudeCode.selection();
        delete hello.transcripts;
        hello.projectId = sel.id;
        hello.projectLabel = sel.label;
        hello.models = claudeModels;
      }
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      const backlog = events.slice(-40);
      for (const ev of backlog) {
        /* Mark connect-time replay so the dashboard skips card timing even if JS
         * processes messages slower than LIVE_SSE_BACKLOG_QUIET_MS (Windows CI). */
        res.write(`data: ${JSON.stringify({ ...ev, sseBacklog: true })}\n\n`);
      }
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
}

function probeExistingBridge(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/status",
        timeout: 800
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.ok === true && j.bridgeId === BRIDGE_ID ? j : null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Where the label salt is read and written for this run: null under BRIDGE_TEST=1 with no
 * opts.saltDir (no fs call at all, so a test never reaches the real config folder), else
 * { dir, oldDir }: the config folder (opts.saltDir, else resolveSaltDir) and the event-log folder
 * an earlier version kept the salt in (the one to migrate from; "" under BRIDGE_TEST=1 when no
 * opts.eventLogDir is given, which means no migration and no delete).
 * A test process (NODE_TEST_CONTEXT or AW_TEST=1) outside BRIDGE_TEST must name a folder, in
 * opts.saltDir or, with AW_TEST=1, in AW_SALT_DIR; otherwise this throws.
 * @param {{saltDir?: string, eventLogDir?: string}} opts
 * @param {Record<string, string|undefined>} [env]
 * @returns {{dir: string, oldDir: string} | null}
 */
function saltLoadOptions(opts, env = process.env) {
  const test = env.BRIDGE_TEST === "1";
  // AW_TEST=1 lets a test process (the Electron smoke) name its salt folder in AW_SALT_DIR
  const awTest = env.AW_TEST === "1";
  const named = opts.saltDir || (awTest && env.AW_SALT_DIR) || "";
  if (test && !named) return null;
  if ((env.NODE_TEST_CONTEXT || awTest) && !named) {
    throw new Error("tests must pass an explicit saltDir");
  }
  return {
    dir: named ? path.resolve(named) : resolveSaltDir({ env }),
    // under BRIDGE_TEST=1 only a log folder the test names is migrated from, never the real one
    oldDir: test && !opts.eventLogDir ? "" : resolveLogDir({ logDir: opts.eventLogDir })
  };
}

/**
 * Claude Code mode for this run. The salt lives in its own config folder (opts.saltDir, else
 * resolveSaltDir), never in the event-log folder; a salt an earlier version left in the event-log
 * folder is moved over. Under BRIDGE_TEST=1 with no opts.saltDir nothing is read or written for
 * the salt (a random in-memory one), so a test never touches the real config folder.
 * Under BRIDGE_TEST=1 an omitted opts.claudeCode becomes an inert bag (no real home, no wsl.exe).
 */
function makeClaudeCodeMode(opts) {
  let salt;
  let note;
  const where = saltLoadOptions(opts);
  if (!where) {
    salt = crypto.randomBytes(16);
  } else {
    ({ salt, note } = loadOrCreateSalt(where));
  }
  let bag = opts.claudeCode || {};
  if (process.env.BRIDGE_TEST === "1") {
    /* Each missing key gets an inert default, so a partial bag never reaches the real home
       or wsl.exe. A bag that names a homedir keeps the real fs unless it passes its own. */
    const blocked = () => Promise.reject(new Error("blocked"));
    const inertFs = new Proxy({}, { get: () => blocked });
    bag = {
      ...bag,
      platform: bag.platform || "linux",
      homedir: bag.homedir === undefined ? "" : bag.homedir,
      runWsl: bag.runWsl || blocked
    };
    if (!bag.fs && !opts.claudeCode?.homedir) bag.fs = inertFs;
  }
  const { ttlMs, ...discover } = bag;
  return createClaudeCodeMode({ salt, saltNote: note || null, discover, ttlMs });
}

/**
 * Start the bridge HTTP server + transcript poller.
 * @param {{port?:number, dir?:string, quiet?:boolean, reuseExisting?:boolean, onAgentAlert?:Function, eventLogDir?:string, saltDir?:string, eventLogPath?:string, projectsRoot?:string, claudeCode?:{platform?:string, homedir?:string, fs?:any, runWsl?:Function, now?:()=>number, timeoutMs?:number, ttlMs?:number}}} [opts]
 * @returns {Promise<{port:number, reused:boolean, transcripts:string}>}
 */
function startBridge(opts) {
  opts = opts || {};
  assertBridgeTestOpts(opts);
  if (started && server) {
    return Promise.resolve({
      port: PORT,
      reused: false,
      transcripts: TRANSCRIPTS,
      alreadyStarted: true
    });
  }

  quiet = !!opts.quiet;
  onAgentAlert = typeof opts.onAgentAlert === "function" ? opts.onAgentAlert : null;
  stallMs = Number(opts.stallMs || process.env.CURSOR_BRIDGE_STALL_MS || DEFAULT_STALL_MS);
  if (opts.projectsRoot) {
    projectsRootOpt = path.resolve(opts.projectsRoot);
  }
  PORT = Number(opts.port || flag("--port") || 3847);
  resolveDefaultTranscripts(opts);
  // Claude Code is the default; an explicit Cursor folder (--dir / CURSOR_TRANSCRIPTS) starts Cursor.
  explicitCursorDir = hasExplicitCursorDir(opts);
  source = explicitCursorDir ? "cursor" : DEFAULT_SOURCE;
  claudeCode = makeClaudeCodeMode(opts);

  const eventLogCreateOpts = {
    logDir: opts.eventLogDir,
    logPath: opts.eventLogPath
  };
  if (process.env.BRIDGE_TEST === "1" && opts.eventLogDir) {
    const resolvedLogDir = path.resolve(opts.eventLogDir);
    eventLogCreateOpts.logDir = resolvedLogDir;
    if (!eventLogCreateOpts.logPath) {
      eventLogCreateOpts.logPath = path.join(resolvedLogDir, "event-log.jsonl");
    }
  }
  eventLog = createEventLog(eventLogCreateOpts);
  try {
    eventLog.ensureStarted();
    log(`[live-bridge] event log: ${eventLog.getLogPath()}`);
  } catch (e) {
    logErr("[live-bridge] event log init:", e && e.message ? e.message : e);
  }

  return new Promise((resolve, reject) => {
    server = createServer();

    const onListening = () => {
      started = true;
      try {
        const addr = server && server.address();
        if (addr && typeof addr === "object" && addr.port) PORT = addr.port;
      } catch (_e) {
        /* keep PORT */
      }
      // Claude Code mode watches no Cursor tree; switching to Cursor re-snapshots (resetWatchState)
      if (source === "cursor") snapshotTranscriptInventory();
      else void autoSelectNewestClaude();
      scan();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        try {
          scan();
        } catch (e) {
          lastScanError = String(e && e.message ? e.message : e);
          logErr("[live-bridge] scan error:", lastScanError);
        }
      }, POLL_MS);
      if (stallTimer) clearInterval(stallTimer);
      stallTimer = setInterval(() => {
        try {
          checkStalledAgents();
        } catch (_e) {
          /* ignore */
        }
      }, STALL_CHECK_MS);
      if (typeof stallTimer.unref === "function") stallTimer.unref();

      log(`[live-bridge] http://127.0.0.1:${PORT}/`);
      log(`[live-bridge] transcripts: ${TRANSCRIPTS}`);
      log(
        `[live-bridge] project: ${currentProjectLabel || "(custom)"} (${currentProjectId || "n/a"})`
      );
      log(`[live-bridge] exists: ${fs.existsSync(TRANSCRIPTS)}`);
      if (!quiet) log("[live-bridge] Leave this window open. Ctrl+C to stop.");
      if (!events.length) {
        pushEvent({
          role: "parent",
          kind: "status",
          message: "bridge online · waiting for transcript activity",
          active: [],
          source: "bridge"
        });
      }
      resolve({
        port: PORT,
        reused: false,
        transcripts: TRANSCRIPTS,
        projectId: currentProjectId,
        projectLabel: currentProjectLabel,
        eventLogPath: eventLog ? eventLog.getLogPath() : null
      });
    };

    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        const reuse = opts.reuseExisting !== false;
        probeExistingBridge(PORT).then((status) => {
          if (status && reuse) {
            log(`[live-bridge] already running at http://127.0.0.1:${PORT}/`);
            log(`[live-bridge] transcripts: ${status.transcripts || "(unknown)"}`);
            if (require.main === module) {
              log("[live-bridge] Open that URL and click Live. (No second copy needed.)");
              process.exit(0);
              return;
            }
            // Electron path: reuse existing server; we did not bind
            server = null;
            started = false;
            resolve({
              port: PORT,
              reused: true,
              transcripts: status.transcripts || TRANSCRIPTS,
              projectId: status.projectId || currentProjectId,
              projectLabel: status.projectLabel || currentProjectLabel
            });
            return;
          }
          if (require.main === module) {
            logErr(`[live-bridge] port ${PORT} is in use (not this bridge).`);
            logErr(`[live-bridge] Fix: close the other process, or run:`);
            logErr(`  node live-bridge.js --port ${PORT + 1}`);
            logErr(`Then open http://127.0.0.1:${PORT + 1}/`);
            process.exit(1);
            return;
          }
          reject(new Error(`Port ${PORT} in use`));
        });
        return;
      }
      logErr("[live-bridge] server error:", err && err.message ? err.message : err);
      if (require.main === module) process.exit(1);
      else reject(err);
    });

    server.listen(PORT, "127.0.0.1", onListening);
  });
}

/**
 * Stop poller + HTTP server (for Electron quit).
 * @returns {Promise<void>}
 */
function stopBridge() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      projectsRootOpt = null;
      resolve();
    };

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    fileState.clear();
    seenHistoryKeys.clear();
    transcriptFilesAtStart.clear();
    transcriptSnapshotSizes.clear();
    transcriptStartupWarmFiles.clear();
    warmScanAfterInventory = false;
    agentWatch.clear();
    onAgentAlert = null;
    snoozeIndefinite = false;
    // back to the default, like every other piece of state here; startBridge sets it again anyway
    source = DEFAULT_SOURCE;
    explicitCursorDir = false;
    claudeCode = null;
    claudeTail = null;
    claudeModels = {};
    claudeDriftAt = null;
    for (const res of sseClients) {
      try {
        res.end();
      } catch (_) {
        /* ignore */
      }
    }
    sseClients.clear();
    if (!server) {
      started = false;
      finish();
      return;
    }
    const s = server;
    server = null;
    started = false;
    s.close(() => finish());
    const t = setTimeout(finish, 500);
    if (typeof t.unref === "function") t.unref();
  });
}

/** Clear persisted history (also used by POST /api/history/clear). */
function clearHistory() {
  if (!eventLog) {
    return { ok: true, cleared: false };
  }
  if (source !== "cursor") {
    // the log on disk is the Cursor one; History is off in Claude Code mode
    return { ok: false, cleared: false };
  }
  agentWatch.clear();
  const result = eventLog.clear();
  return Object.assign({}, result, { cleared: true });
}

module.exports = {
  BRIDGE_ID,
  startBridge,
  stopBridge,
  discoverProjects,
  resetWatchState,
  selectProject,
  latestSessionIdForTranscripts,
  filterHistoryToCurrentProject,
  sessionIdsInTranscripts,
  clearHistory,
  recordHistoryEvent,
  claudeStatusPayload, // exported for tests only
  saltLoadOptions, // exported for tests only
  scanTranscripts: scan,
  checkStalledAgents,
  terminalTypeFromTranscript,
  TRANSCRIPT_SCAN_LIMIT,
  TRANSCRIPT_READ_MAX_PER_POLL,
  STALL_MS: DEFAULT_STALL_MS,
  pushEvent
};

if (require.main === module) {
  process.on("uncaughtException", (err) => {
    console.error("[live-bridge] uncaughtException:", err && err.stack ? err.stack : err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[live-bridge] unhandledRejection:", err);
  });

  startBridge({ quiet: false }).catch((err) => {
    console.error("[live-bridge] failed to start:", err && err.message ? err.message : err);
    process.exit(1);
  });
}
