#!/usr/bin/env node
"use strict";

/**
 * Sanitize a real Claude Code session into a shareable test fixture set.
 *
 * Read-only on the input. Every string value becomes the placeholder "S1" unless
 * its key is on a short allowlist AND the value passes a check against a known
 * set (line types, statuses, model slugs, built-in agent types, built-in tool
 * names). Anything else on those keys is "S1" too. Object keys are an ALLOWLIST:
 * a key survives only if it is in KNOWN_KEYS (the structural keys of the format)
 * and is not inside a data-keyed map (counts, trackedFileBackups, answers, ...),
 * the input of a non-built-in tool, the toolUseResult of a result not linked to
 * a built-in tool_use, or the subtree of an unknown (hashed) key. Every other key
 * becomes "k_<12 hex>" (HMAC with the per-run salt: the same name everywhere in a
 * run, no shared state with the id map). Ids become hashed ids using a
 * random per-run salt that lives in memory only (one map across the parent and
 * all subagent files, so links stay valid; two runs give different ids).
 * Timestamps are shifted to a fixed base with order and deltas preserved.
 *
 * Not kept verbatim, on purpose:
 *   - arrays are cut to their first 3 items, EXCEPT message.content arrays
 *     (every block of a message survives, so tool_use / tool_result links hold);
 *   - non-built-in agent types become custom-1, custom-2, ... (generic planner,
 *     worker, reviewer, researcher are kept); MCP tools other than the
 *     claude.ai Docs connector become mcp__s1__<hash>; other unknown tool names
 *     become custom-tool-N;
 *   - <task-notification> blocks are rebuilt (hashed ids, status, usage numbers)
 *     only in their known carriers: queue-operation.content, attachment.prompt
 *     and the user/system message text that delivers them. Anywhere else a
 *     string containing the tag is "S1".
 *
 *   node scripts/sanitize-claude-transcript.js \
 *     --session <path/to/<id>.jsonl> --out <dir> --proj <neutral-dir-name> \
 *     [--name s1] [--compact] [--oversize 9000] [--truncate-last] [--synthetic-growth]
 *
 * --proj and --name must match ^[A-Za-z0-9._-]+$ (not "." or ".."). The run is
 * refused if any output path equals an input path or the output project folder
 * is inside the input file's folder.
 *
 * Output: <out>/<proj>/<name>.jsonl and
 *         <out>/<proj>/<name>/subagents/agent-a<N>.jsonl|.meta.json
 *
 * --compact           keep the first line of each distinct line shape plus every
 *                     delegation line (Agent call/result, task-notification) and
 *                     lines sharing a kept assistant message.id. Kept lines get
 *                     their parentUuid rewritten to the nearest kept ancestor, so
 *                     every link still resolves inside its file.
 * --oversize N        SYNTHETIC: append one placeholder-only line > N bytes to the
 *                     parent file (tests line-length limits). Marked "_synthetic".
 * --truncate-last     SYNTHETIC: cut the last parent line in half and drop its
 *                     newline (simulates a file being written mid-line).
 * --synthetic-growth  SYNTHETIC: in the first subagent file, make the first
 *                     repeated assistant message.id start with partial usage
 *                     (output_tokens 3) that grows on its later line. Marked
 *                     "_synthetic". Real data has this too; the sources used
 *                     for the committed fixtures did not.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PLACEHOLDER = "S1";
const BASE_TS = Date.parse("2026-01-01T00:00:00.000Z");

// Values allowed on these keys only if they are in the known set below.
const ENUM_KEYS = new Set(["type", "subtype", "status", "stop_reason", "operation", "role"]);
const KNOWN_ENUM_VALUES = new Set([
  // line / block / attachment types
  "user",
  "assistant",
  "system",
  "attachment",
  "queue-operation",
  "ai-title",
  "mode",
  "permission-mode",
  "session-owner",
  "last-prompt",
  "file-history-snapshot",
  "file-history-delta",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "tools-used",
  "cost-state",
  "pr-link",
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "message",
  "environment",
  "instructions",
  "session_context",
  "date",
  "credential_org",
  "remote_session_change",
  "prompt_snapshot",
  "mcp_instructions_delta",
  "edited_text_file",
  "deferred_tools_record",
  "deferred_tools_delta",
  "agent_listing_delta",
  "skill_listing",
  "tool_addition",
  "tool_definition",
  "hook_success",
  "queued_command",
  "silent_turn_reminder",
  "create",
  "object",
  "string",
  "integer",
  "boolean",
  "number",
  "array",
  "null",
  "direct",
  "adaptive",
  "ephemeral",
  // subtypes, operations, statuses, stop reasons, roles
  "turn_duration",
  "enqueue",
  "dequeue",
  "remove",
  "async_launched",
  "completed",
  "failed",
  "killed",
  "running",
  "stopped",
  "error",
  "success",
  "tool_use",
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "pause_turn",
  "refusal"
]);

const MODEL_KEYS = new Set([
  "model",
  "resolvedModel",
  "requestedModel",
  "advisorModel",
  "pickedEffortModel"
]);
// Real families only; any other claude-* slug is data.
const MODEL_RE =
  /^(claude-(opus|sonnet|haiku|fable)-[0-9]{1,2}(-[0-9]{1,2})*(-[0-9]{8})?|opus|sonnet|haiku|inherit)$/;

const AGENT_KEYS = new Set(["subagent_type", "agentType", "attributionAgent"]);
const KNOWN_AGENT_TYPES = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "output-style-setup",
  "fork",
  // the owner's generic custom agents
  "planner",
  "worker",
  "reviewer",
  "researcher"
]);

const BUILTIN_TOOLS = new Set([
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
  "Bash",
  "BashOutput",
  "KillShell",
  "PowerShell",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Skill",
  "SlashCommand",
  "ToolSearch",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "SendMessage",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "PushNotification",
  "RemoteTrigger",
  "ListAgents",
  "ReportFindings",
  "SendFeedback",
  "SubagentHandback",
  "Artifact",
  "advisor",
  "DeferredToolPlaceholder"
]);
const DOCS_TOOL_RE =
  /^mcp__claude_ai_Claude_Docs__(batch|guide|update|create|delete|export|query|read)$/;
const MCP_TOOL_RE = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/;

// The structural keys of the Claude Code transcript format: line fields, message and
// usage fields, content-block fields, toolUseResult / attachment / snapshot fields and the
// input fields of built-in tools. Every other object key is data and gets hashed.
const KNOWN_KEYS = new Set(
  `_synthetic accountUuid additionalWorkingDirectories advisorModel agentId agentType aiTitle
  apiBlockIndex atis attachment attributionAgent backup backupFileName backupTime betas branch
  cacheControl cache_creation cache_creation_input_tokens cache_read_input_tokens caller
  canContinueAgent canReadOutputFile clean command commandMode commandUuid container content
  contentNotInModelContext context context_management counts cwd decision default_branch
  definition deliveryId delivery_id description diagnostics display durationMs
  eager_input_streaming edits effort entrypoint ephemeral_1h_input_tokens
  ephemeral_5m_input_tokens error exitCode fallback_credit file filePath file_path finished
  gitBranch git_state hash head_limit header hookEvent hookName host id inference_geo input
  input_schema input_tokens input_transformations interrupted isAsync isBuiltIn isGitRepo
  isImage isMeta isSidechain isSnapshotUpdate isWorktree is_error iterations keep kind label
  launchedWithDefaults leafUuid limit lines live_cwd max_tokens message messageCount messageId
  mode model modelUsage multiSelect name newLines newStart newString new_string
  noOutputExpected numLines offset oldLines oldStart oldString old_string operation options
  originalFile origin osVersion outputFile output_config output_mode output_tokens
  output_tokens_details parentUuid params path pattern perTurnEffort permissionDecision
  permissionMode pickedEffortModel platform porcelain prNumber prRepository prUrl producer
  prompt promptCacheRequested promptId promptIndex promptSource push_remote querySource
  question questions realParentDir reason reasonType remote remotes rendered
  renderedInHumanTurn renderedRole replaceAll replace_all request requestDigest requestId
  requestNonInteractive requestRef requestShape requestedModel resolvedModel role root runId
  sandboxed scope scratchpadDirectory serverClassifierContext serverClassifierRequest
  server_tool_use service_tier sessionId session_id shape shapeHash shell signature snapshot
  snapshotMessageId source sourceToolAssistantUUID source_uuid spawnDepth speed
  staleReadFileStateHint staleRecovered startLine status stderr stdout stop_details
  stop_reason stop_sequence structuredPatch subagent_type subtype system tail text thinking
  thinkingDisplay thinkingDurationMs thinking_tokens timestamp tool toolInputStreamMs
  toolUseID toolUseId toolUseResult toolUses toolsUsedDelta tool_use_id tools totalLines
  totalTokens trackedFileBackups trackingPath truncated ttl turnIndex turnOrigin
  turnPosition type usage userModified userType uuid value version visibility
  visibility_cache web_fetch_requests web_search_requests wireIngestContext wireToolInputs
  workingDirectory answers annotations toolInputCopies`
    .split(/\s+/)
    .filter(Boolean)
);

// Maps whose keys are data (file paths, model ids, question text, ...).
const DATA_KEYED = new Set([
  "trackedFileBackups",
  "counts",
  "wireToolInputs",
  "wireIngestContext",
  "toolInputCopies",
  "modelUsage",
  "answers",
  "annotations",
  "mcpServers",
  "env",
  "headers",
  "metadata",
  "capabilities"
]);

const ID_KEYS = new Set([
  "id",
  "uuid",
  "session_id",
  "from",
  "hash",
  "requestRef",
  "requestDigest",
  "serverClassifierRequest",
  "task-id",
  "tool-use-id",
  "tool_use_id",
  "messageId",
  "toolUseID"
]);
const idKey = (k) => ID_KEYS.has(k) || /(Id|ID|Uuid|UUID|Hash)$/.test(k);

const ID_PREFIX_RE = /^(toolu|srvtoolu|msg|req|call)_/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSanitizer(agentNames) {
  const idMap = new Map(agentNames);
  const salt = crypto.randomBytes(16); // memory only; ids are stable within one run
  const customAgents = new Map();
  const customTools = new Map();

  const digest = (v) => crypto.createHmac("sha1", salt).update(String(v)).digest("hex");
  const hashId = (v) => {
    if (idMap.has(v)) return idMap.get(v);
    const h = digest(v);
    let out;
    const pref = ID_PREFIX_RE.exec(v);
    if (UUID_RE.test(v)) {
      out = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    } else if (pref) {
      out = pref[0] + h.slice(0, Math.max(8, Math.min(24, v.length - pref[0].length)));
    } else {
      out = h.slice(0, Math.max(8, Math.min(40, v.length)));
    }
    idMap.set(v, out);
    return out;
  };

  const mapAgent = (v) => {
    if (KNOWN_AGENT_TYPES.has(v)) return v;
    if (v === "") return v;
    if (!customAgents.has(v)) customAgents.set(v, `custom-${customAgents.size + 1}`);
    return customAgents.get(v);
  };
  const isKeptTool = (n) => typeof n === "string" && (BUILTIN_TOOLS.has(n) || DOCS_TOOL_RE.test(n));
  const mapTool = (n) => {
    if (isKeptTool(n)) return n;
    const m = MCP_TOOL_RE.exec(n);
    if (m) return "mcp__s1__" + digest("tool:" + m[2]).slice(0, 12);
    if (!customTools.has(n)) customTools.set(n, `custom-tool-${customTools.size + 1}`);
    return customTools.get(n);
  };

  // Keys never touch idMap: one fixed-length name per key, the same in every file.
  const hashedKey = (k) => "k_" + digest("key:" + k).slice(0, 12);
  const hashKey = (k, parentKey, hashAll) => {
    if (/^(toolu_|msg_)/.test(k)) return hashId(k);
    if (parentKey === "modelUsage" && MODEL_RE.test(k)) return k;
    if (hashAll || DATA_KEYED.has(parentKey) || !KNOWN_KEYS.has(k)) return hashedKey(k);
    return k;
  };

  // tool_use id -> built-in/Docs (true) or not; lives for the whole run, so a result in
  // one line or file is judged by the call made in another.
  const toolIds = new Map();
  const noteTools = (v) => {
    if (Array.isArray(v)) v.forEach(noteTools);
    else if (v && typeof v === "object") {
      if (v.type === "tool_use" && typeof v.id === "string") toolIds.set(v.id, isKeptTool(v.name));
      for (const x of Object.values(v)) noteTools(x);
    }
  };
  // A line's toolUseResult keeps its key names only if every tool_result it carries
  // answers a built-in tool_use (and there is at least one); unknown ids are unsafe.
  const resultKeysSafe = (obj) => {
    const c = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
    const ids = c.filter((b) => b && b.type === "tool_result").map((b) => b.tool_use_id);
    return ids.length > 0 && ids.every((id) => toolIds.get(id) === true);
  };

  // task-notification payloads: keep only the block itself. Status and usage
  // numbers survive, ids are hashed, everything else becomes the placeholder.
  const notification = (s) => {
    const m = /<task-notification>[\s\S]*?<\/task-notification>/.exec(s);
    if (!m) return PLACEHOLDER;
    const usage = /<usage>([\s\S]*?)<\/usage>/.exec(m[0]);
    const usageOk =
      usage &&
      /^(<(subagent_tokens|total_tokens|tool_uses|duration_ms)>\d+<\/\2>)*$/.test(usage[1]);
    const status = /<status>([a-z_]{1,30})<\/status>/.exec(m[0]);
    const id = (t) => {
      const x = new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[0]);
      return `<${t}>${x ? hashId(x[1]) : PLACEHOLDER}</${t}>`;
    };
    return [
      "<task-notification>",
      id("task-id"),
      id("tool-use-id"),
      `<output-file>${PLACEHOLDER}</output-file>`,
      `<status>${status && KNOWN_ENUM_VALUES.has(status[1]) ? status[1] : PLACEHOLDER}</status>`,
      `<summary>${PLACEHOLDER}</summary>`,
      `<note>${PLACEHOLDER}</note>`,
      `<result>${PLACEHOLDER}</result>`,
      `<usage>${usageOk ? usage[1] : ""}</usage>`,
      "</task-notification>"
    ].join("\n");
  };

  // Only these places deliver a notification; everywhere else the tag is just text.
  const isNotificationCarrier = (key, parent, ctx) => {
    if (!parent) return false;
    const top = parent === ctx.root;
    if (ctx.lineType === "queue-operation") return top && key === "content";
    if (ctx.lineType === "attachment") return key === "prompt" && parent.type === "queued_command";
    if (ctx.lineType === "user" || ctx.lineType === "system") {
      if (key === "content" && typeof parent.role === "string") return true; // message.content string
      if (key === "text" && parent.type === "text") return true; // message.content text block
      if (ctx.lineType === "system" && top && key === "content") return true;
    }
    return false;
  };

  const shiftTs = (v, baseMs) => {
    const t = Date.parse(v);
    if (Number.isNaN(t) || !/^\d{4}-\d\d-\d\dT/.test(v)) return PLACEHOLDER;
    return new Date(BASE_TS + (t - baseMs)).toISOString();
  };

  const isToolContext = (parent) =>
    !!parent && (parent.type === "tool_use" || parent.input_schema !== undefined);

  function walkString(v, key, parent, baseMs, ctx) {
    if (key === "timestamp") return shiftTs(v, baseMs);
    if (idKey(key)) return hashId(v);
    if (v.trimStart().startsWith("<task-notification>") && isNotificationCarrier(key, parent, ctx))
      return notification(v);
    if (ENUM_KEYS.has(key)) return KNOWN_ENUM_VALUES.has(v) ? v : PLACEHOLDER;
    if (MODEL_KEYS.has(key)) return MODEL_RE.test(v) ? v : PLACEHOLDER;
    if (AGENT_KEYS.has(key)) return mapAgent(v);
    if (key === "name" && isToolContext(parent)) return mapTool(v);
    return PLACEHOLDER;
  }

  function walk(v, key, parent, baseMs, ctx, hashAll) {
    if (typeof v === "string") return walkString(v, key, parent, baseMs, ctx);
    if (Array.isArray(v)) {
      const keepAll = key === "content" && parent && typeof parent.role === "string";
      return (keepAll ? v : v.slice(0, 3)).map((x) => walk(x, key, parent, baseMs, ctx, hashAll));
    }
    if (v && typeof v === "object") {
      if (key === "input_schema") return { type: "object" };
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        let childAll = hashAll;
        if (k === "input" && v.type === "tool_use" && !isKeptTool(v.name)) childAll = true;
        // wireToolInputs.<tool_use id>: unsafe if that id belongs to a non-built-in tool
        if (key === "wireToolInputs" && toolIds.get(k) !== true) childAll = true;
        // toolUseResult of anything but a built-in tool's result: every key is data
        if (k === "toolUseResult" && !ctx.resultSafe) childAll = true;
        // an unknown key is data; so is everything under it (data-keyed maps excepted,
        // whose children are expected data keys over structural values)
        if (!KNOWN_KEYS.has(k) && !DATA_KEYED.has(key) && !/^(toolu_|msg_)/.test(k))
          childAll = true;
        out[hashKey(k, key, hashAll)] = walk(x, k, v, baseMs, ctx, childAll);
      }
      return out;
    }
    if (typeof v === "number") {
      // Numbers are data unless they sit under a known key outside an opaque subtree.
      // Epoch-ms magnitudes are zeroed everywhere: they would undo the timestamp shift.
      if (hashAll || key === "prNumber") return 0;
      if (Math.abs(v) >= 1e12 && Math.abs(v) < 1e13) return 0;
    }
    return v;
  }

  function sanitize(obj, baseMs) {
    noteTools(obj);
    const ctx = {
      root: obj,
      lineType: obj && typeof obj.type === "string" ? obj.type : "",
      resultSafe: resultKeysSafe(obj)
    };
    return walk(obj, "", null, baseMs, ctx, false);
  }
  return { sanitize, hashId, noteTools };
}

function readLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length);
}

function minTimestamp(files) {
  let min = Infinity;
  for (const f of files) {
    for (const l of readLines(f)) {
      const m = /"timestamp":"(\d{4}-[^"]+)"/.exec(l);
      const t = m ? Date.parse(m[1]) : NaN;
      if (!Number.isNaN(t) && t < min) min = t;
    }
  }
  return Number.isFinite(min) ? min : BASE_TS;
}

function shapeKey(o) {
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  const parts = c.map((b) => b.type + (b.name ? ":" + b.name : ""));
  return [o.type, o.subtype || o.operation || "", parts.join("+")].join("/");
}

function isDelegation(o, raw) {
  if (raw.includes("<task-notification>")) return true;
  if (o.toolUseResult && o.toolUseResult.agentId) return true;
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  return c.some((b) => b.type === "tool_use" && b.name === "Agent");
}

/**
 * Compact on the raw objects so shape detection sees real structure. Returns
 * clones of the kept entries with parentUuid pointed at the nearest kept
 * ancestor (the input objects are never mutated).
 */
function compact(entries) {
  const seen = new Set();
  const keep = new Set();
  entries.forEach((e, i) => {
    if (!e.obj) return;
    const k = shapeKey(e.obj);
    if (!seen.has(k) || isDelegation(e.obj, e.raw)) {
      seen.add(k);
      keep.add(i);
    }
  });
  // Keep one assistant message.id whose repeated lines carry different usage.
  const usageByMsg = new Map();
  entries.forEach((e, i) => {
    const o = e.obj;
    if (!o || o.type !== "assistant" || !o.message || !o.message.id) return;
    const g = usageByMsg.get(o.message.id) || { first: i, usages: new Set() };
    g.usages.add(JSON.stringify(o.message.usage));
    usageByMsg.set(o.message.id, g);
  });
  for (const g of usageByMsg.values()) {
    if (g.usages.size > 1) {
      keep.add(g.first);
      break;
    }
  }
  const msgIds = new Set(
    [...keep]
      .map((i) => entries[i].obj)
      .filter((o) => o.type === "assistant" && o.message && o.message.id)
      .map((o) => o.message.id)
  );
  entries.forEach((e, i) => {
    if (e.obj && e.obj.type === "assistant" && e.obj.message && msgIds.has(e.obj.message.id))
      keep.add(i);
  });

  const uuidIndex = new Map();
  entries.forEach((e, i) => {
    if (e.obj && typeof e.obj.uuid === "string") uuidIndex.set(e.obj.uuid, i);
  });
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => keep.has(i))
    .map(({ e }) => {
      const o = e.obj;
      if (!("parentUuid" in o)) return e;
      let p = o.parentUuid;
      const guard = new Set();
      while (typeof p === "string" && uuidIndex.has(p) && !keep.has(uuidIndex.get(p))) {
        if (guard.has(p)) break;
        guard.add(p);
        p = entries[uuidIndex.get(p)].obj.parentUuid;
      }
      return { raw: e.raw, obj: { ...o, parentUuid: p } };
    });
}

function parseEntries(file, stats) {
  return readLines(file).map((raw) => {
    try {
      return { raw, obj: JSON.parse(raw) };
    } catch {
      stats.dropped++;
      return { raw, obj: null };
    }
  });
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const validName = (s) => typeof s === "string" && NAME_RE.test(s) && s !== "." && s !== "..";

function parseArgs(argv) {
  const a = { name: "s1" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--compact") a.compact = true;
    else if (k === "--truncate-last") a.truncateLast = true;
    else if (k === "--synthetic-growth") a.syntheticGrowth = true;
    else if (k === "--session") a.session = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--proj") a.proj = argv[++i];
    else if (k === "--name") a.name = argv[++i];
    else if (k === "--oversize") a.oversize = Number(argv[++i]);
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.session || !a.out || !a.proj) {
    throw new Error("usage: --session <file.jsonl> --out <dir> --proj <name> [options]");
  }
  if (!validName(a.proj)) throw new Error("--proj must match ^[A-Za-z0-9._-]+$ (not . or ..)");
  if (!validName(a.name)) throw new Error("--name must match ^[A-Za-z0-9._-]+$ (not . or ..)");
  return a;
}

/** realpath of the nearest existing ancestor, plus the rest; case-folded on Windows. */
function canon(p) {
  let rest = "";
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    rest = path.join(path.basename(cur), rest);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const full = path.join(fs.existsSync(cur) ? fs.realpathSync(cur) : cur, rest);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function inside(parentDir, child) {
  const rel = path.relative(parentDir, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionFile = path.resolve(args.session);
  const subDir = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
  const subFiles = fs.existsSync(subDir)
    ? fs
        .readdirSync(subDir)
        .filter((f) => /^agent-.*\.jsonl$/.test(f))
        .sort()
    : [];

  const agentNames = new Map();
  subFiles.forEach((f, i) => {
    agentNames.set(f.replace(/^agent-|\.jsonl$/g, ""), `a${i + 1}`);
  });
  const sz = createSanitizer(agentNames);

  const allFiles = [sessionFile, ...subFiles.map((f) => path.join(subDir, f))];
  const baseMs = minTimestamp(allFiles);
  // Learn every tool_use (even ones --compact will drop) before any result is judged.
  for (const f of allFiles) {
    for (const e of parseEntries(f, { dropped: 0 })) if (e.obj) sz.noteTools(e.obj);
  }

  const projDir = path.join(path.resolve(args.out), args.proj);
  const sessDir = path.join(projDir, args.name, "subagents");

  // Never write over, or next to, the real input.
  const inputs = [...allFiles];
  subFiles.forEach((f) => inputs.push(path.join(subDir, f.replace(/\.jsonl$/, ".meta.json"))));
  const outputs = [path.join(projDir, `${args.name}.jsonl`)];
  subFiles.forEach((f, i) => {
    outputs.push(path.join(sessDir, `agent-a${i + 1}.jsonl`));
    outputs.push(path.join(sessDir, `agent-a${i + 1}.meta.json`));
  });
  const inputSet = new Set(inputs.map(canon));
  for (const o of outputs) {
    if (inputSet.has(canon(o))) throw new Error(`refusing: output path equals an input: ${o}`);
  }
  if (inside(canon(path.dirname(sessionFile)), canon(projDir))) {
    throw new Error("refusing: output folder is inside the input file's folder");
  }

  const stats = { dropped: 0 };
  let growthDone = false;
  const marked = new Set();
  const render = (file, isSub) => {
    let entries = parseEntries(file, stats);
    if (args.compact) entries = compact(entries);
    let objs = entries.filter((e) => e.obj).map((e) => e.obj);
    if (isSub && args.syntheticGrowth && !growthDone) {
      const firstOf = new Map();
      for (const o of objs) {
        if (o.type !== "assistant" || !o.message || !o.message.id) continue;
        if (!firstOf.has(o.message.id)) firstOf.set(o.message.id, o);
        else {
          const first = firstOf.get(o.message.id);
          first.message = { ...first.message, usage: { ...first.message.usage, output_tokens: 3 } };
          marked.add(first);
          growthDone = true;
          break;
        }
      }
    }
    return objs.map((o) => {
      const out = sz.sanitize(o, baseMs);
      if (marked.has(o)) out._synthetic = "partial-usage";
      return JSON.stringify(out);
    });
  };

  fs.mkdirSync(sessDir, { recursive: true });

  const parent = render(sessionFile, false);
  if (args.oversize) {
    const filler = Array(Math.ceil(args.oversize / 3) + 8)
      .fill(PLACEHOLDER)
      .join(" ");
    parent.push(
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: filler },
        uuid: sz.hashId("oversize-line"),
        sessionId: parent[0] ? JSON.parse(parent[0]).sessionId : sz.hashId("empty-session"),
        timestamp: new Date(BASE_TS + 3600000).toISOString(),
        _synthetic: "oversize"
      })
    );
  }
  let parentText = parent.join("\n");
  if (args.truncateLast && parent.length) {
    const cut = parent[parent.length - 1];
    parentText = parent
      .slice(0, -1)
      .concat(cut.slice(0, Math.floor(cut.length / 2)))
      .join("\n");
  } else if (parent.length) {
    parentText += "\n";
  }
  fs.writeFileSync(path.join(projDir, `${args.name}.jsonl`), parentText);

  subFiles.forEach((f) => {
    const real = f.replace(/^agent-|\.jsonl$/g, "");
    const neutral = agentNames.get(real);
    const lines = render(path.join(subDir, f), true);
    fs.writeFileSync(
      path.join(sessDir, `agent-${neutral}.jsonl`),
      lines.length ? lines.join("\n") + "\n" : ""
    );
    const metaFile = path.join(subDir, `agent-${real}.meta.json`);
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      fs.writeFileSync(
        path.join(sessDir, `agent-${neutral}.meta.json`),
        JSON.stringify(sz.sanitize(meta, baseMs)) + "\n"
      );
    }
  });
  console.log(
    `wrote ${projDir} (${subFiles.length} subagent file(s)); dropped ${stats.dropped} unparseable input line(s)`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
module.exports = { createSanitizer, MODEL_RE, KNOWN_KEYS };
