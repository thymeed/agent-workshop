/**
 * Claude Code rows -> bridge events, alerts and model slots. Pure: no fs, no network, no
 * event-log (Claude Code events must never reach the Cursor history). live-bridge.js owns the
 * sequencing (ids, SSE, the alert ring); this module only decides what each row becomes.
 *
 * Privacy: parser rows are path-free except for tool file paths (`read · C:\Users\x\a.js`),
 * so the wire cuts any absolute path down to its file name and any id to a plain token before
 * a row can leave the process.
 */
"use strict";

const { PARSER_ROLE_TO_SLOT } = require("./claude-code-slots");
const { resolveModelAlias } = require("./claude-code-models");

const SLOTS = ["opus", "advisor", "worker", "explorer", "researcher"];
const ROLE_LABEL = {
  parent: "Lead",
  planner: "Planner",
  researcher: "Researcher",
  worker: "Worker",
  reviewer: "Reviewer"
};

/** Same shape the parser keeps for ids it takes from a notice: 1-64 of A-Z a-z 0-9 _ - */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const safeId = (v) => (typeof v === "string" && SAFE_ID.test(v) ? v : "");

/**
 * Parser role name -> slot key (the parser's own names: researcher is the explorer slot and
 * reviewer is the researcher slot). "opus" and "parent" are the Lead card; anything unknown
 * falls back to it. Slot keys are never passed in, so no name is read two ways.
 */
function slotOf(name) {
  if (name === "opus" || name === "parent") return "opus";
  return Object.prototype.hasOwnProperty.call(PARSER_ROLE_TO_SLOT, name)
    ? PARSER_ROLE_TO_SLOT[name]
    : "opus";
}

/** Event `role` for a slot: the Lead card is "parent" in every event. */
const eventRole = (slot) => (slot === "opus" ? "parent" : slot);

const BACKSLASH = String.fromCharCode(92);
const SEPARATORS = new RegExp("[" + BACKSLASH + BACKSLASH + "/]+");
const ABSOLUTE = new RegExp("^(?:[A-Za-z]:|" + BACKSLASH + BACKSLASH + "|/|~)");
const URL_HEAD = new RegExp("^https?://", "i");
/* Quotes, brackets and other punctuation the parser keeps in front of a path. */
const LEAD_PUNCT = new RegExp("^[^A-Za-z0-9/~." + BACKSLASH + BACKSLASH + "]+");
/* Closing quotes and brackets left on a cut file name. */
const TRAIL_PUNCT = new RegExp("[\"')>" + BACKSLASH + "]]+$");
/* A home-style folder (home, Users, root, mnt) followed by more path, anywhere in the value. */
const HOME_SEG = new RegExp(
  "(?:^|[" + BACKSLASH + BACKSLASH + "/])(?:home|users|root|mnt)[" + BACKSLASH + BACKSLASH + "/]",
  "i"
);

/* Folders whose NEXT segment is a user name (the home folder's parent). */
const USER_PARENT = ["home", "users", "documents and settings"];
/* Folders that are themselves a home (or the place homes live), so nothing follows them. */
const HOME_NAMES = ["home", "users", "root", "mnt", "documents and settings"];

const PERCENT_RUN = new RegExp("(?:%[0-9a-f]{2})+", "gi");
const PERCENT_SEP = new RegExp("%(?:2f|5c)", "gi");
const DECODE_ROUNDS = 4;

/**
 * Percent-decode a path, each escape run on its own (one invalid escape elsewhere must not stop
 * the rest), repeated to a small bound for multiple encodings. An escape that still stands for
 * a slash or a backslash after that is turned into a separator, so it cannot hide a folder.
 */
function decodeText(text) {
  let out = text;
  for (let i = 0; i < DECODE_ROUNDS; i++) {
    const next = out.replace(PERCENT_RUN, (m) => {
      try {
        return decodeURIComponent(m);
      } catch (_e) {
        return m;
      }
    });
    if (next === out) break;
    out = next;
  }
  return out.replace(PERCENT_SEP, "/");
}

const FILE_URI = new RegExp("^file:(?://(?:localhost)?)?", "i");
const DRIVE = new RegExp("^[A-Za-z]:");
const SLASH_DRIVE = new RegExp("^/(?=[A-Za-z]:)");
const SHORT_DOCS = new RegExp("^docume~[0-9]+$", "i");
/** Lower-case folder name for the home checks; the 8.3 form DOCUME~1 is "documents and settings". */
const canon = (seg) => (SHORT_DOCS.test(seg) ? "documents and settings" : seg.toLowerCase());

/**
 * "." and ".." resolved. An absolute path never climbs above its root; a relative one keeps the
 * leading ".." it cannot resolve. `climbed` says a ".." was seen at all.
 */
function resolveDots(parts, absolute) {
  const out = [];
  let climbed = false;
  for (const seg of parts) {
    if (seg === ".") continue;
    if (seg !== "..") {
      out.push(seg);
      continue;
    }
    climbed = true;
    if (out.length && out[out.length - 1] !== "..") out.pop();
    else if (!absolute) out.push("..");
  }
  return { parts: out, climbed };
}

/**
 * A tool path for display: relative paths and http(s) URLs stay (a URL is never judged as a
 * file path, so https://example.com/home/alice stays whole). Everything else is first
 * normalized: percent-decoded, a file: URI (file://, file://localhost, file:/, any case) turned
 * into its path, a drive-relative C:Users/alice read as rooted, "." and ".." resolved. An
 * absolute path, one that used "..", or one with a home-style folder in it is cut to its last
 * segment (the file name). When the path is absolute or climbs out with a leading "..", one that
 * ends at a home folder, or one segment below it (the user name, also as 8.3 DOCUME~1/ALICE~1),
 * shows "~" instead of the name; a leading ~name counts as a home folder too. A plain relative
 * path keeps its file name (src/home/page.js shows page.js).
 */
function safePathText(p) {
  const s = typeof p === "string" ? p : "";
  let lead = decodeText(s).replace(LEAD_PUNCT, "");
  if (!s || URL_HEAD.test(lead)) return s;
  const fileUri = FILE_URI.test(lead);
  if (fileUri) lead = lead.replace(FILE_URI, "").replace(SLASH_DRIVE, "");
  const driveRooted = DRIVE.test(lead);
  if (driveRooted) lead = lead.slice(2);
  const absolute = fileUri || driveRooted || ABSOLUTE.test(lead);
  const norm = resolveDots(lead.split(SEPARATORS).filter(Boolean), absolute);
  const parts = norm.parts;
  const homeJudged = absolute || parts[0] === "..";
  if (absolute || norm.climbed || HOME_SEG.test(parts.join("/") + "/")) {
    if (!parts.length) return "";
    const last = parts[parts.length - 1].replace(TRAIL_PUNCT, "");
    if (homeJudged) {
      const prev = parts.length > 1 ? canon(parts[parts.length - 2]) : "";
      if (last.startsWith("~") || HOME_NAMES.includes(canon(last)) || USER_PARENT.includes(prev))
        return "~";
    }
    return last;
  }
  return s;
}

/* An absolute path run inside free label text (a delegation type, a model label): a drive
   (not the "s:/" of "https://"), a UNC or backslash start, or a rooted home-style folder. */
const PATH_RUN = new RegExp(
  "(?:(?<![A-Za-z])[A-Za-z]:[" +
    BACKSLASH +
    BACKSLASH +
    "/]|" +
    BACKSLASH +
    BACKSLASH +
    "|(?<![A-Za-z0-9._~-])/(?:home|users|root|mnt)/)" +
    BACKSLASH +
    "S*",
  "gi"
);
const PATH_RUN2 = new RegExp(
  "(?:(?<![A-Za-z0-9:._~/-])(?://|~/)|(?<![A-Za-z0-9:._~/-])/[^/" +
    BACKSLASH +
    "s]+/)" +
    BACKSLASH +
    "S*",
  "g"
);
const scrubText = (s) =>
  typeof s === "string" ? s.replace(PATH_RUN, "[path]").replace(PATH_RUN2, "[path]") : s;
/** A model id or label that has a home-style folder in it is dropped, never shown. */
const modelText = (s) => (typeof s === "string" && HOME_SEG.test(s) ? "" : scrubText(s));

/** Local HH:MM:SS of an ISO time (what Cursor events show as `ts`). */
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

const OPTIONAL_NUMBERS = ["subagentTokens", "toolUses", "durationMs"];

/**
 * One parser row -> the event fields live-bridge.js pushes. Roles, `active`, `routeTo`,
 * `childRole` and `usage.role` are mapped to slot keys, the keys the dashboard cards know.
 * @param {Record<string, any>} row
 */
function eventFromRow(row) {
  const slot = slotOf(row.role);
  const ev = {
    iso: typeof row.ts === "string" ? row.ts : "",
    ts: clockOf(row.ts),
    role: eventRole(slot),
    kind: row.kind || "status",
    type: row.type || "",
    message: scrubText(String(row.message || "")),
    active: Array.isArray(row.active) ? row.active.map(slotOf) : [],
    route: row.route || null,
    routeTo: row.routeTo ? slotOf(row.routeTo) : null,
    tokensDelta: 0,
    usage: null,
    modelRaw: row.modelRaw ? modelText(String(row.modelRaw)) || null : null,
    modelLabel: row.modelLabel ? modelText(String(row.modelLabel)) || null : null,
    activity: null,
    source:
      typeof row.source === "string" && /^(session|subagent:\d{1,6})$/.test(row.source)
        ? row.source
        : "session",
    agentId: safeId(row.agentId),
    toolUseId: safeId(row.toolUseId)
  };
  if (row.usage && typeof row.usage === "object") {
    ev.usage = {
      model: modelText(String(row.usage.model || "")),
      role: eventRole(slotOf(row.usage.role)),
      in: Number(row.usage.in) || 0,
      out: Number(row.usage.out) || 0,
      cacheRead: Number(row.usage.cacheRead) || 0,
      cacheWrite: Number(row.usage.cacheWrite) || 0
    };
  }
  if (row.activity && typeof row.activity === "object") {
    const clean = safePathText(String(row.activity.path || ""));
    ev.activity = {
      kind: String(row.activity.kind || ""),
      path: scrubText(clean),
      detail: scrubText(String(row.activity.detail || ""))
    };
    if (clean !== String(row.activity.path || "")) {
      // the parser put the full path in the message: rebuild it from the cleaned one
      ev.message = scrubText(ev.activity.kind + " · " + (clean || "tool"));
    }
  }
  if (typeof row.statusKnown === "boolean") ev.statusKnown = row.statusKnown;
  if (row.failed === true && ev.type === "error") ev.failed = true;
  for (const k of OPTIONAL_NUMBERS) {
    if (typeof row[k] === "number" && Number.isFinite(row[k])) ev[k] = row[k];
  }
  if (row.childRole) ev.childRole = slotOf(row.childRole);
  const parentTool = safeId(row.parentToolUseId);
  if (parentTool) ev.parentToolUseId = parentTool;
  return ev;
}

/**
 * A finish or error alert for a row, or null. Name is the role label of the PARSER role,
 * which the parser already resolved (a type outside the five roles went by its model), so
 * roleFromAgentHint({name}) finds the right card under the claude-code profile.
 * @returns {{name:string, status:"finished"|"error", agentId:string}|null}
 */
function alertFromRow(row) {
  if (!row || row.kind !== "status") return null;
  if (row.type !== "done" && row.type !== "error") return null;
  const role = Object.prototype.hasOwnProperty.call(ROLE_LABEL, row.role) ? row.role : "worker";
  return {
    name: ROLE_LABEL[role],
    status: row.type === "done" ? "finished" : "error",
    agentId: safeId(row.agentId)
  };
}

/**
 * Slot -> full model id from the models the ingest read. A bare alias becomes the latest full
 * id, "inherit" becomes the Lead's own model, anything unknown or unsafe is "" (unset). Always
 * all five slots, so a clear reaches the dashboard. Ids only ever reach text, never a path.
 * @param {{own?:Record<string,string>, declared?:Record<string,string>}} m
 * @returns {Record<string,string>}
 */
function resolveSlotModels(m) {
  const own = (m && m.own) || {};
  const declared = (m && m.declared) || {};
  const out = Object.fromEntries(SLOTS.map((s) => [s, ""]));
  for (const role of Object.keys(PARSER_ROLE_TO_SLOT)) {
    const has = (o) => Object.prototype.hasOwnProperty.call(o, role) && o[role];
    const value = has(own) ? own[role] : has(declared) ? declared[role] : "";
    const parent = Object.prototype.hasOwnProperty.call(own, "parent") ? own.parent : "";
    const id = value ? resolveModelAlias(value, parent) : "";
    out[PARSER_ROLE_TO_SLOT[role]] = HOME_SEG.test(id) ? "" : id;
  }
  return out;
}

module.exports = {
  SLOTS,
  slotOf,
  safePathText,
  eventFromRow,
  alertFromRow,
  resolveSlotModels,
  clockOf
};
