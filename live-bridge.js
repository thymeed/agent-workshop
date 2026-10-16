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
const { createEventLog } = require("./lib/event-log");
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
/** @type {string} */
let TRANSCRIPTS = emptyTranscripts();
/** @type {string|null} */
let currentProjectId = null;
/** @type {string|null} */
let currentProjectLabel = null;

/** @type {Array<object>} */
const events = [];
/** @type {Array<{id:number,ts:string,name:string,status:string,agentId?:string}>} */
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
const drift = { unparsed: 0, unknownShape: 0, lastAt: null, lastSample: "" };
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

  alerts.push(alert);
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

function resetWatchState() {
  events.length = 0;
  fileState.clear();
  subagentRoles.clear();
  seenHistoryKeys.clear();
  drift.unparsed = 0;
  drift.unknownShape = 0;
  drift.lastAt = null;
  drift.lastSample = "";
  driftReported = false;
  // Keep eventSeq monotonic so client after= / seenLiveIds stay valid across project switches
  lastScanError = null;
  snapshotTranscriptInventory();
  broadcastSse("reset", {
    ok: true,
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

/**
 * Record one unreadable or unrecognized transcript line and report the first one.
 * A silent drop is the failure mode that hid a real format drift: the dashboard looks
 * quiet rather than wrong, so the user has to notice an absence. This makes it loud.
 * @param {"unparsed"|"unknown"} kind
 * @param {string} sample
 */
function noteDrift(kind, sample) {
  if (kind === "unparsed") drift.unparsed += 1;
  else drift.unknownShape += 1;
  drift.lastAt = nowIso();
  drift.lastSample = snippet(sample, 120);
  if (driftReported) return;
  driftReported = true;
  pushEvent({
    role: "parent",
    kind: "status",
    message:
      "transcript drift · " +
      (kind === "unparsed" ? "unparsed line" : "unrecognized line shape") +
      " · this build may be behind Cursor's format",
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

function createServer() {
  return http.createServer((req, res) => {
    if (rejectIfNotLocal(req, res, PORT)) return;

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
      sendJson(res, 200, statusPayload());
      return;
    }

    if (url.pathname === "/api/projects") {
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
      sendJson(res, 200, {
        events: events.filter((e) => e.id > after),
        transcripts: TRANSCRIPTS,
        projectId: currentProjectId,
        projectLabel: currentProjectLabel
      });
      return;
    }

    if (url.pathname === "/api/alerts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "GET required" });
        return;
      }
      sendJson(res, 200, { alerts: alerts.slice() });
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
      res.write(
        `event: hello\ndata: ${JSON.stringify({
          ok: true,
          transcripts: TRANSCRIPTS,
          projectId: currentProjectId,
          projectLabel: currentProjectLabel,
          lastScanAt,
          pollMs: POLL_MS
        })}\n\n`
      );
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
            resolve(j && j.ok === true ? j : null);
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
 * Start the bridge HTTP server + transcript poller.
 * @param {{port?:number, dir?:string, quiet?:boolean, reuseExisting?:boolean, onAgentAlert?:Function, eventLogDir?:string, eventLogPath?:string, projectsRoot?:string}} [opts]
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
      snapshotTranscriptInventory();
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
  agentWatch.clear();
  const result = eventLog.clear();
  return Object.assign({}, result, { cleared: true });
}

module.exports = {
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
