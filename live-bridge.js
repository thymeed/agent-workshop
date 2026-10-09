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

const PROJECTS_ROOT = path.join(os.homedir(), ".cursor", "projects");
const FALLBACK_DIR = path.join(
  PROJECTS_ROOT,
  "c-Users-louje-OneDrive-Desktop-Custom-TUI",
  "agent-transcripts"
);
const DASHBOARD = path.join(__dirname, "model-routing-dashboard.html");
const STATIC_ROOT = path.join(__dirname, "dashboard");
const MAX_EVENTS = 400;
const POLL_MS = 900;

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
let TRANSCRIPTS = FALLBACK_DIR;
/** @type {string|null} */
let currentProjectId = null;
/** @type {string|null} */
let currentProjectLabel = null;

/** @type {Array<object>} */
const events = [];
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
/** filePath -> { size, warm } */
const fileState = new Map();
/** subagent uuid -> role */
const subagentRoles = new Map();
let eventSeq = 0;
let lastScanError = null;

/** @type {http.Server|null} */
let server = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;
let quiet = false;
let started = false;

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

  TRANSCRIPTS = FALLBACK_DIR;
  currentProjectId = "c-Users-louje-OneDrive-Desktop-Custom-TUI";
  currentProjectLabel = humanizeProjectId(currentProjectId);
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

function resetWatchState() {
  events.length = 0;
  fileState.clear();
  subagentRoles.clear();
  // Keep eventSeq monotonic so client after= / seenLiveIds stay valid across project switches
  lastScanError = null;
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
    pushEvent({
      role: "parent",
      kind: "message",
      message: "task / turn · " + body,
      active: ["opus"],
      usage: estimateUsage("parent", obj, { inText: text, outText: "" }),
      source: src
    });
    return;
  }

  if (obj.role !== "assistant") return;

  const text = extractText(obj);
  const tools = extractToolUses(obj);
  let outChars = String(text || "").length;
  for (const t of tools) outChars += toolEstimateChars(t);
  const takeUsage = onceUsage(estimateUsage("parent", obj, { inText: "", outChars }));

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
      pushEvent({
        role: delegate ? role : "parent",
        kind: "delegates",
        message: "delegates · " + (subType || role) + " · " + desc,
        active: delegate ? [card] : ["opus"],
        route: "delegates",
        routeTo: card,
        tokensDelta: role === "explorer" || role === "researcher" ? 24000 : 0,
        usage: takeUsage(),
        source: src
      });
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
    pushEvent({
      role: "parent",
      kind: "message",
      message: "reply · " + snippet(text, 90),
      active: ["opus"],
      usage: takeUsage(),
      source: src
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
  }
}

function handleSubagentLine(obj, filePath, roleHint) {
  if (!obj || !obj.role) return;
  let role = roleHint || "worker";
  const src = path.basename(filePath);

  if (obj.role === "user") {
    const text = extractText(obj);
    const inferred = inferRoleFromSubagentText(text);
    if (inferred !== "parent") role = inferred;
    const uuid =
      path.basename(path.dirname(filePath)) === "subagents"
        ? path.basename(filePath, ".jsonl")
        : null;
    if (uuid) subagentRoles.set(uuid, role);
    const q = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    const body = snippet(q ? q[1] : text, 80);
    pushEvent({
      role,
      kind: "delegates",
      message: "spawned · " + body,
      active: [roleToCard(role)],
      route: role === "advisor" ? "asks" : "delegates",
      routeTo: roleToCard(role),
      tokensDelta: role === "explorer" || role === "researcher" ? estimateReadTokens(text) : 0,
      usage: estimateUsage(role, obj, { inText: text, outText: "" }),
      source: src
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

    if (activities.length === 0) {
      pushEvent({
        role,
        kind: "status",
        message: msg,
        active: [roleToCard(role)],
        tokensDelta,
        usage: takeUsage(),
        source: src
      });
      return;
    }

    pushEvent({
      role,
      kind: "status",
      message: msg,
      active: [roleToCard(role)],
      tokensDelta,
      usage: takeUsage(),
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
    const start = Math.max(0, st.size - 8192);
    state = { size: start, warm: false };
    fileState.set(filePath, state);
  }
  if (st.size < state.size) {
    state.size = 0;
  }
  if (st.size === state.size) return;

  const readFrom = state.size;
  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    const len = st.size - state.size;
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, readFrom);
    fs.closeSync(fd);
  } catch (e) {
    lastScanError = String(e.message || e);
    return;
  }
  state.size = st.size;

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  // A mid-file tail can start on a partial line. A brand-new file (start === 0)
  // must keep line 1 so the subagent spawn record is not dropped.
  const startedMidFile = !state.warm && readFrom > 0;
  if (startedMidFile && lines.length > 1) {
    lines.shift();
  }
  state.warm = true;

  const sub = isSubagentFile(filePath);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    if (sub) handleSubagentLine(obj, filePath, roleForFile(filePath));
    else handleParentLine(obj, filePath);
  }
}

function scan() {
  try {
    const files = listJsonlFiles(TRANSCRIPTS).slice(0, 40);
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
 * If present, must be http(s) to localhost / 127.0.0.1 / ::1 — not "null" or other sites.
 */
function isAllowedOrigin(origin) {
  if (origin == null || origin === "") return true;
  if (origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch (_) {
    return false;
  }
}

/**
 * Reject cross-site / non-loopback access so other websites cannot read or drive the bridge.
 * Checks socket remote address, Host, and Origin (when sent).
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
  const rel = decodeURIComponent(urlPath.slice("/dashboard/".length));
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad path");
    return true;
  }
  const resolved = path.resolve(STATIC_ROOT, rel);
  const rootResolved = path.resolve(STATIC_ROOT) + path.sep;
  if (resolved !== path.resolve(STATIC_ROOT) && !resolved.startsWith(rootResolved)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }
  fs.stat(resolved, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
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

    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

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
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, error: "Missing id query param" });
        return;
      }
      const result = selectProject(id);
      sendJson(res, result.ok ? 200 : 400, result);
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
 * @param {{port?:number, dir?:string, quiet?:boolean, reuseExisting?:boolean}} [opts]
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
  PORT = Number(opts.port || flag("--port") || 3847);
  resolveDefaultTranscripts(opts);

  return new Promise((resolve, reject) => {
    server = createServer();

    const onListening = () => {
      started = true;
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
        projectLabel: currentProjectLabel
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

module.exports = {
  startBridge,
  stopBridge,
  discoverProjects,
  resetWatchState,
  selectProject
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
