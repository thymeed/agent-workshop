/** Pure transcript-line parsing: roles, tool activity, token estimates. Holds no bridge state. */
"use strict";

const path = require("path");
const { isSubagentTranscriptPath } = require("./path-segments");

function nowIso() {
  return new Date().toISOString();
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
 * Structured terminal signals only. Never prose keywords like "error" or "done".
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

function isSubagentFile(filePath) {
  return isSubagentTranscriptPath(filePath);
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

function filesFromActivity(activity) {
  if (!activity) return [];
  if (Array.isArray(activity)) {
    return activity.map((a) => (a && a.path ? String(a.path) : "")).filter(Boolean);
  }
  if (activity.path) return [String(activity.path)];
  return [];
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

/** Char count for out-estimate from tools. Uses write body length, not contents string. */
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

module.exports = {
  nowIso,
  transcriptTimestamp,
  extractToolResults,
  terminalTypeFromTranscript,
  resolveTaskChildAgentId,
  agentIdFromFile,
  isSubagentFile,
  roleDisplayName,
  filesFromActivity,
  snippet,
  mapSubagentType,
  roleToCard,
  roleToModel,
  clampTokens,
  charsToTokens,
  estimateUsage,
  toolArgs,
  resolveToolName,
  activityPath,
  toolActivity,
  toolEstimateChars,
  onceUsage,
  inferRoleFromSubagentText,
  extractToolUses,
  extractText,
  estimateReadTokens
};
