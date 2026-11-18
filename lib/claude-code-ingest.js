/**
 * Claude Code session tailing: turns the newest session of ONE selected project folder into
 * path-free parser rows, incrementally. Pure fs + lib/claude-code-parse.js; it never writes
 * anything and never loads event-log.js, so Claude Code events cannot reach the Cursor
 * history. The project path stays inside this module (only readdir names are appended to it).
 *
 * Layout: <projectDir>/<sessionId>.jsonl (parent), <projectDir>/<sessionId>/subagents/*.jsonl
 * with a sibling <name>.meta.json. Feed order is the parent first, then children by name. The
 * children are listed BEFORE the parent's size is taken, so every child seen in a poll existed
 * before the parent bytes read in that poll. No child is fed in a poll where the parent feed
 * failed (open, identity or read error) or the parent still has capped, unread bytes
 * (stats().more is true).
 *
 * CHILD HOLD: a child whose meta names a toolUseId is not fed until the parent's Agent call
 * for that id has an Agent RESULT with an agentId (so its spawn row can name the right
 * model). The wait is counted in polls (HOLD_CHILD_POLLS, injectable as holdChildPolls), not
 * time, starting once the meta is read; after that many held polls the child is fed with the
 * parser's fallback. A child with no meta or no toolUseId is never held. Held children do not
 * block the parent or other children; stats().heldChildren counts them (no ids), and more
 * stays true while any child is held. stats().capped is true only while capped unread bytes
 * remain (a caller may re-poll at once for those; a meta wait or child hold counts polls and
 * must not be spun through, so it is not capped).
 *
 * PER-POLL FACTS (stats(), flags and counts only, reset at the start of every poll): the caller
 * never infers "caught up" from totals, it reads these.
 *   parentRead   this poll read the CURRENT session's parent file to its end without error (the
 *                lstat, open, identity check and read all worked and no capped bytes remain). A
 *                failed read, a vanished parent, no session, or a capped parent leave it false.
 *   capped       unread bytes remain because of the per-poll read cap (any file).
 *   waiting      a poll-counted wait is pending: a meta wait, a child hold, or a newer session
 *                holding for its HOLD_POLLS. metaWaiting counts the files in a meta wait and
 *                heldChildren the held children.
 *                Also pending, for at most FAULT_WAIT_POLLS regular polls per key: a transient
 *                lstat/open/read failure of a child not yet read to its end, or of the subagents folder
 *                check or listing (so its old history is not read later as new).
 *   more         capped, or a meta wait / child hold is pending (unchanged).
 * A caller has seen a session to its end only after a poll with parentRead true, capped false and
 * waiting false (and more false).
 *
 * poll({catchUp:true}) is a re-poll inside one scan (the caller loops while capped). It reads
 * what the regular poll could not, but advances NO poll-counted wait: not the meta wait, the
 * child hold, the session hold (HOLD_POLLS) nor the idle counters. Those advance only on the
 * regular poll, once per scan, so a big file cannot burn through another file's wait.
 *
 * Row `source` values are opaque and path-free: `session` for the parent, `subagent:<n>` for
 * children, numbered by first-seen order (a later child is appended, nothing is renumbered).
 * The real base names stay in this module; describeFile(label) returns one for debugging.
 *
 * SESSION SWITCH / CLEAR-AND-REPLAY SIGNAL: stats().sessions is the signal. When it changes,
 * the rows that follow replay a session from its start, so the caller (U6b) must CLEAR its
 * stage state first or counts double up. It changes when: a newer file won the hold; the
 * current file vanished and the newest was picked at once (no hold); a file shrank (rotation,
 * truncation); or a name now holds a different file (see "Replaced file").
 *
 * Replaced file: decided by platform, not by whether an id looks usable. Windows on a local
 * drive: the creation time counts, and a nonzero dev/ino that differs counts too (NTFS keeps
 * the creation time of a file replaced within seconds, but not its id). Windows on a WSL
 * share (\\wsl$\ or \\wsl.localhost\) and POSIX: dev/ino when reported, creation time unused.
 * Creation time is unusable there: through a WSL share it is always the Linux MODIFICATION
 * time (measured 2026-11-16: 44 of 45 transcripts), so every append would look like a replaced
 * file and reset the session. Its ids, by contrast, are stable (the share reports dev as 0, so
 * the inode alone carries identity there). The shrink check runs on every
 * platform and needs neither. Known limit: a larger replacement that shows the same ids cannot
 * be told apart.
 *
 * Meta files: a missing, busy, empty or half-written meta is retried on the next poll (never a
 * sleep) for META_WAIT_POLLS polls, then the child runs without it. When the wait runs out the
 * problem is counted once (drift.unreadable for a transient error, drift.metaBad for empty or
 * unparseable content); a meta file that simply does not exist is not counted. A meta over
 * MAX_META_BYTES, or a link, is refused at once.
 *
 * Top-level scan: names are filtered to lowercase .jsonl FIRST, then every candidate is
 * lstat'ed and the newest by mtime wins (name order only breaks ties), so a random session id
 * can never fall outside a name-order cut. Only a pathological folder with more than
 * MAX_SCAN_CANDIDATES (20000) such files is cut, in name order, and counted in drift.dirCut,
 * so a huge folder cannot hang the main process.
 *
 * Scan cache: the newest top-level session is cached. With no session known the folder is
 * listed on every poll (a folder mtime is unreliable on Windows and OneDrive); with one it is
 * re-listed only when its mtime changed, the listing is racy (taken within RACY_MS of the folder
 * mtime, so a coarse mtime could hide a new file), 30 s passed (RESCAN_MS backstop), or the cached file is gone; every poll
 * still stats the cached file. A newer session must stay newest for HOLD_POLLS consecutive
 * polls before the switch (the first selection is immediate). The subagents listing is cached
 * the same way. An append to a child does not change the folder mtime, so children are
 * lstat'ed every poll, except an IDLE child (no unread bytes for IDLE_AFTER
 * checks), which is lstat'ed only every IDLE_EVERY-th poll, staggered by child. An old child
 * that wakes up is noticed within IDLE_EVERY polls, which is IDLE_EVERY x the bridge poll
 * interval (live-bridge.js POLL_MS = 900 ms, so about 9 s), and any growth puts it back on
 * every-poll checks.
 *
 * Reads: every file is opened with O_NOFOLLOW where the platform has it (POSIX only; Windows
 * has no such flag), then the OPEN handle is fstat'ed: a regular file, and dev/ino equal (as
 * exact BigInt, NTFS ids exceed 2^53) to the lstat of the same name unless a side reports both
 * as 0. So on Windows the link defence is the lstat checks plus that compare on the open
 * handle. A mismatch skips the file and counts `unreadable`. Meta reads are cut at
 * MAX_META_BYTES + 1 bytes actually read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const P = require("./claude-code-parse");
const T = require("./transcript-tail");

/**
 * @typedef {object} FileEntry one tracked transcript file (the parent or a child)
 * @property {number} offset bytes already read
 * @property {boolean} seenEnd a successful read has reached the end of the file at least once
 * @property {any} meta parsed sibling meta.json, or null
 * @property {boolean} metaDone
 * @property {number} metaWait polls spent waiting for the meta
 * @property {number} heldPolls polls held for the parent's Agent result
 * @property {any} lastSt the last lstat taken of a child
 * @property {number} idle consecutive checks that found the child fully read
 * @property {number} skipped polls since the last real lstat of an idle child
 * @property {number} ord first-seen number of a child
 * @property {any} [ident] dev/ino/creation time first seen
 * @property {string} [label] the row source label
 */

const MAX_DIR_ENTRIES = 2000; // entries checked per subagents listing, in name order
const MAX_SCAN_CANDIDATES = 20000; // .jsonl files lstat'ed in one top-level scan (safety cap)
const HOLD_CHILD_POLLS = 6; // polls a child waits for its parent's Agent result
const MAX_META_BYTES = 64 * 1024;
const META_WAIT_POLLS = 2; // polls a new child waits for its meta file before running without
const FAULT_WAIT_POLLS = 3; // regular polls a first-read failure of a child or folder holds the live phase
const HOLD_POLLS = 5; // consecutive polls a newer session must lead before the switch
const RESCAN_MS = 30000; // backstop between top-level folder listings
const RACY_MS = 2500; // a folder listing taken this soon after the folder mtime is not trusted (coarse mtime)
const IDLE_AFTER = 10; // polls a fully read child must stay unchanged before it counts as idle
const IDLE_EVERY = 10; // an idle child is lstat'ed only on every IDLE_EVERY-th poll
const JSONL = ".jsonl";
const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

/**
 * lstat with BigInt dev/ino (NTFS file ids exceed 2^53, so Number inode compares can be blind to
 * a change), returned as a plain stat with Number size/mtimeMs and the exact dev/ino.
 */
function lstatId(p) {
  const b = fs.lstatSync(p, { bigint: true });
  return {
    isFile: () => b.isFile(),
    isSymbolicLink: () => b.isSymbolicLink(),
    size: Number(b.size),
    mtimeMs: Number(b.mtimeMs),
    birthtimeMs: Number(b.birthtimeMs),
    dev: b.dev,
    ino: b.ino
  };
}

/** Both dev and ino are 0: the platform gives no identity, so the compare cannot be used. */
const noIdentity = (st) => !st || (!st.dev && !st.ino);

/** A Windows path to a WSL distro share: \\wsl$\... or \\wsl.localhost\... (either slash). */
const WSL_SHARE = /^[\\/]{2}wsl(\$|\.localhost)[\\/]/i;

/**
 * Does this platform and folder give a usable creation time? Windows on a local drive does.
 * Through a WSL share the creation time is the Linux modification time (it changes on every
 * append), and on POSIX it is unreliable on some filesystems, so there the ids decide.
 */
function usesCreationTime(platform, projectDir) {
  return platform === "win32" && !WSL_SHARE.test(String(projectDir));
}

/**
 * Has the same NAME become a different file? A nonzero dev/ino that differs counts; the
 * creation time counts too when useCreationTime (see usesCreationTime), as NTFS keeps the
 * creation time of a file replaced within seconds ("tunneling") but not its id. On every
 * platform the shrink check runs on its own and needs neither. A replacement that is larger,
 * and shows the same ids, cannot be told apart: a known limit.
 */
function replaced(prev, st, useCreationTime) {
  if (!prev) return false;
  const idSame = noIdentity(prev) || noIdentity(st) || (prev.ino === st.ino && prev.dev === st.dev);
  if (useCreationTime) return prev.birth !== st.birthtimeMs || !idSame;
  return !idSame;
}
const identOf = (st) => ({ dev: st.dev, ino: st.ino, birth: st.birthtimeMs });

/**
 * True when a listing taken at `at` cannot be proven current by an unchanged folder mtime: the
 * mtime is within RACY_MS of the listing (ext4 ticks, FAT 2 s) or in its future, so a file added
 * right after the listing may leave the same mtime. Same idea as git's racy-clean check. A skewed
 * clock (see known issue 35) makes it always or never true; the RESCAN_MS backstop still holds.
 */
const racy = (mtimeMs, at) => !(at - mtimeMs >= RACY_MS);

const isRegular = (st) => st && st.isFile() && !st.isSymbolicLink();
const isMissing = (e) => e && (e.code === "ENOENT" || e.code === "ENOTDIR");

/**
 * Sorted .jsonl names of one directory (lowercase extension only). Subagents: cut to the entry
 * cap BEFORE filtering. Top level (opts.top): filter first, cut only at MAX_SCAN_CANDIDATES.
 */
function listJsonl(dir, stats, opts) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { names: [], error: isMissing(e) ? "missing" : "unreadable" };
  }
  const isJsonl = (n) => n.length > JSONL.length && n.endsWith(JSONL);
  if (opts && opts.top) {
    names = names.filter(isJsonl);
    names.sort();
    if (names.length > MAX_SCAN_CANDIDATES) {
      names = names.slice(0, MAX_SCAN_CANDIDATES);
      stats.dirCut += 1;
    }
    return { names };
  }
  names.sort();
  if (names.length > MAX_DIR_ENTRIES) {
    names = names.slice(0, MAX_DIR_ENTRIES);
    stats.dirCut += 1;
  }
  return { names: names.filter(isJsonl) };
}

/**
 * Open read-only without following links, then check THE OPEN HANDLE: a regular file, and the
 * same dev/ino (BigInt, exact) as the earlier lstat of that name (skipped only when either side
 * reports dev and ino both 0, i.e. no identity at all).
 * Returns the fd; throws (code EIDENT on a mismatch) after closing it.
 */
function openChecked(filePath, lst) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EIDENT" });
    if (!noIdentity(lst) && !noIdentity(st) && (lst.ino !== st.ino || lst.dev !== st.dev)) {
      throw Object.assign(new Error("file identity changed"), { code: "EIDENT" });
    }
    return fd;
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch (_e) {
      /* ignore */
    }
    throw e;
  }
}

/** Read up to len bytes at pos from an open handle (short only at end of file). */
function readHandle(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** Handle version of T.findNextNewlineOffset: offset after the next newline, or -1. */
function nextNewlineOffset(fd, startOffset, fileSize) {
  let pos = startOffset;
  while (pos < fileSize) {
    const slice = readHandle(fd, pos, Math.min(fileSize - pos, T.TRANSCRIPT_READ_MAX_PER_POLL));
    if (!slice.length) break;
    const nl = T.findFirstNewlineByte(slice, 0);
    if (nl >= 0) return pos + nl + T.newlineByteLength(slice, nl);
    pos += slice.length;
  }
  return -1;
}

function closeQuiet(fd) {
  try {
    fs.closeSync(fd);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * @param {{projectDir:string, now?:()=>number, holdPolls?:number, holdChildPolls?:number, rescanMs?:number, platform?:string, creationTime?:boolean}} opts
 *   projectDir is absolute and private; now/holdPolls/rescanMs are injectable for tests
 */
function createClaudeCodeIngest(opts) {
  const projectDir = String(opts && opts.projectDir);
  const now = (opts && opts.now) || Date.now;
  const holdPolls = opts && opts.holdPolls > 0 ? opts.holdPolls : HOLD_POLLS;
  const holdChildPolls = opts && opts.holdChildPolls >= 0 ? opts.holdChildPolls : HOLD_CHILD_POLLS;
  const rescanMs = opts && opts.rescanMs >= 0 ? opts.rescanMs : RESCAN_MS;
  const platform = (opts && opts.platform) || process.platform;
  // creationTime is injectable for tests; otherwise decided by platform and folder
  const useBirth =
    opts && typeof opts.creationTime === "boolean"
      ? opts.creationTime
      : usesCreationTime(platform, projectDir);
  const drift = { unparsed: 0, oversize: 0, metaBad: 0, unreadable: 0, dirCut: 0 };
  const counts = { lines: 0, rows: 0, sessions: 0 };
  let projectMissing = false;
  let more = false;
  let capped = false; // unread bytes remain because of the per-poll read cap (a wait is not capped)
  let heldNow = 0; // children held for their parent's Agent result in the current poll
  let catchUp = false; // this poll is a re-poll inside one scan: no poll-counted wait advances
  let parentRead = false; // this poll read the current session's parent to its end, no error
  let waitingNow = false; // a poll-counted wait (meta wait, child hold, session hold) is pending
  let metaWaitingNow = 0; // files waiting for their meta in this poll
  /** @type {null|{id:string, name:string, state:ReturnType<typeof P.createState>, files:Map<string,FileEntry>, names:Map<string,string>, children:number, faults:Map<string,number>, sub:null|{mtime:number, at:number, names:string[]}}} */
  let session = null;
  /** @type {null|{dirMtime:number, at:number, best:null|{name:string}}} */
  let cache = null;
  let pending = null; // {name, n}: a newer session waiting out the hold

  function resetSession(name) {
    session = {
      id: name.slice(0, -JSONL.length),
      name,
      state: P.createState(),
      files: new Map(),
      names: new Map([["session", name]]),
      children: 0,
      faults: new Map(), // key -> regular polls spent waiting after a first-read failure
      sub: null // cached subagents listing: {mtime, at, names}
    };
    pending = null;
    counts.sessions += 1;
  }

  function dropAll(missing) {
    session = null;
    cache = null;
    pending = null;
    if (missing) projectMissing = true;
  }

  /** Newest regular top-level <id>.jsonl by mtime (name order breaks ties). */
  function scan() {
    const list = listJsonl(projectDir, drift, { top: true });
    if (list.error) return { error: list.error };
    let best = null;
    for (const name of list.names) {
      let st;
      try {
        st = fs.lstatSync(path.join(projectDir, name));
      } catch (_) {
        drift.unreadable += 1;
        continue;
      }
      if (!isRegular(st)) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs };
    }
    return { best };
  }

  /**
   * The meta file is not usable yet (missing, transient error, empty or half-written): wait up
   * to META_WAIT_POLLS polls, retrying on the next poll (never a sleep), then run without it.
   * kind names the drift counter bumped once when the wait runs out (null: nothing to count).
   */
  function metaWaiting(file, kind) {
    if (!catchUp) file.metaWait += 1; // a catch-up poll never advances the wait
    if (file.metaWait <= META_WAIT_POLLS) return { done: false, meta: null };
    if (kind) drift[kind] += 1;
    return { done: true, meta: null };
  }

  function metaRead(file, metaPath) {
    let lst;
    try {
      lst = lstatId(metaPath);
    } catch (e) {
      return metaWaiting(file, isMissing(e) ? null : "unreadable");
    }
    if (!isRegular(lst)) {
      drift.metaBad += 1; // a link or folder: never read, no point waiting
      return { done: true, meta: null };
    }
    let fd;
    try {
      fd = openChecked(metaPath, lst);
    } catch (e) {
      return metaWaiting(file, isMissing(e) ? null : "unreadable");
    }
    try {
      // The cap applies to bytes actually read, not to a size checked earlier.
      const buf = readHandle(fd, 0, MAX_META_BYTES + 1);
      if (buf.length > MAX_META_BYTES) {
        drift.metaBad += 1; // over the cap: definitive
        return { done: true, meta: null };
      }
      const obj = P.parseJsonLine(buf.toString("utf8"));
      return obj ? { done: true, meta: obj } : metaWaiting(file, "metaBad");
    } catch (_) {
      return metaWaiting(file, "unreadable");
    } finally {
      closeQuiet(fd);
    }
  }

  /**
   * Read one file from its offset, at most one capped chunk. Sets more when capped data
   * remains. t = {filePath, st (this poll's lstat), label, child, metaPath}.
   * Returns false when the file could not be read (open, identity or read error).
   */
  function feedFile(file, t, rows) {
    if (t.child && !file.metaDone) {
      const m = metaRead(file, t.metaPath);
      if (!m.done) {
        more = true;
        waitingNow = true;
        metaWaitingNow += 1;
        return true;
      }
      file.metaDone = true;
      file.meta = m.meta;
    }
    if (t.child && holdChild(file)) return true;
    const size = t.st.size;
    if (size <= file.offset) {
      file.seenEnd = true;
      return true;
    }
    let fd;
    try {
      fd = openChecked(t.filePath, t.st);
    } catch (_) {
      drift.unreadable += 1;
      return false;
    }
    try {
      const start = file.offset;
      const len = Math.min(size - start, T.TRANSCRIPT_READ_MAX_PER_POLL);
      const buf = readHandle(fd, start, len);
      const end = T.completeLinesEndExclusive(buf);
      if (start + len >= size) file.seenEnd = true; // the whole file was read (a partial last line counts)
      if (end < 0) {
        // No newline in the chunk. A full chunk means an oversize line: skip it, count it.
        if (buf.length === T.TRANSCRIPT_READ_MAX_PER_POLL) {
          const next = nextNewlineOffset(fd, start + buf.length, size);
          if (next > 0) {
            file.offset = next;
            drift.oversize += 1;
            if (size > next) more = capped = true;
            else file.seenEnd = true;
          }
        }
        return true;
      }
      file.offset += end;
      if (size - start > len) more = capped = true; // capped: complete lines may remain
      const parseOpts = { source: t.label, meta: file.meta || undefined };
      T.forEachCompleteLine(buf.subarray(0, end), 0, (_at, trimmed) => {
        if (!trimmed) return;
        counts.lines += 1;
        const obj = P.parseJsonLine(trimmed);
        if (!obj) {
          drift.unparsed += 1;
          return;
        }
        for (const r of P.parseLine(obj, session.state, parseOpts)) rows.push(r);
      });
      return true;
    } catch (_) {
      drift.unreadable += 1;
      return false;
    } finally {
      closeQuiet(fd);
    }
  }

  /**
   * Bounded child hold: true while the child's meta names a toolUseId whose Agent call has no
   * Agent result (agentId) yet, for at most holdChildPolls polls (counted per child).
   */
  function holdChild(file) {
    const id = file.meta && typeof file.meta.toolUseId === "string" ? file.meta.toolUseId : "";
    if (!id) return false;
    const call = session.state.calls.get(id);
    if (call && call.agentId) return false;
    if (file.heldPolls >= holdChildPolls) return false;
    if (!catchUp) file.heldPolls += 1; // a catch-up poll holds the child but does not count
    waitingNow = true;
    heldNow += 1;
    more = true;
    return true;
  }

  /**
   * A transient failure (lstat, open or read, a folder check or listing) of something never read
   * yet: its old history would otherwise be read later as if it were new. Report a pending wait
   * (stats().waiting) for at most FAULT_WAIT_POLLS regular polls per key, so a file that never
   * reads cannot hold the live phase forever (drift.unreadable counts every failure).
   */
  function faultWait(key) {
    const n = session.faults.get(key) || 0;
    if (n >= FAULT_WAIT_POLLS) return;
    if (!catchUp) session.faults.set(key, n + 1);
    waitingNow = true;
  }

  /** @returns {FileEntry} */
  function newFile() {
    return {
      offset: 0,
      seenEnd: false, // set once a read reached the file's end; a failure before that holds the live phase
      meta: null,
      metaDone: false,
      metaWait: 0,
      heldPolls: 0,
      lastSt: null, // the last lstat taken of a child
      idle: 0, // consecutive checks that found the child fully read and unchanged
      skipped: 0, // polls since the last real lstat of an idle child
      ord: 0 // first-seen number, spreads the idle checks of many children over the polls
    };
  }

  /** The stat of a real folder (not a link, not a junction) or null; links are never followed. */
  function realDir(p) {
    try {
      const st = fs.lstatSync(p);
      return st.isDirectory() && !st.isSymbolicLink() ? st : null;
    } catch (e) {
      if (!isMissing(e)) {
        drift.unreadable += 1;
        faultWait("dir:" + path.basename(p));
      }
      return null;
    }
  }

  /**
   * Sorted subagent file names. The listing is cached and re-read only when the subagents
   * folder mtime changed, the listing is racy (RACY_MS), or the RESCAN_MS backstop passed; each poll still lstats every child
   * (an append to a file does not change the folder mtime).
   */
  function subagentNames(subDir, subSt) {
    const t = now();
    const c = session.sub;
    if (c && c.mtime === subSt.mtimeMs && t >= c.at && t - c.at < rescanMs && !racy(c.mtime, c.at))
      return c.names;
    const subs = listJsonl(subDir, drift);
    if (subs.error) {
      if (subs.error === "unreadable") {
        drift.unreadable += 1;
        faultWait("list");
      }
      return [];
    }
    session.sub = { mtime: subSt.mtimeMs, at: t, names: subs.names };
    return subs.names;
  }

  /** @param {{catchUp?:boolean}} [o] catchUp: a re-poll in the same scan, no wait advances */
  function poll(o) {
    more = false;
    capped = false;
    heldNow = 0;
    catchUp = !!(o && o.catchUp);
    parentRead = false;
    waitingNow = false;
    metaWaitingNow = 0;
    try {
      return pollUnsafe();
    } catch (_) {
      drift.unreadable += 1;
      return [];
    }
  }

  /** Refresh the cached newest session when due. Returns false when the poll should stop. */
  function refreshCache(t) {
    let dirSt;
    try {
      dirSt = fs.statSync(projectDir);
    } catch (e) {
      if (isMissing(e)) {
        dropAll(true);
      } else {
        drift.unreadable += 1; // transient (EBUSY/EPERM): keep the session and the cache
      }
      return false;
    }
    projectMissing = false;
    /* A folder mtime is not proof that nothing was added (Windows and OneDrive can report the
       pre-create time), so with no session known the folder is listed on every poll; with one,
       the mtime, the racy rule (RACY_MS) and the RESCAN_MS backstop decide. */
    let due =
      !cache ||
      !cache.best ||
      dirSt.mtimeMs !== cache.dirMtime ||
      racy(cache.dirMtime, cache.at) ||
      t - cache.at >= rescanMs ||
      t < cache.at;
    if (!due && cache.best) {
      try {
        due = !isRegular(fs.lstatSync(path.join(projectDir, cache.best.name)));
      } catch (_) {
        due = true; // the cached file is gone
      }
    }
    if (!due) return true;
    const r = scan();
    if (r.error === "missing") {
      dropAll(true);
      return false;
    }
    if (r.error) {
      drift.unreadable += 1; // keep the session; the next poll tries the listing again
      return false;
    }
    cache = { dirMtime: dirSt.mtimeMs, at: t, best: r.best };
    return true;
  }

  function pollUnsafe() {
    if (!refreshCache(now())) return [];
    const newest = cache.best;
    if (!newest) {
      session = null;
      pending = null;
      return [];
    }
    if (!session) {
      resetSession(newest.name);
    } else if (newest.name !== session.name) {
      if (!pending || pending.name !== newest.name) pending = { name: newest.name, n: 0 };
      if (!catchUp) pending.n += 1;
      if (pending.n >= holdPolls) resetSession(newest.name);
    } else {
      pending = null;
    }

    // Children: only through real folders, never through a link or junction.
    const idDir = path.join(projectDir, session.id);
    const subDir = path.join(idDir, "subagents");
    const kids = [];
    const subSt = realDir(idDir) && realDir(subDir);
    if (subSt) {
      for (const name of subagentNames(subDir, subSt)) {
        const filePath = path.join(subDir, name);
        const known = session.files.get(name);
        let st;
        if (known && known.lastSt && known.idle >= IDLE_AFTER && known.skipped < IDLE_EVERY - 1) {
          if (!catchUp) known.skipped += 1; // idle: reuse the last stat, nothing to read
          st = known.lastSt;
        } else {
          try {
            st = lstatId(filePath);
          } catch (e) {
            drift.unreadable += 1;
            if (!isMissing(e) && (!known || !known.seenEnd)) faultWait("lstat:" + name);
            continue;
          }
          if (known) {
            if (!catchUp) {
              // idle = no unread bytes (the meta wait and the child hold run every poll regardless)
              known.idle = known.offset >= st.size ? known.idle + 1 : 0;
              // stagger: children that go idle together must not all be checked on the same poll
              known.skipped = known.idle === IDLE_AFTER ? known.ord % IDLE_EVERY : 0;
            }
            known.lastSt = st;
          }
        }
        if (!isRegular(st)) continue;
        const base = name.slice(0, -JSONL.length);
        kids.push({
          key: name,
          name,
          filePath,
          st,
          child: true,
          metaPath: path.join(subDir, base + ".meta.json")
        });
      }
    }

    // The parent is stat'ed AFTER the children are listed: every child seen in this poll
    // existed before the parent size was taken, so the parent bytes read now cover its Agent
    // lines for those children.
    const parentPath = path.join(projectDir, session.name);
    let pst;
    try {
      pst = lstatId(parentPath);
    } catch (e) {
      if (isMissing(e))
        dropAll(false); // vanished: the next poll lists the folder again
      else drift.unreadable += 1;
      return [];
    }
    if (!isRegular(pst)) {
      drift.unreadable += 1;
      return [];
    }

    // A shrunk file (rotation, truncation) or a name that now holds a different file: drop the
    // session state and replay it all.
    const shrunk = [{ key: "", st: pst }, ...kids].some((t) => {
      const f = session.files.get(t.key);
      return f && (t.st.size < f.offset || replaced(f.ident, t.st, useBirth));
    });
    if (shrunk) resetSession(session.name);

    const rows = [];
    let parent = session.files.get("");
    if (!parent) {
      parent = newFile();
      parent.ident = identOf(pst);
      session.files.set("", parent);
    }
    const parentOk = feedFile(
      parent,
      { filePath: parentPath, st: pst, label: "session", child: false },
      rows
    );
    parentRead = parentOk && !capped;
    // Children wait while the parent feed failed or still has capped, unread bytes (their
    // spawn rows need the parent's Agent call and result lines first).
    if (parentOk && !more) {
      for (const k of kids) {
        let f = session.files.get(k.key);
        if (!f) {
          f = newFile();
          f.ident = identOf(k.st);
          f.lastSt = k.st;
          session.files.set(k.key, f);
          session.children += 1;
          f.ord = session.children;
          f.label = "subagent:" + session.children;
          session.names.set(f.label, k.name);
        }
        k.label = f.label;
        if (!feedFile(f, k, rows) && !f.seenEnd) faultWait("read:" + k.key);
      }
    }
    counts.rows += rows.length;
    return rows;
  }

  /** Counts and flags only: no paths, no names, no text. */
  function stats() {
    return {
      files: session ? session.files.size : 0,
      lines: counts.lines,
      rows: counts.rows,
      sessions: counts.sessions,
      projectMissing,
      more,
      capped,
      heldChildren: heldNow,
      parentRead,
      metaWaiting: metaWaitingNow,
      waiting: waitingNow || !!pending,
      drift: { ...drift }
    };
  }

  /** Debugging only: the BASE name (no folder) behind a row `source` label, or null. */
  function describeFile(label) {
    return (session && session.names.get(String(label))) || null;
  }

  /** Models as written, by parser role: {own, declared}. Raw strings, no paths; resolve before use. */
  function models() {
    const m = session && session.state.roleModels;
    return { own: { ...(m ? m.own : {}) }, declared: { ...(m ? m.declared : {}) } };
  }

  return { poll, stats, describeFile, models };
}

module.exports = {
  createClaudeCodeIngest,
  usesCreationTime,
  MAX_DIR_ENTRIES,
  MAX_SCAN_CANDIDATES,
  HOLD_POLLS,
  HOLD_CHILD_POLLS,
  FAULT_WAIT_POLLS,
  RESCAN_MS,
  IDLE_AFTER,
  IDLE_EVERY
};
