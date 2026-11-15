/**
 * Pure Claude Code transcript parsing: one already-parsed JSONL line (plus an optional
 * child `meta.json`) in, dashboard event rows out. No fs, no DOM, no network.
 *
 * Row shape mirrors the Cursor rows in live-bridge.js (`role`, `kind`, `message`,
 * `active`, `route`, `routeTo`, `tokensDelta`, `usage`, `modelRaw`, `modelLabel`,
 * `source`) and adds `ts`, `type` (spawn|turn|done|error, the History vocabulary),
 * `agentId`, `toolUseId` and `sessionId`.
 *
 * Privacy: prompt text, result text, thinking, summaries and api-request blobs are never
 * copied into a row. Messages are built from fixed words, tool names, paths and ids.
 *
 * Caller-owned `state` (see createState) is the only memory: it dedupes usage by
 * `message.id`, notifications by tool-use id, and links children to their Agent call.
 */
"use strict";

const {
  nowIso,
  transcriptTimestamp,
  modelInfoFromSlug,
  isModelPlaceholder,
  snippet,
  toolActivity,
  roleToModel
} = require("./transcript-parse");

/** The five owner roles. "parent" is the Lead (same key the Cursor rows use). */
const ROLES = ["parent", "planner", "researcher", "worker", "reviewer"];
const NAMED_ROLES = new Set(["planner", "researcher", "worker", "reviewer"]);

/* Types outside the five roles map by resolved model family. Guess, owner can overrule:
   opus -> planner, sonnet -> worker, haiku -> researcher, anything else -> worker. */
const ROLE_BY_FAMILY = { opus: "planner", sonnet: "worker", haiku: "researcher" };

function createState() {
  return {
    /** tool_use id -> {subagentType, modelRaw, resolvedModel, agentId, description} */
    calls: new Map(),
    /** child agentId -> tool_use id */
    agents: new Map(),
    /** message.id -> highest usage seen so far (the last line of an id is the final one) */
    usage: new Map(),
    /** model family -> counted tokens, each message.id counted once at its final value */
    totals: {},
    /** JSON `[toolUseId,status,subagentTokens,toolUses,durationMs]` of notifications emitted */
    notified: new Set(),
    /** "t:<toolUseId>" / "a:<agentId>" -> {slug, rank}: first model family seen for a child */
    childModels: new Map(),
    /** child agentIds whose spawn row was already emitted */
    spawned: new Set()
  };
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

/* Characters that draw nothing or reorder text: C0/C1 controls (not the whitespace ones, which
   `snippet` folds to a space), soft hyphen, Mongolian vowel separator, zero-width and bidi
   marks and overrides, invisible operators, BOM. */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** `snippet` for anything shown on a label: also drops the invisible and bidi characters. */
function displayText(text, max) {
  return snippet(str(text).replace(INVISIBLE, ""), max);
}

/** opus|sonnet|haiku|fable from a full slug or a bare alias ("sonnet"); "" if unknown. */
function modelFamily(raw) {
  const info = modelInfoFromSlug(raw);
  if (info.bucket) return info.bucket;
  const m = /(opus|sonnet|haiku|fable)/.exec(info.slug);
  return m ? m[1] : "";
}

/** Display label for a full slug or an alias ("sonnet" -> "Sonnet"); "" for a placeholder. */
function labelFor(raw) {
  const info = modelInfoFromSlug(raw);
  if (info.bucket && info.label) return info.label;
  const fam = modelFamily(raw);
  if (fam) return fam.charAt(0).toUpperCase() + fam.slice(1);
  /* An unknown slug shows verbatim: cap it and drop tag-like text (as every other label). */
  return displayText(info.label, 40);
}

/**
 * Map a delegation type to a role. The five roles map by name; anything else (built-in
 * types such as Explore or general-purpose) maps by model family.
 * @returns {"parent"|"planner"|"researcher"|"worker"|"reviewer"}
 */
function resolveRole(agentType, modelSlug) {
  const t = str(agentType).toLowerCase().trim();
  if (NAMED_ROLES.has(t)) return /** @type {"planner"|"researcher"|"worker"|"reviewer"} */ (t);
  if (t === "lead" || t === "parent") return "parent";
  return ROLE_BY_FAMILY[modelFamily(modelSlug)] || "worker";
}

function cardFor(role) {
  return role === "parent" ? "opus" : role;
}

function roleLabel(role) {
  return role === "parent" ? "Lead" : role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Model slug named by a delegation call or meta, in one order: the parent's Agent result
 * (resolvedModel), then the call's own model, then meta.model. Placeholders ("inherit") are
 * no value. `pickedEffortModel` is not used: it is not the model the child ran. A missing
 * label beats a wrong one. A child's own message.model outranks all of these (see RANK).
 */
function callModel(call, meta) {
  for (const raw of [call && call.resolvedModel, call && call.modelRaw, meta && meta.model]) {
    if (raw && !isModelPlaceholder(raw)) return raw;
  }
  return "";
}

/* Remembered child model: one order for spawn, assistant and done rows. Highest wins:
   own message.model > parent Agent result resolvedModel > call input.model > meta.model.
   Only a strictly higher rank replaces what is remembered, so within a rank the first
   family seen sticks. */
const RANK = { own: 4, resolved: 3, call: 2, meta: 1 };
const toolKey = (id) => (id ? "t:" + id : "");
const agentKey = (id) => (id ? "a:" + id : "");

function rememberModel(state, keys, slug, rank) {
  if (!slug || isModelPlaceholder(slug) || !modelFamily(slug)) return;
  for (const k of keys) {
    if (!k) continue;
    const had = state.childModels.get(k);
    if (!had || rank > had.rank) state.childModels.set(k, { slug, rank });
  }
}

/** Highest-ranked remembered slug across the keys; "" if none. */
function recallModel(state, keys) {
  const e = recallEntry(state, keys);
  return e ? e.slug : "";
}

function recallEntry(state, keys) {
  let best = null;
  for (const k of keys) {
    const e = k && state.childModels.get(k);
    if (e && (!best || e.rank > best.rank)) best = e;
  }
  return best;
}

/**
 * Allowlist: only http: and https: survive, as scheme and host (no userinfo, query or
 * fragment), plus the first path segment only when it is a plain word. Secrets ride in paths
 * (Slack webhooks, Telegram `/bot<token>`), so any segment with a digit, colon or other
 * character, or longer than 20, is dropped and only the host shows. Every other scheme
 * (data:, javascript:, mailto:, blob:, ...) and anything unparseable gives "".
 */
function safeUrl(raw) {
  try {
    const url = new URL(str(raw));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const first = url.pathname.split("/")[1] || "";
    const seg = /^[A-Za-z_-]{1,20}$/.test(first) ? "/" + first : "";
    return (url.protocol + "//" + url.host + seg).slice(0, 120);
  } catch (_) {
    return "";
  }
}

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_file",
  "target_directory",
  "working_directory",
  "url"
];

const VALUE_MAX = 4096;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^(?:\\\\[?.]\\)?[A-Za-z]:(?=[\\/]|$)/;
const LINE_SUFFIX = /(?::\d+){1,2}(?:-\d+)?$/;
const EMBEDDED_SCHEME = /[a-z][a-z0-9+.-]+:\/\//i;

/**
 * Clean one path-like value. The check runs on the exact string the display will show:
 * `snippet` (as toolActivity's activityPath uses it) drops tag-like text, folds all
 * whitespace (NBSP and BOM included) and trims. Leading junk that the display keeps but a
 * URL parser may or may not skip (quote, NUL, brackets, ...) is ignored when looking for a
 * scheme. A scheme of 2+ letters sends the value through safeUrl; a single letter is a
 * Windows drive, and "name:42" (digits only after the colon, a line number) is a path.
 * Any other "word:stuff" is hidden: unsure means a url, which fails safe.
 */
function cleanPathValue(raw, isUrlKey) {
  const d = displayText(raw.slice(0, VALUE_MAX), VALUE_MAX);
  if (!d) return "";
  const c = d.replace(/^[^A-Za-z]+/, "");
  if (isUrlKey) return safeUrl(c);
  let proto = "";
  try {
    proto = new URL(c).protocol;
  } catch (_) {
    const m = SCHEME.exec(c);
    proto = m ? m[0] : "";
  }
  if (proto.length > 2) {
    const rest = c.slice(proto.length);
    return /^\d{1,8}([:-]\d+)*$/.test(rest) ? d : safeUrl(c);
  }
  const emb = EMBEDDED_SCHEME.exec(d);
  if (emb) return safeUrl(d.slice(emb.index));
  /* A colon is allowed only as a drive letter or a trailing :line[:col]; anything else could
     be a scheme the checks above cannot name (inner tab or NUL, odd characters): hide it. */
  const bare = d.replace(DRIVE, "").replace(LINE_SUFFIX, "");
  /* Cut at the first ? or # (token risk). Deliberate: "docs/C#-notes.md" shows as "docs/C". */
  return bare.includes(":") ? "" : d.replace(/[?#].*$/, "");
}

/**
 * The only tool input that may reach toolActivity: path-like keys, each value cleaned
 * (see cleanPathValue), so no tool's url (or url-shaped path) can carry a query or a blob.
 */
function safeToolInput(input) {
  const args = isObj(input.arguments) ? input.arguments : input;
  const out = {};
  for (const k of PATH_KEYS) {
    const v = str(args[k]);
    if (!v) continue;
    out[k] = cleanPathValue(v, k === "url");
  }
  return out;
}

/**
 * Small, safe view of a child meta.json. Anything else is dropped. The strings are raw on
 * purpose: `toolUseId` is matched against the raw tool-use ids in `state.calls`. Rows built
 * from them are sanitized by `cleanRow`.
 */
function parseMeta(meta) {
  if (!isObj(meta)) return null;
  return {
    agentType: str(meta.agentType),
    toolUseId: str(meta.toolUseId),
    model: str(meta.model),
    pickedEffortModel: str(meta.pickedEffortModel)
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function readUsage(u) {
  if (!isObj(u)) return null;
  return {
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens)
  };
}

/**
 * Count usage once per message.id. Lines repeat per content block; usage is usually the
 * same but can grow, and the last line holds the final value, so only the growth over what
 * was already counted is returned. Missing/partial fields count as 0 (never shrink).
 * @returns {{in:number,out:number,cacheRead:number,cacheWrite:number}|null} delta, or null
 */
function usageDelta(state, msg) {
  const cur = readUsage(msg && msg.usage);
  if (!cur) return null;
  const id = str(msg.id);
  /* No id means no way to tell a repeated line from a new one: counting it could double count. */
  if (!id) return null;
  const prev = state.usage.get(id) || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const delta = {
    in: Math.max(0, cur.in - prev.in),
    out: Math.max(0, cur.out - prev.out),
    cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
    cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite)
  };
  state.usage.set(id, {
    in: Math.max(prev.in, cur.in),
    out: Math.max(prev.out, cur.out),
    cacheRead: Math.max(prev.cacheRead, cur.cacheRead),
    cacheWrite: Math.max(prev.cacheWrite, cur.cacheWrite)
  });
  if (!delta.in && !delta.out && !delta.cacheRead && !delta.cacheWrite) return null;
  return delta;
}

function addTotals(state, family, d) {
  const t = (state.totals[family] = state.totals[family] || {
    in: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0
  });
  t.in += d.in;
  t.out += d.out;
  t.cacheRead += d.cacheRead;
  t.cacheWrite += d.cacheWrite;
}

/** Per-model-family token totals counted so far (each message.id once, at its last value). */
function usageTotals(state) {
  return JSON.parse(JSON.stringify((state && state.totals) || {}));
}

/** An id from a notice is kept only if it looks like one (1-64 of A-Z a-z 0-9 _ -). */
const safeId = (v) => (/^[A-Za-z0-9_-]{1,64}$/.test(str(v)) ? v : "");

const TAG_NAME_MAX = 24;
const FREE_TEXT = { summary: /<\/summary>/gi, note: /<\/note>/gi, result: /<\/result>/gi };
const USAGE_CLOSE = /<\/usage>/gi;

/** Index just past the first match of the global regex at or after `from`; -1 if none. */
function endOfClose(re, s, from) {
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index + m[0].length : -1;
}

/**
 * Read a tag at `at` (which holds "<"). Looks ahead at most TAG_NAME_MAX+3 characters, so
 * a long run of "<" can never turn the walk quadratic.
 * @returns {{name:string,closing:boolean,end:number}|null} `end` is just past the ">"
 */
function tagAt(s, at) {
  let j = at + 1;
  const closing = s.charCodeAt(j) === 47;
  if (closing) j++;
  const from = j;
  while (j < s.length && j - from <= TAG_NAME_MAX) {
    const c = s.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45)) break;
    j++;
  }
  if (j === from || s[j] !== ">") return null;
  return { name: s.slice(from, j).toLowerCase(), closing, end: j + 1 };
}

/**
 * Walk `s` once, top level only. summary/note/result are skipped whole (to their close tag,
 * or to the end if unclosed) without reading any tag inside them. `onTag(name, value, end)`
 * gets the text of each simple "<name>value</name>" tag in `wanted`; `onBlock(name, body)`
 * gets a usage block body. Linear: every step moves forward, no backtracking regex.
 */
function walkTopLevel(s, wanted, onValue, onBlock) {
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) return;
    const tag = tagAt(s, lt);
    if (!tag || tag.closing) {
      i = lt + 1;
      continue;
    }
    if (FREE_TEXT[tag.name]) {
      const end = endOfClose(FREE_TEXT[tag.name], s, tag.end);
      if (end < 0) return;
      i = end;
      continue;
    }
    if (tag.name === "usage" && onBlock) {
      const end = endOfClose(USAGE_CLOSE, s, tag.end);
      if (end < 0) return;
      onBlock(s.slice(tag.end, end - "</usage>".length));
      i = end;
      continue;
    }
    if (wanted.includes(tag.name)) {
      const close = s.indexOf("<", tag.end);
      const c = close < 0 ? null : tagAt(s, close);
      if (c && c.closing && c.name === tag.name) {
        onValue(tag.name, s.slice(tag.end, close).trim());
        i = c.end;
        continue;
      }
    }
    i = tag.end;
  }
}

/**
 * Parse the structured fields of a task-notification. Result/summary/note text is skipped,
 * never read: ids and status come from top-level tags only, usage from the last top-level
 * <usage> block. `status` is returned raw on purpose: it is allowlisted by `notificationType`
 * before it is displayed, and anything unknown shows as "unknown".
 * @returns {{toolUseId:string,taskId:string,status:string,subagentTokens:number,toolUses:number,durationMs:number}|null}
 */
function parseTaskNotification(text) {
  const s = str(text);
  if (!s.includes("<task-notification>")) return null;
  const head = {};
  let usage = {};
  walkTopLevel(
    s,
    ["task-id", "tool-use-id", "status"],
    (name, value) => {
      if (!(name in head)) head[name] = value;
    },
    (body) => {
      const block = {};
      walkTopLevel(body, ["subagent_tokens", "tool_uses", "duration_ms"], (name, value) => {
        if (!(name in block)) block[name] = value;
      });
      usage = block;
    }
  );
  const toolUseId = safeId(head["tool-use-id"]);
  if (!toolUseId) return null;
  return {
    toolUseId,
    taskId: safeId(head["task-id"]),
    status: (head.status || "").toLowerCase().slice(0, 40),
    subagentTokens: num(Number(usage.subagent_tokens)),
    toolUses: num(Number(usage.tool_uses)),
    durationMs: num(Number(usage.duration_ms))
  };
}

/** Terminal type for a notification status. `known` is false for a status we have not seen. */
function notificationType(status) {
  if (status === "completed") return { type: "done", known: true };
  if (["failed", "error", "killed", "stopped", "cancelled", "canceled"].includes(status)) {
    return { type: "error", known: true };
  }
  return { type: "turn", known: false };
}

function usageRow(role, family, d) {
  return {
    model: family || roleToModel(role),
    role,
    in: d.in,
    out: d.out,
    cacheRead: d.cacheRead,
    cacheWrite: d.cacheWrite
  };
}

/** Link a child to its Agent call: meta first, then the parent's Agent result by agentId. */
function callForChild(state, obj, meta) {
  const id = (meta && meta.toolUseId) || (isObj(obj) && state.agents.get(str(obj.agentId))) || "";
  return id ? { toolUseId: id, call: state.calls.get(id) || null } : { toolUseId: "", call: null };
}

function notificationText(obj) {
  if (obj.type === "queue-operation") return str(obj.content);
  if (isObj(obj.attachment)) return str(obj.attachment.prompt);
  return "";
}

/** Strip invisible and bidi characters from every string in a finished row (ids and model
    strings included), so no field added later can reach a label unsanitized. Rows carry the
    stripped ids; `state` keeps the raw ones, so match on row ids, never on raw transcript ids. */
function cleanRow(v) {
  if (typeof v === "string") return v.replace(INVISIBLE, "");
  if (Array.isArray(v)) return v.map(cleanRow);
  if (!isObj(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) out[k] = cleanRow(v[k]);
  return out;
}

/**
 * Turn one parsed Claude Code line into dashboard rows. Never throws; unknown or bad
 * input returns []. Cut-off tail lines never reach here (they fail JSON.parse upstream).
 * @param {unknown} obj one parsed JSONL line
 * @param {ReturnType<typeof createState>} state caller-owned memory
 * @param {{source?:string, meta?:unknown}} [opts] `source` = file basename; `meta` = the
 *   sibling `agent-*.meta.json` of a subagent file
 * @returns {object[]} rows
 */
function parseLine(obj, state, opts) {
  try {
    return parseLineUnsafe(obj, state, opts || {}).map(cleanRow);
  } catch (_) {
    return [];
  }
}

function parseLineUnsafe(obj, state, opts) {
  if (!isObj(obj) || !isObj(state)) return [];
  const source = str(opts.source);
  const meta = parseMeta(opts.meta);
  const sessionId = str(obj.sessionId);
  const base = () => ({ ts: transcriptTimestamp(obj), sessionId, source });

  /* Completion arrives as a task-notification in a carrier line. The same notification
     shows up on enqueue, on remove and as a queued_command attachment: emit it once. */
  const noteText = notificationText(obj);
  if (noteText) {
    const note = parseTaskNotification(noteText);
    if (!note) return [];
    const key = JSON.stringify([
      note.toolUseId,
      note.status,
      note.subagentTokens,
      note.toolUses,
      note.durationMs
    ]);
    if (state.notified.has(key)) return [];
    state.notified.add(key);
    const call = state.calls.get(note.toolUseId) || null;
    let role = "worker";
    if (call) {
      /* Same order as every other row: remembered own model, resolvedModel, call, meta. */
      const keys = [toolKey(note.toolUseId), agentKey(call.agentId || note.taskId)];
      rememberModel(state, keys, call.modelRaw, RANK.call);
      rememberModel(state, keys, call.resolvedModel, RANK.resolved);
      role = resolveRole(call.subagentType, recallModel(state, keys) || callModel(call, null));
    }
    const { type, known } = notificationType(note.status);
    return [
      {
        ...base(),
        role,
        kind: "status",
        type,
        message: roleLabel(role) + " finished · " + (known ? note.status : "unknown"),
        active: [cardFor(role)],
        tokensDelta: 0,
        usage: null,
        agentId: (call && call.agentId) || note.taskId,
        toolUseId: note.toolUseId,
        statusKnown: known,
        subagentTokens: note.subagentTokens,
        toolUses: note.toolUses,
        durationMs: note.durationMs
      }
    ];
  }

  if (obj.type !== "user" && obj.type !== "assistant") return [];
  const msg = isObj(obj.message) ? obj.message : null;
  if (!msg) return [];
  const content = Array.isArray(msg.content) ? msg.content : null;
  const isChild = obj.isSidechain === true || !!meta;
  const agentId = str(obj.agentId);
  const link = isChild ? callForChild(state, obj, meta) : { toolUseId: "", call: null };
  const msgFamily = modelFamily(msg.model);
  /* Remember the first model family seen for this child (see rememberModel), then fall
     back to it when no live source names one, so later rows and the done notice agree. */
  const keys = isChild ? [toolKey(link.toolUseId), agentKey(agentId)] : [];
  if (isChild) {
    rememberModel(state, keys, str(msg.model), RANK.own);
    rememberModel(state, keys, meta && meta.model, RANK.meta);
    if (link.call) {
      rememberModel(state, keys, link.call.modelRaw, RANK.call);
      rememberModel(state, keys, link.call.resolvedModel, RANK.resolved);
    }
  }
  const childModel = recallModel(state, keys) || callModel(link.call, meta);
  const role = !isChild
    ? "parent"
    : resolveRole(
        (meta && meta.agentType) || (link.call && link.call.subagentType),
        msgFamily ? str(msg.model) : childModel
      );
  const where = () => ({
    role,
    active: [cardFor(role)],
    agentId: isChild ? agentId : "",
    toolUseId: link.toolUseId
  });

  if (obj.type === "user") {
    /* Agent result: remember which child file belongs to which Agent call. */
    if (isObj(obj.toolUseResult) && str(obj.toolUseResult.agentId) && content) {
      const res = content.find((b) => isObj(b) && b.type === "tool_result");
      const call = res && state.calls.get(str(res.tool_use_id));
      if (call) {
        call.agentId = str(obj.toolUseResult.agentId);
        const resolved = str(obj.toolUseResult.resolvedModel);
        if (resolved && !isModelPlaceholder(resolved)) call.resolvedModel = resolved;
        state.agents.set(call.agentId, str(res.tool_use_id));
        const k = [toolKey(str(res.tool_use_id)), agentKey(call.agentId)];
        rememberModel(state, k, call.modelRaw, RANK.call);
        rememberModel(state, k, call.resolvedModel, RANK.resolved);
      }
      return [];
    }
    if (content && content.some((b) => isObj(b) && b.type === "tool_result")) return [];

    if (!isChild) {
      return [
        {
          ...base(),
          ...where(),
          kind: "message",
          type: "turn",
          message: "task / turn",
          tokensDelta: 0,
          usage: null
        }
      ];
    }
    /* First user line of a child file is its spawn; the prompt is not copied. It is emitted
       before any assistant line, so no child model is known yet: when neither the parent's
       Agent call/result nor meta names one, an unrecognized type falls back to worker.
       Accepted: the caller feeds the parent file before child files (unit 5), so the call
       is normally known; later rows and the done notice use the child's own model. */
    const key = agentId || link.toolUseId;
    if (!key || state.spawned.has(key) || obj.parentUuid) return [];
    state.spawned.add(key);
    return [
      {
        ...base(),
        ...where(),
        kind: "delegates",
        type: "spawn",
        message: "spawned · " + roleLabel(role),
        route: "delegates",
        routeTo: cardFor(role),
        tokensDelta: 0,
        usage: null,
        modelRaw: modelFamily(childModel) ? modelInfoFromSlug(childModel).slug : null,
        modelLabel: labelFor(childModel) || null,
        parentToolUseId: link.toolUseId
      }
    ];
  }

  /* assistant */
  const delta = usageDelta(state, msg);
  const family = msgFamily || modelFamily(childModel);
  if (delta) addTotals(state, family || "unknown", delta);
  let usage = delta ? usageRow(role, family, delta) : null;
  const take = () => {
    const u = usage;
    usage = null;
    return u;
  };
  const rows = [];
  for (const b of content || []) {
    if (!isObj(b)) continue;
    if (b.type === "tool_use") {
      const name = str(b.name);
      const input = isObj(b.input) ? b.input : {};
      if (name === "Agent") {
        const subagentType = displayText(input.subagent_type, 40);
        const modelRaw = str(input.model);
        const id = str(b.id);
        if (id) {
          state.calls.set(id, {
            subagentType,
            modelRaw,
            resolvedModel: "",
            agentId: "",
            description: ""
          });
        }
        const childRole = resolveRole(subagentType, modelRaw);
        const info = modelInfoFromSlug(isModelPlaceholder(modelRaw) ? "" : modelRaw);
        rows.push({
          ...base(),
          ...where(),
          kind: "delegates",
          type: "spawn",
          message:
            "delegates · " +
            (subagentType || childRole) +
            (labelFor(modelRaw) ? " · " + labelFor(modelRaw) : ""),
          active: [cardFor(childRole)],
          route: "delegates",
          routeTo: cardFor(childRole),
          childRole,
          tokensDelta: 0,
          usage: take(),
          modelRaw: modelFamily(modelRaw) ? info.slug : null,
          modelLabel: labelFor(modelRaw) || null,
          toolUseId: id
        });
        continue;
      }
      const tool = {
        name: name === "Bash" ? "Shell" : name === "NotebookEdit" ? "EditNotebook" : name,
        input: safeToolInput(input)
      };
      /* Keep the kind and path only: commands, patterns and queries can carry secrets. */
      const found = toolActivity(tool);
      const activity = found ? { kind: found.kind, path: found.path, detail: "" } : null;
      rows.push({
        ...base(),
        ...where(),
        kind: "status",
        type: "turn",
        message: activity
          ? activity.kind + " · " + displayText(activity.path || name, 72)
          : "tool · " + displayText(name, 60),
        tokensDelta: 0,
        usage: take(),
        ...(activity ? { activity } : {})
      });
    } else if (b.type === "text") {
      rows.push({
        ...base(),
        ...where(),
        kind: "message",
        type: "turn",
        message: "reply",
        tokensDelta: 0,
        usage: take()
      });
    } else if (b.type === "thinking") {
      rows.push({
        ...base(),
        ...where(),
        kind: "status",
        type: "turn",
        message: "thinking",
        tokensDelta: 0,
        usage: take()
      });
    }
  }
  if (!rows.length && usage) {
    rows.push({
      ...base(),
      ...where(),
      kind: "status",
      type: "turn",
      message: "working",
      tokensDelta: 0,
      usage: take()
    });
  }
  return rows;
}

/**
 * Parse one raw JSONL line. Returns null for blank, cut-off or non-object lines.
 * @param {string} text
 * @returns {object|null}
 */
function parseJsonLine(text) {
  const s = str(text).trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ROLES,
  nowIso,
  createState,
  parseJsonLine,
  parseMeta,
  parseLine,
  parseTaskNotification,
  notificationType,
  resolveRole,
  modelFamily,
  usageTotals
};
