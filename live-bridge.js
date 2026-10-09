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

const PROJECTS_ROOT = path.join(os.homedir(), ".cursor", "projects");
/** Placeholder watch path when no --dir / env / discovered project exists yet. */
const EMPTY_TRANSCRIPTS = path.join(PROJECTS_ROOT, "_none", "agent-transcripts");
const DASHBOARD = path.join(__dirname, "model-routing-dashboard.html");
const STATIC_ROOT = path.join(__dirname, "dashboard");
const MAX_EVENTS = 400;
const POLL_MS = 900;
/** Max transcript JSONL files polled per scan (newest by mtime). */
const TRANSCRIPT_SCAN_LIMIT = 40;
const TRANSCRIPT_TAIL_BYTES = 8192;
/** Max bytes read from a transcript file per scan poll (resume at last newline). */
const TRANSCRIPT_READ_MAX_PER_POLL = 256 * 1024;
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".map": "application/json; charset=utf-8"
};

let PORT = 3847;
/** @type {string} */
let TRANSCRIPTS = EMPTY_TRANSCRIPTS;
/** @type {string|null} */
let currentProjectId = null;
/** @type {string|null} */
let currentProjectLabel = null;

/** @type {Array<object>} */
const events = [];
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
/** filePath -> { size, warm, lineSeq } */
const fileState = new Map();
/** Transcript JSONL paths present at last inventory snapshot (startup / project reset). */
const transcriptFilesAtStart = new Set();
/** filePath -> byte length at last inventory snapshot */
const transcriptSnapshotSizes = new Map();
/** Files in the first scan slice after inventory — use 8 KB tail warm-up, not snapshot offset. */
const transcriptStartupWarmFiles = new Set();
/** True until the first scan() pass marks warm-up files after snapshotTranscriptInventory(). */
let warmScanAfterInventory = false;
/** subagent uuid -> role */
const subagentRoles = new Map();
let eventSeq = 0;
let lastScanError = null;

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

function nowIso() {
  return new Date().toISOString();
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
  if (!fs.existsSync(PROJECTS_ROOT)) return out;
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const transcriptsPath = path.join(PROJECTS_ROOT, id, "agent-transcripts");
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
  const root = path.resolve(PROJECTS_ROOT);
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
      const parts = path.relative(path.resolve(PROJECTS_ROOT), abs).split(path.sep);
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

  // Runtime placeholder under ~/.cursor/projects — no hardcoded machine/user path
  TRANSCRIPTS = EMPTY_TRANSCRIPTS;
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
    activity: partial.activity != null ? partial.activity : null,
    source: partial.source || "transcript"
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcastSse(null, ev);
  return ev;
}

function emitAgentAlert(name, status) {
  if (typeof onAgentAlert !== "function") return;
  try {
    // Alerts carry only agent name + status — never prompts or file paths.
    onAgentAlert({ name: String(name || "agent"), status: String(status || "") });
  } catch (_e) {
    /* ignore alert handler failures */
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
    if (prev.terminal) {
      agentWatch.set(id, prev);
      return;
    }
    prev.terminal = terminalStatus;
    prev.stallAlerted = true;
    agentWatch.set(id, prev);
    emitAgentAlert(prev.name, terminalStatus);
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
      emitAgentAlert(state.name, "stalled");
    }
  }
}

function transcriptTimestamp(obj) {
  if (!obj || typeof obj !== "object") return nowIso();
  const candidates = [
    obj.timestamp,
    obj.ts,
    obj.createdAt,
    obj.created_at,
    obj.message && obj.message.timestamp
  ];
  for (const c of candidates) {
    if (c != null && !Number.isNaN(Date.parse(String(c)))) {
      return new Date(c).toISOString();
    }
  }
  return nowIso();
}

function extractToolResults(obj) {
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === "tool_result");
}

/**
 * Structured terminal signals only — never prose keywords like "error" or "done".
 * @returns {"error"|"done"|null}
 */
function terminalTypeFromTranscript(obj) {
  if (!obj || !obj.role) return null;
  if (obj.role === "assistant") {
    const text = extractText(obj);
    if (/<\/?error\b/i.test(text)) return "error";
    if (/<\/?final\b/i.test(text)) return "done";
  }
  return null;
}

function resolveTaskChildAgentId(args, input) {
  const raw = String(
    (args && (args.subagent_id || args.subagentId || args.agent_id || args.agentId || args.id)) ||
      (input && (input.subagent_id || input.subagentId || input.id)) ||
      ""
  ).trim();
  if (!raw) return null;
  if (/^[0-9a-f-]{36}$/i.test(raw)) return raw;
  return null;
}

function sessionIdFromFile(filePath) {
  try {
    const rel = path.relative(TRANSCRIPTS, filePath);
    if (!rel || rel.startsWith("..")) return currentProjectId || "session";
    const parts = rel.split(path.sep).filter(Boolean);
    return parts[0] || currentProjectId || "session";
  } catch (_e) {
    return currentProjectId || "session";
  }
}

function agentIdFromFile(filePath, role) {
  if (isSubagentFile(filePath)) {
    return path.basename(filePath, ".jsonl");
  }
  return "parent:" + (role || "parent");
}

function roleDisplayName(role) {
  if (role === "advisor") return "Advisor";
  if (role === "worker") return "Worker";
  if (role === "explorer") return "Explorer";
  if (role === "researcher") return "Researcher";
  return "Parent";
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
  if (ev.type === "done") touchAgentWatch(ev.agentId, ev.name, "finished", { stallTrack });
  else if (ev.type === "error") touchAgentWatch(ev.agentId, ev.name, "error", { stallTrack });
  else touchAgentWatch(ev.agentId, ev.name, null, { stallTrack });
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

function filesFromActivity(activity) {
  if (!activity) return [];
  if (Array.isArray(activity)) {
    return activity.map((a) => (a && a.path ? String(a.path) : "")).filter(Boolean);
  }
  if (activity.path) return [String(activity.path)];
  return [];
}

function resetWatchState() {
  events.length = 0;
  fileState.clear();
  subagentRoles.clear();
  seenHistoryKeys.clear();
  // Keep eventSeq monotonic so client after= / seenLiveIds stay valid across project switches
  lastScanError = null;
  snapshotTranscriptInventory();
  broadcastSse("reset", {
    ok: true,
    transcripts: TRANSCRIPTS,
    projectId: currentProjectId,
    projectLabel: currentProjectLabel
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
  return {
    ok: true,
    projectId: currentProjectId,
    projectLabel: currentProjectLabel,
    transcripts: TRANSCRIPTS
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
    time: nowIso()
  };
}

function snippet(text, max) {
  if (!text) return "";
  const one = String(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function mapSubagentType(type) {
  const t = String(type || "")
    .toLowerCase()
    .trim();
  if (!t) return "parent";
  if (t === "advisor") return "advisor";
  if (t === "explore" || t === "explorer") return "explorer";
  if (t === "researcher") return "researcher";
  if (
    t === "worker" ||
    t === "shell" ||
    t === "bugbot" ||
    t === "security-review" ||
    t === "ci-investigator" ||
    t === "generalpurpose" ||
    t === "general-purpose" ||
    t === "agents" ||
    t === "best-of-n-runner"
  ) {
    return "worker";
  }
  // Unknown non-empty Task types share the worker card, never the parent.
  return "worker";
}

function roleToCard(role) {
  if (role === "advisor") return "advisor";
  if (role === "worker") return "worker";
  if (role === "explorer") return "explorer";
  if (role === "researcher") return "researcher";
  return "opus";
}

/** Dashboard bill model keys: opus | fable | sonnet | haiku */
function roleToModel(role) {
  if (role === "advisor") return "fable";
  if (role === "worker") return "sonnet";
  if (role === "explorer" || role === "researcher") return "haiku";
  return "opus";
}

function clampTokens(n) {
  const x = Math.round(Number(n) || 0);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.min(120000, x);
}

function charsToTokens(text) {
  return clampTokens(String(text || "").length / 4);
}

/**
 * Prefer transcript message.usage; else chars/4 clamped.
 * @returns {{model:string,role:string,in:number,out:number}}
 */
function estimateUsage(role, obj, opts) {
  opts = opts || {};
  const r = role || "parent";
  const model = roleToModel(r);
  const msg = obj && obj.message;
  const raw = (msg && msg.usage) || (obj && obj.usage) || null;
  if (raw && typeof raw === "object") {
    const inn = clampTokens(
      raw.input_tokens != null
        ? raw.input_tokens
        : raw.inputTokens != null
          ? raw.inputTokens
          : raw.in != null
            ? raw.in
            : raw.prompt_tokens
    );
    const out = clampTokens(
      raw.output_tokens != null
        ? raw.output_tokens
        : raw.outputTokens != null
          ? raw.outputTokens
          : raw.out != null
            ? raw.out
            : raw.completion_tokens
    );
    if (inn > 0 || out > 0) {
      return { model, role: r, in: inn, out };
    }
  }
  const inn = opts.inChars != null ? clampTokens(opts.inChars / 4) : charsToTokens(opts.inText);
  const out = opts.outChars != null ? clampTokens(opts.outChars / 4) : charsToTokens(opts.outText);
  return { model, role: r, in: inn, out };
}

function toolArgs(tool) {
  const input = (tool && tool.input) || {};
  if (input.arguments && typeof input.arguments === "object") return input.arguments;
  return input;
}

function resolveToolName(tool) {
  const name = (tool && tool.name) || "";
  const input = (tool && tool.input) || {};
  const args = toolArgs(tool);
  if (name === "CallDynamicTool") {
    return String(input.toolName || args.toolName || name);
  }
  return String(name);
}

/** Short path/url for activity; never file body. */
function activityPath(args) {
  if (!args || typeof args !== "object") return "";
  const p =
    args.path ||
    args.file_path ||
    args.filePath ||
    args.target_file ||
    args.target_directory ||
    args.working_directory ||
    args.url ||
    "";
  return snippet(String(p), 120);
}

/**
 * Map a tool_use to activity preview payload.
 * @returns {{kind:string,path:string,detail:string}|null}
 */
function toolActivity(tool) {
  if (!tool) return null;
  const name = resolveToolName(tool);
  const args = toolArgs(tool);
  const p = activityPath(args);

  if (/^(Read|WebFetch)$/i.test(name)) {
    let detail = "read";
    if (name === "Read") {
      const parts = [];
      if (args.offset != null) parts.push("@" + args.offset);
      if (args.limit != null) parts.push("+" + args.limit);
      detail = parts.length ? parts.join(" ") : "read";
    } else {
      detail = "fetch";
    }
    return { kind: "read", path: p, detail: snippet(detail, 80) };
  }

  if (/^(Grep|Glob|WebSearch|GetDynamicTools)$/i.test(name)) {
    let detail = "";
    if (/^Grep$/i.test(name)) detail = args.pattern || "";
    else if (/^Glob$/i.test(name)) detail = args.glob_pattern || args.glob || "";
    else if (/^WebSearch$/i.test(name)) detail = args.search_term || args.query || "";
    else detail = args.namespace || args.pattern || "tools";
    return { kind: "search", path: p, detail: snippet(detail, 80) };
  }

  if (/^(Write|StrReplace|Edit|EditNotebook)$/i.test(name)) {
    return { kind: "edit", path: p, detail: "edited" };
  }

  if (/^(Shell|AwaitShell)$/i.test(name)) {
    const cmd = args.command || args.cmd || "";
    return {
      kind: "run",
      path: p || snippet(args.working_directory || "", 120),
      detail: snippet(cmd, 80)
    };
  }

  return null;
}

/** Char count for out-estimate from tools — uses write body length, not contents string. */
function toolEstimateChars(tool) {
  if (!tool) return 0;
  const name = resolveToolName(tool);
  const args = toolArgs(tool);
  if (/^(Write|StrReplace|Edit|EditNotebook)$/i.test(name)) {
    const body =
      args.contents || args.new_string || args.newString || args.old_string || args.oldString || "";
    return Math.min(480000, String(body).length);
  }
  try {
    return JSON.stringify({
      name,
      path: activityPath(args),
      keys: Object.keys(args || {})
    }).length;
  } catch (_) {
    return String(name).length;
  }
}

function onceUsage(usage) {
  let used = false;
  return function take() {
    if (used) return null;
    used = true;
    return usage;
  };
}

function inferRoleFromSubagentText(text) {
  const raw = String(text || "");
  const m =
    raw.match(/operating as the ["']([^"']+)["'] custom subagent/i) ||
    raw.match(/subagent_type["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    raw.match(/Task description to exactly ["']([^"']+)["']/i);
  if (m) {
    const mapped = mapSubagentType(m[1]);
    if (mapped !== "parent") return mapped;
  }

  const queryMatch = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
  const query = queryMatch ? queryMatch[1] : raw;

  if (/You are the Advisor/i.test(raw) || /^\s*Advisor\b/i.test(query)) return "advisor";
  if (/Implementation worker/i.test(raw)) return "worker";
  if (/file search specialist/i.test(raw)) return "explorer";
  if (/Thoroughness\s*:/i.test(raw)) return "explorer";
  if (
    /docs and external/i.test(raw) ||
    /^\s*Research\b/i.test(query) ||
    /(?:^|[^/])\bresearcher\b(?:[^/]|$)/i.test(query)
  ) {
    return "researcher";
  }
  if (/\bexplor(?:e|ing)\b/i.test(raw)) return "explorer";
  if (/(?:^|[^/])\badvisor\b(?:[^/]|$)/i.test(query.slice(0, 180))) return "advisor";
  // Subagent files never fall through to the parent card.
  return "worker";
}

function extractToolUses(obj) {
  const out = [];
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (part && part.type === "tool_use") out.push(part);
  }
  return out;
}

function extractText(obj) {
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
}

function estimateReadTokens(text) {
  const n = Math.round(String(text || "").length / 4);
  return Math.min(120000, Math.max(800, n));
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
      const desc = snippet(args.description || args.prompt || subType || "subagent", 72);
      const card = roleToCard(role);
      const delegate = card !== "opus";
      const usage = takeUsage();
      pushEvent({
        role: delegate ? role : "parent",
        kind: "delegates",
        message: "delegates · " + (subType || role) + " · " + desc,
        active: delegate ? [card] : ["opus"],
        route: "delegates",
        routeTo: card,
        tokensDelta: role === "explorer" || role === "researcher" ? 24000 : 0,
        usage,
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
          type: "spawn",
          inputTokens: usage ? usage.in : 0,
          outputTokens: usage ? usage.out : 0,
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
    // Tools emitted nothing (or only non-activity tools) — still bill the turn once.
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
    const uuid =
      path.basename(path.dirname(filePath)) === "subagents"
        ? path.basename(filePath, ".jsonl")
        : null;
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

function isSubagentFile(filePath) {
  return filePath.split(path.sep).includes("subagents");
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
    const fd = fs.openSync(filePath, "r");
    const headLen = Math.min(12000, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(headLen);
    fs.readSync(fd, buf, 0, headLen, 0);
    fs.closeSync(fd);
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

function newlineByteLength(buf, nlIndex) {
  if (buf[nlIndex] === 0x0a) return 1;
  if (buf[nlIndex] === 0x0d && nlIndex + 1 < buf.length && buf[nlIndex + 1] === 0x0a) {
    return 2;
  }
  return 1;
}

function findFirstNewlineByte(buf, fromIndex) {
  const from = fromIndex || 0;
  for (let i = from; i < buf.length; i++) {
    if (buf[i] === 0x0a) return i;
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

/** Exclusive end offset within buf after the last complete line (includes trailing newline). */
function completeLinesEndExclusive(buf) {
  let end = -1;
  let i = 0;
  while (i < buf.length) {
    const nl = findFirstNewlineByte(buf, i);
    if (nl < 0) break;
    end = nl + newlineByteLength(buf, nl);
    i = end;
  }
  return end;
}

function forEachCompleteLine(buf, baseFileOffset, fn) {
  let i = 0;
  while (i < buf.length) {
    const lineStart = i;
    const nl = findFirstNewlineByte(buf, i);
    if (nl < 0) break;
    const lineEnd = nl;
    const adv = newlineByteLength(buf, nl);
    const lineStartByte = baseFileOffset + lineStart;
    const trimmed = buf.subarray(lineStart, lineEnd).toString("utf8").trim();
    fn(lineStartByte, trimmed);
    i = nl + adv;
  }
}

/**
 * Scan forward from startOffset in capped chunks until a newline is found.
 * Does not load a full line into memory. Returns exclusive offset after newline, or -1 at EOF.
 */
function findNextNewlineOffset(filePath, startOffset, fileSize) {
  let pos = startOffset;
  if (pos >= fileSize) return -1;
  let fd;
  const scratch = Buffer.alloc(TRANSCRIPT_READ_MAX_PER_POLL);
  try {
    fd = fs.openSync(filePath, "r");
    while (pos < fileSize) {
      const len = Math.min(fileSize - pos, TRANSCRIPT_READ_MAX_PER_POLL);
      const nread = fs.readSync(fd, scratch, 0, len, pos);
      if (nread <= 0) break;
      const slice = scratch.subarray(0, nread);
      const nl = findFirstNewlineByte(slice, 0);
      if (nl >= 0) {
        return pos + nl + newlineByteLength(slice, nl);
      }
      pos += nread;
    }
    return -1;
  } catch (_) {
    return -1;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

/**
 * Skip a line with no newline in the first read window; advance offset without parsing body.
 * Never writes to history or SSE — no placeholder and no substring from the skipped bytes
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
    const fd = fs.openSync(filePath, "r");
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, readFrom);
    fs.closeSync(fd);
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
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/** Read request body (capped) for POST JSON handlers. */
function readRequestBody(req, limitBytes) {
  const limit = limitBytes || 65536;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        try {
          req.destroy();
        } catch (_e) {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** True for IPv4/IPv6 loopback (incl. IPv4-mapped). */
function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") return true;
  if (addr.startsWith("::ffff:")) {
    return isLoopbackAddress(addr.slice("::ffff:".length));
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** Host header must name localhost / loopback (optional port). */
function isLocalhostHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    const name = host.slice(1, end);
    return name === "::1" || name === "127.0.0.1";
  }
  const name = host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1";
}

/**
 * Origin header: absent is OK (navigations, curl, same-origin without CORS).
 * If present, must be http(s) to localhost / 127.0.0.1 / ::1 on this bridge's port.
 */
function isAllowedOrigin(origin) {
  if (origin == null || origin === "") return true;
  if (origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    if (!(h === "localhost" || h === "127.0.0.1" || h === "::1")) return false;
    const originPort = u.port || (u.protocol === "https:" ? "443" : "80");
    return originPort === String(PORT);
  } catch (_) {
    return false;
  }
}

/**
 * /api/select CSRF guard.
 * Cross-site <img>/<script> GETs omit Origin but send Sec-Fetch-Site: cross-site.
 * Reject cross-site / same-site; if Sec-Fetch-Site is absent, require a valid Origin
 * (fetch always sends Origin; simple cross-site loads omit it).
 */
function allowProjectSelect(req) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return false;
  if (site === "same-origin" || site === "none") return true;
  const origin = req.headers.origin;
  return !!(origin && isAllowedOrigin(origin));
}

/**
 * Reject cross-site / non-loopback access so other websites cannot read or drive the bridge.
 * Checks socket remote address, Host, and Origin (when sent). Origin "null" is never allowed.
 * @returns {boolean} true if the request was rejected
 */
function rejectIfNotLocal(req, res) {
  const remote = (req.socket && req.socket.remoteAddress) || "";
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!isLoopbackAddress(remote) || !isLocalhostHost(host) || !isAllowedOrigin(origin)) {
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end("Forbidden · localhost only");
    return true;
  }
  return false;
}

function serveDashboard(res) {
  fs.readFile(DASHBOARD, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Missing model-routing-dashboard.html next to live-bridge.js");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

/**
 * Serve files under /dashboard/* from the dashboard/ folder (CSS/JS split).
 * Rejects path traversal; only GET-friendly static assets.
 */
function serveStatic(urlPath, res) {
  if (!urlPath.startsWith("/dashboard/")) return false;
  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice("/dashboard/".length));
  } catch (_e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return true;
  }
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return true;
  }
  const resolved = path.resolve(STATIC_ROOT, rel);
  const rootResolved = path.resolve(STATIC_ROOT) + path.sep;
  if (resolved !== path.resolve(STATIC_ROOT) && !resolved.startsWith(rootResolved)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }
  fs.stat(resolved, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Read error");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
  return true;
}

function createServer() {
  return http.createServer((req, res) => {
    if (rejectIfNotLocal(req, res)) return;

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
      if (!allowProjectSelect(req)) {
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

    if (url.pathname === "/api/history") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "GET required" });
        return;
      }
      const since = url.searchParams.get("since") || undefined;
      const session = url.searchParams.get("session") || undefined;
      const list = eventLog ? eventLog.query({ since, session }) : [];
      sendJson(res, 200, { events: list });
      return;
    }

    if (url.pathname === "/api/history/clear") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (!allowProjectSelect(req)) {
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
          projectLabel: currentProjectLabel
        })}\n\n`
      );
      const backlog = events.slice(-40);
      for (const ev of backlog) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
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
 * @param {{port?:number, dir?:string, quiet?:boolean, reuseExisting?:boolean, onAgentAlert?:Function, eventLogDir?:string, eventLogPath?:string}} [opts]
 * @returns {Promise<{port:number, reused:boolean, transcripts:string}>}
 */
function startBridge(opts) {
  opts = opts || {};
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
  PORT = Number(opts.port || flag("--port") || 3847);
  resolveDefaultTranscripts(opts);

  eventLog = createEventLog({
    logDir: opts.eventLogDir,
    logPath: opts.eventLogPath
  });
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
    eventLog = createEventLog();
  }
  agentWatch.clear();
  return eventLog.clear();
}

module.exports = {
  startBridge,
  stopBridge,
  discoverProjects,
  resetWatchState,
  selectProject,
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
