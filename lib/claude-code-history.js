/**
 * Older Claude Code sessions of ONE project folder, read-only: a list of the newest sessions and
 * the path-free events of one of them (parent file first, then its subagent files, merged by
 * time). It reads Claude's own session files and writes nothing anywhere; it never loads the
 * event log or History.
 *
 * Privacy: events go through lib/claude-code-wire.js (paths cut to file names, ids plain tokens,
 * no prompt or result text). A session id is opaque, an HMAC-SHA256 of the file name with the
 * per-install salt; the server maps it back to the file by listing the folder again, so no path
 * or file name ever comes from the caller. An id that is not in the current listing is refused.
 * Every body is built from numbers, ISO times and fixed strings.
 *
 * Safe-open rules are the ingest's (no links or junctions, handle checks, capped chunked reads,
 * `.jsonl` only, listing caps), plus caps per session: events and bytes. A cap that is hit sets
 * `truncated: true`; it is never silent.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const P = require("./claude-code-parse");
const T = require("./transcript-tail");
const W = require("./claude-code-wire");
const I = require("./claude-code-ingest");

const MAX_SESSIONS = 20; // newest sessions listed
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // sessions older than this are not listed
const MAX_EVENTS = 20000; // events returned for one session
const MAX_SESSION_BYTES = 32 * 1024 * 1024; // bytes read for one session, all its files together
const MAX_CHILDREN = 500; // subagent files read for one session
const FIRST_LINE_BYTES = 64 * 1024; // read to find the start time in the list
const ID_PATTERN = /^cs-[0-9a-f]{24}$/;
const NUL = String.fromCharCode(0);

/** @typedef {{ok: false, status: number, error: string}} Refusal */

/** @returns {Refusal} */
const refuse = (status, error) => ({ ok: false, status, error });

/** Per-session caps; opts.caps lowers them for tests (a value that is not a positive number is ignored). */
function capsOf(opts) {
  const c = (opts && opts.caps) || {};
  const pick = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return {
    maxEvents: pick(c.maxEvents, MAX_EVENTS),
    maxBytes: pick(c.maxBytes, MAX_SESSION_BYTES),
    maxChildren: pick(c.maxChildren, MAX_CHILDREN)
  };
}

function checkSalt(salt) {
  if (!Buffer.isBuffer(salt) || salt.length < 16) throw new Error("history needs the install salt");
  return salt;
}

/** Opaque id of a session file: HMAC-SHA256 (install salt) of project folder and file name. */
function sessionId(salt, projectDir, name) {
  const h = crypto
    .createHmac("sha256", checkSalt(salt))
    .update("claude-session" + NUL + projectDir + NUL + name)
    .digest("hex");
  return "cs-" + h.slice(0, 24);
}

/** A real folder (not a link, not a junction) or null; links are never followed. */
function realDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink() ? st : null;
  } catch (_) {
    return null;
  }
}

/**
 * The sessions to offer, newest first: the newest MAX_SESSIONS, and of those only the ones
 * modified within MAX_AGE_MS (whichever gives FEWER). Regular `.jsonl` files only.
 * @returns {{ok: true, items: {id: string, name: string, mtimeMs: number}[], truncated: boolean}|Refusal}
 */
function findSessions(projectDir, opts) {
  const now = (opts && opts.now) || Date.now;
  const salt = checkSalt(opts && opts.salt);
  const stats = { dirCut: 0 };
  const listed = I.listJsonl(projectDir, stats, { top: true });
  if (listed.error) return refuse(404, "Project folder not readable");
  const found = [];
  for (const name of listed.names) {
    let st;
    try {
      st = I.lstatId(path.join(projectDir, name));
    } catch (_) {
      continue;
    }
    if (!I.isRegular(st)) continue;
    found.push({ name, mtimeMs: st.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const cutoff = now() - MAX_AGE_MS;
  const items = found
    .slice(0, MAX_SESSIONS)
    .filter((f) => f.mtimeMs >= cutoff)
    .map((f) => ({
      id: sessionId(salt, projectDir, f.name),
      name: f.name,
      mtimeMs: f.mtimeMs
    }));
  return { ok: true, items, truncated: stats.dirCut > 0 };
}

/** ISO time of the first line that has one, from the first FIRST_LINE_BYTES of the file; or null. */
function firstTimestamp(filePath) {
  let fd;
  try {
    fd = I.openChecked(filePath, I.lstatId(filePath));
    const buf = I.readHandle(fd, 0, FIRST_LINE_BYTES);
    const lines = buf.toString("utf8").split("\n");
    // the last piece may be cut by the byte limit: skip it unless it is all there is
    const usable = lines.length > 1 ? lines.slice(0, -1) : lines;
    for (const text of usable) {
      /** @type {any} */
      const obj = P.parseJsonLine(text.trim());
      const t = obj && typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  } catch (_) {
    /* unreadable: no start time */
  } finally {
    if (fd !== undefined) I.closeQuiet(fd);
  }
  return null;
}

/** Regular .jsonl children of a session, sorted by name, from real folders only. */
function childFiles(projectDir, sessionName, stats) {
  const base = sessionName.slice(0, -I.JSONL.length);
  const idDir = path.join(projectDir, base);
  const subDir = path.join(idDir, "subagents");
  if (!realDir(idDir) || !realDir(subDir)) return [];
  const listed = I.listJsonl(subDir, stats);
  const out = [];
  for (const name of listed.names) {
    const filePath = path.join(subDir, name);
    let st;
    try {
      st = I.lstatId(filePath);
    } catch (_) {
      continue;
    }
    if (!I.isRegular(st)) continue;
    out.push({
      name,
      filePath,
      st,
      metaPath: path.join(subDir, name.slice(0, -I.JSONL.length) + ".meta.json")
    });
  }
  return out;
}

/**
 * The sessions of a project, newest first.
 * @param {string} projectDir private absolute folder; never returned
 * @param {{salt: Buffer, now?: () => number}} opts
 * @returns {{ok: true, sessions: {id: string, startedAt: string|null, lastAt: string, events: null, subagents: number}[], truncated?: boolean}|Refusal}
 */
function listSessions(projectDir, opts) {
  const found = findSessions(projectDir, opts);
  if (!found.ok) return /** @type {Refusal} */ (found);
  const sessions = found.items.map((it) => {
    const stats = { dirCut: 0 };
    return {
      id: it.id,
      startedAt: firstTimestamp(path.join(projectDir, it.name)),
      lastAt: new Date(it.mtimeMs).toISOString(),
      events: null, // counting events means parsing every file: only loadSession does that
      subagents: childFiles(projectDir, it.name, stats).length
    };
  });
  return found.truncated ? { ok: true, sessions, truncated: true } : { ok: true, sessions };
}

/** The child's meta.json (capped, handle-checked), or null. */
function readMeta(child) {
  let fd;
  try {
    const lst = I.lstatId(child.metaPath);
    if (!I.isRegular(lst)) return null;
    fd = I.openChecked(child.metaPath, lst);
    const buf = I.readHandle(fd, 0, I.MAX_META_BYTES + 1);
    if (buf.length > I.MAX_META_BYTES) return null;
    return P.parseJsonLine(buf.toString("utf8"));
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) I.closeQuiet(fd);
  }
}

/** The line's own valid timestamp as an ISO string, or "" (the parser would invent "now"). */
function ownTimestamp(obj) {
  const m = obj && obj.message && typeof obj.message === "object" ? obj.message.timestamp : null;
  for (const c of [
    obj && obj.timestamp,
    obj && obj.ts,
    obj && obj.createdAt,
    obj && obj.created_at,
    m
  ]) {
    if (c != null && !Number.isNaN(Date.parse(String(c)))) return new Date(c).toISOString();
  }
  return "";
}

/**
 * Read one file to its end (or to a cap) and push its events.
 * `run` carries the shared state: {state, bytesLeft, items, truncated, unparsed, oversize}.
 * Returns false when the file could not be read.
 */
function readFileEvents(file, label, meta, run) {
  let fd;
  try {
    fd = I.openChecked(file.filePath, file.st);
  } catch (_) {
    return false;
  }
  /* A line with no timestamp of its own takes the previous row's time (the file's own
     modification time before any row has one), never the load time. */
  let lastT = 0;
  let lastIso = "";
  const take = (trimmed) => {
    if (!trimmed) return;
    const obj = P.parseJsonLine(trimmed);
    if (!obj) {
      run.unparsed += 1;
      return;
    }
    const own = ownTimestamp(obj);
    if (own) {
      lastIso = own;
      lastT = Date.parse(own);
    } else if (!lastIso) {
      lastT = file.st.mtimeMs;
      lastIso = new Date(lastT).toISOString();
    }
    for (const row of P.parseLine(obj, run.state, { source: label, meta: meta || undefined })) {
      if (run.items.length >= run.maxEvents) {
        run.truncated = true;
        return;
      }
      const ev = W.eventFromRow({ ...row, ts: lastIso });
      run.items.push({ ev: { ...ev, replay: true }, t: lastT });
    }
  };
  try {
    const size = file.st.size;
    let pos = 0;
    while (pos < size) {
      if (run.bytesLeft <= 0 || run.items.length >= run.maxEvents) {
        run.truncated = true;
        break;
      }
      const len = Math.min(size - pos, T.TRANSCRIPT_READ_MAX_PER_POLL, run.bytesLeft);
      const buf = I.readHandle(fd, pos, len);
      if (!buf.length) break;
      const atEnd = pos + buf.length >= size;
      const end = T.completeLinesEndExclusive(buf);
      if (end < 0) {
        if (atEnd) {
          take(buf.toString("utf8").trim()); // the last line has no newline
          run.bytesLeft -= buf.length;
          break;
        }
        if (buf.length === T.TRANSCRIPT_READ_MAX_PER_POLL) {
          // one line longer than a chunk: skip it, count it
          const limit = Math.min(size, pos + run.bytesLeft);
          const next = I.nextNewlineOffset(fd, pos + buf.length, limit);
          run.oversize += 1;
          if (next < 0) {
            if (limit < size) run.truncated = true; // the byte budget ended inside the line
            break;
          }
          run.bytesLeft -= next - pos;
          pos = next;
          continue;
        }
        run.truncated = true; // the byte budget ended inside a line
        break;
      }
      T.forEachCompleteLine(buf.subarray(0, end), 0, (_at, trimmed) => take(trimmed));
      run.bytesLeft -= end;
      pos += end;
      if (atEnd && end < buf.length) {
        take(buf.subarray(end).toString("utf8").trim());
        break;
      }
    }
    return true;
  } catch (_) {
    return false;
  } finally {
    I.closeQuiet(fd);
  }
}

/**
 * The events of one listed session. `id` must be one `listSessions` / `findSessions` offers now.
 * @param {string} projectDir private absolute folder; never returned
 * @param {unknown} id opaque session id from the caller
 * @param {{salt: Buffer, now?: () => number, caps?: {maxEvents?: number, maxBytes?: number, maxChildren?: number}}} opts
 * @returns {{ok: true, id: string, events: Record<string, any>[], agents: {key: string, role: string, parentToolUseId: string}[], truncated: boolean, counts: {events: number, files: number, bytesRead: number, unparsed: number, oversize: number, unreadableFiles: number}}|Refusal}
 */
function loadSession(projectDir, id, opts) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return refuse(400, "Unknown session");
  const found = findSessions(projectDir, opts);
  if (!found.ok) return /** @type {Refusal} */ (found);
  const item = found.items.find((it) => it.id === id);
  if (!item) return refuse(400, "Unknown session");

  const caps = capsOf(opts);
  const run = {
    state: P.createState(),
    maxEvents: caps.maxEvents,
    maxBytes: caps.maxBytes,
    bytesLeft: caps.maxBytes,
    /** @type {{ev: Record<string, any>, t: number}[]} */
    items: [],
    truncated: found.truncated,
    unparsed: 0,
    oversize: 0
  };
  const parentPath = path.join(projectDir, item.name);
  let parentSt;
  try {
    parentSt = I.lstatId(parentPath);
  } catch (_) {
    return refuse(404, "Session not readable");
  }
  if (!I.isRegular(parentSt)) return refuse(404, "Session not readable");
  if (!readFileEvents({ filePath: parentPath, st: parentSt }, "session", null, run)) {
    return refuse(500, "Session not readable");
  }

  // Children after the parent: its Agent calls and results are known by then.
  const stats = { dirCut: 0 };
  let children = childFiles(projectDir, item.name, stats);
  if (stats.dirCut > 0 || children.length > caps.maxChildren) run.truncated = true;
  children = children.slice(0, caps.maxChildren);
  let unreadableFiles = 0;
  children.forEach((child, i) => {
    const label = "subagent:" + (i + 1);
    if (!readFileEvents(child, label, readMeta(child), run)) unreadableFiles += 1;
  });

  // sort is stable: equal times keep the push order, the parent first, then children by name
  run.items.sort((a, b) => a.t - b.t);
  /** @type {Record<string, any>[]} */
  const events = run.items.map((it, i) => ({ ...it.ev, id: i + 1 }));
  /** @type {Map<string, {key: string, role: string, parentToolUseId: string}>} */
  const agents = new Map();
  for (const ev of events) {
    if (ev.source === "session") continue;
    let a = agents.get(ev.source);
    if (!a) {
      a = { key: ev.source, role: ev.role, parentToolUseId: "" };
      agents.set(ev.source, a);
    }
    if (!a.parentToolUseId && ev.parentToolUseId) a.parentToolUseId = ev.parentToolUseId;
  }
  return {
    ok: true,
    id,
    events,
    agents: [...agents.values()],
    truncated: run.truncated,
    counts: {
      events: events.length,
      files: 1 + children.length,
      bytesRead: run.maxBytes - run.bytesLeft,
      unparsed: run.unparsed,
      oversize: run.oversize,
      unreadableFiles
    }
  };
}

module.exports = {
  listSessions,
  loadSession,
  findSessions,
  sessionId,
  MAX_SESSIONS,
  MAX_AGE_MS,
  MAX_EVENTS,
  MAX_SESSION_BYTES,
  MAX_CHILDREN
};
