/**
 * Claude Code source discovery: lists projects from the Windows (or local) ~/.claude/projects
 * and from /home/* /.claude/projects of every RUNNING WSL distro. Everything that touches
 * the outside world is injected (fs, runWsl, homedir, platform, now), so tests need no WSL.
 *
 * Owner rules, all enforced here:
 * - wsl.exe is only ever asked `-l -q` and `-l --running -q` (no -d, --exec, -u, --).
 * - A distro that is not running is skipped with a note and NO filesystem call is made for
 *   it (reaching a \\wsl$ path would start the distro). The \\wsl$ roots are never listed.
 * - Public output (publicView and the response helpers) carries no path and no username:
 *   a label is only the last folder name of the project's cwd, and a folder named like a
 *   home gets a short hash label instead. A path is a home folder when, after resolving "."
 *   and ".." in any slash style, its second-to-last folder is home, Users or Documents and
 *   Settings (so /home/x, /export/home/x, /usr/home/x, /mnt/wsl/home/x, a server share's
 *   c$/Users/x all count), or it is exactly /root. Accepted false positive: a project in a
 *   folder whose parent is called home (D:/x/home/app) also gets the hash label.
 * - Hash labels and project ids are HMAC-SHA256 keyed with a random 16-byte per-install salt
 *   (loadOrCreateSalt, in its own config folder, resolveSaltDir, never the event-log folder) so short labels cannot be reversed by guessing names. The salt is
 *   injected (opts.salt); with none, a random per-process salt is used. Never a fixed salt.
 * - Nothing here throws; every failure becomes a note.
 */
"use strict";

const nodeFs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const BS = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

const WSL_TIMEOUT_MS = 3000;
const HOMES_RE = /^(users|documents and settings)$/i;
const WSL_LIST = ["-l", "-q"];
const WSL_RUNNING = ["-l", "--running", "-q"];
const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_CONCURRENCY = 16; // fs calls in flight at once, so a network share is never flooded
const MAX_DIR_ENTRIES = 2000; // entries checked per single directory listing, in name order
const MAX_TIMER_MS = 2147483647; // the largest delay setTimeout honours
const DEFAULT_TIMEOUT_MS = 20000; // overall discovery deadline
const MAX_HOMES = 64;
const MAX_PROJECTS = 500; // per source (all homes of one distro together), newest kept
const MAX_TOTAL = 2000; // merged list
const READ_BYTES = 16384; // bounded cwd read: one read of at most 16 KB of the newest transcript
const READ_LINES = 20; // ...and only the first 20 lines of those bytes
const LABEL_MAX = 60;
const SALT_BYTES = 16;
const SALT_FILE = "label-salt.bin";

/** Control, bidi and zero-width characters, built without escape sequences. */
const INVISIBLE_RE = new RegExp(
  "[" +
    [
      [0, 31],
      [127, 159],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff]
    ]
      .map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b))
      .join("") +
    "]",
  "g"
);

let processSalt = null;
/** Random per-process salt, made on first use. Never fixed. */
function getProcessSalt() {
  if (!processSalt) processSalt = crypto.randomBytes(SALT_BYTES);
  return processSalt;
}
const validSalt = (s) => Buffer.isBuffer(s) && s.length === SALT_BYTES;

const hmac = (salt, s) => crypto.createHmac("sha256", salt).update(s).digest("hex");
const hashLabel = (fullPath, salt) =>
  hmac(validSalt(salt) ? salt : getProcessSalt(), fullPath).slice(0, 6);
const projectId = (salt, tag, absPath) => "cc-" + hmac(salt, tag + NUL + absPath).slice(0, 12);

const SALT_LOCK_STALE_MS = 10000;
const SALT_LOCK_WAIT_MS = 3000;
const SALT_LOCK_POLL_MS = 25;
const sleepMs = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // no wait available: the caller just polls again
  }
};

const monoMs = () => Number(process.hrtime.bigint() / 1000000n);
/** Windows sharing errors: another process (or antivirus) has the file open for a moment. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const isTransient = (e) => !!e && TRANSIENT.has(e.code);

/** Run fn, retrying a transient sharing error every poll until the wait budget runs out. */
function retryTransient(fn, { mono, sleep, waitMs }) {
  const t0 = mono();
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!isTransient(e) || mono() - t0 >= waitMs) throw e;
      sleep(SALT_LOCK_POLL_MS);
    }
  }
}

/**
 * Exclusive-create lock file (open "wx") that holds a random token. Returns the token when this
 * call holds the lock, or null when it could not get it: the wait (monotonic clock) ran out, the
 * folder is not writable, or the lock file cannot be looked at or removed. A Windows sharing error
 * (EPERM, EACCES, EBUSY) is waited out: each pass sleeps and then checks the deadline, so this
 * cannot spin. Any other error except "it vanished" gives up at once. A sharing error on the hard
 * link never leads to removing the lock directly.
 * A lock whose time is more than staleMs from now (old, or in the future after a clock change)
 * was left by a process that died, and is removed (see below).
 */
function takeSaltLock(fs, lockFile, { now, mono, sleep, staleMs, waitMs }) {
  const token = crypto.randomBytes(8).toString("hex");
  const t0 = mono();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, token);
      } catch {
        try {
          fs.closeSync(fd);
        } catch {
          // closed below by the caller's failure path
        }
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // nothing to clean
        }
        return null;
      }
      fs.closeSync(fd);
      return token;
    } catch (e) {
      // a lock being deleted is still "in use" on Windows for a moment: wait and try again
      if (!e || (e.code !== "EEXIST" && !isTransient(e))) return null;
    }
    if (mono() - t0 >= waitMs) return null;
    try {
      const seenMtime = fs.statSync(lockFile).mtimeMs;
      if (Math.abs(now() - seenMtime) > staleMs) {
        // Break a stale lock without ever moving the real one: hard-link it under a name made from
        // its own content. Only one process can create that link; the winner checks it holds the
        // lock it judged stale (a fresh lock made meanwhile is left alone) and removes it.
        const seenToken = String(fs.readFileSync(lockFile, "utf8"));
        // the same lock as the one judged stale: same content and the same old time. The time
        // matters most for an empty lock, which looks the same as a fresh lock whose token has
        // not been written yet
        const sameLock = (p) =>
          String(fs.readFileSync(p, "utf8")) === seenToken && fs.statSync(p).mtimeMs === seenMtime;
        const id = crypto.createHash("sha1").update(seenToken).digest("hex").slice(0, 16);
        const grave = lockFile + ".stale-" + Math.floor(seenMtime) + "-" + id;
        try {
          fs.linkSync(lockFile, grave);
        } catch (e) {
          if (e && e.code === "ENOENT") continue; // already gone: try to take it
          if (e && e.code === "EEXIST") {
            // another process is removing it. If that one died half way, its link is old too
            try {
              if (now() - fs.statSync(grave).ctimeMs > staleMs) fs.unlinkSync(grave);
            } catch {
              // gone already, or not ours to remove: wait and look again
            }
            sleep(SALT_LOCK_POLL_MS);
            continue;
          }
          if (isTransient(e)) {
            // a sharing error is not "no hard links": wait and look again, never remove the lock
            sleep(SALT_LOCK_POLL_MS);
            continue;
          }
          // no hard links on this disk: remove the lock directly, if it is still the same one
          if (sameLock(lockFile)) fs.unlinkSync(lockFile);
          continue;
        }
        try {
          if (sameLock(grave)) fs.unlinkSync(lockFile);
        } finally {
          try {
            fs.unlinkSync(grave);
          } catch {
            // a leftover .stale- file is harmless
          }
        }
        continue;
      }
    } catch (e) {
      if (e && e.code === "ENOENT") continue; // it vanished meanwhile: try to take it
      if (isTransient(e)) {
        // another process is deleting or holding it for a moment (Windows): wait, then look
        // again; the deadline at the top of the loop still ends the wait
        sleep(SALT_LOCK_POLL_MS);
        continue;
      }
      return null; // cannot look at it or remove it: give up
    }
    sleep(SALT_LOCK_POLL_MS);
  }
}

/** Remove the lock only when it still holds our token. */
function releaseSaltLock(fs, lockFile, token) {
  try {
    if (String(fs.readFileSync(lockFile, "utf8")) === token) fs.unlinkSync(lockFile);
  } catch {
    // already gone, or not ours to touch
  }
}

/**
 * The per-install label salt: label-salt.bin in `dir`, 16 random bytes, mode 0600. A new file is
 * written to a temp name, flushed to disk, then linked in without replacing (the first process
 * to start wins). A corrupt (wrong-length) file is replaced by rename while holding
 * label-salt.bin.lock, so processes starting together do not overwrite each other. The value on
 * disk is the one returned. A file that cannot be read, or a lock that cannot be taken, never
 * leads to an overwrite: a random in-memory salt and a "labels-unstable" note are returned instead.
 * Never a fixed fallback.
 * `seed` (a valid 16-byte salt) is published instead of a random one when the file is missing or
 * corrupt (the migration from the old folder); an existing valid file always wins over it.
 * @param {{dir?: string, seed?: Buffer, fs?: any, now?: () => number, mono?: () => number, sleep?: (ms: number) => void, lockStaleMs?: number, lockWaitMs?: number}} [opts]
 * @returns {{salt: Buffer, note?: {code: string, text: string}}}
 */
function loadOrCreateCore({
  dir,
  seed,
  fs = nodeFs,
  now = Date.now,
  mono = monoMs,
  sleep = sleepMs,
  lockStaleMs = SALT_LOCK_STALE_MS,
  lockWaitMs = SALT_LOCK_WAIT_MS
} = {}) {
  const unstable = () => ({
    salt: crypto.randomBytes(SALT_BYTES),
    note: { code: "labels-unstable", text: "Labels change after restart" }
  });
  if (typeof dir !== "string" || !dir) {
    // no folder to keep it in: nothing is read or written (a relative name would land in the cwd)
    return unstable();
  }
  const file = path.join(dir, SALT_FILE);
  const lockFile = file + ".lock";
  let missing = false;
  try {
    const have = fs.readFileSync(file);
    if (validSalt(have)) return { salt: Buffer.from(have) };
    // present but the wrong length: corrupt, so a new one replaces it (under the lock, below)
  } catch (e) {
    if (e && e.code === "ENOENT") missing = true;
    // present but unreadable right now (lock, permissions): never overwrite a file that may be
    // fine. Use a throwaway salt for this run and say so.
    else return unstable();
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // the write below reports the real problem
  }
  let lockToken = null;
  const retry = { mono, sleep, waitMs: lockWaitMs };
  const salt = validSalt(seed) ? Buffer.from(seed) : crypto.randomBytes(SALT_BYTES);
  const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
  try {
    if (!missing) {
      lockToken = takeSaltLock(fs, lockFile, {
        now,
        mono,
        sleep,
        staleMs: lockStaleMs,
        waitMs: lockWaitMs
      });
      if (!lockToken) return unstable(); // never replace a file without the lock
      // another process may have fixed it while we waited for the lock
      try {
        const again = retryTransient(() => fs.readFileSync(file), retry);
        if (validSalt(again)) return { salt: Buffer.from(again) };
      } catch (e) {
        if (e && e.code === "ENOENT") missing = true;
        else return unstable();
      }
    }
    // write and flush the temp file first, so a power loss cannot leave an empty salt file
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, salt);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (missing) {
      // link never replaces a file: when two processes start together the first one wins
      try {
        fs.linkSync(tmp, file);
      } catch (e) {
        // EEXIST: another process just made it. Anything else (no hard links here): rename
        if (!e || e.code !== "EEXIST") retryTransient(() => fs.renameSync(tmp, file), retry);
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already renamed away
      }
    } else {
      retryTransient(() => fs.renameSync(tmp, file), retry);
    }
    // use what is on disk, so every process that starts together agrees
    const onDisk = retryTransient(() => fs.readFileSync(file), retry);
    if (validSalt(onDisk)) return { salt: Buffer.from(onDisk) };
    return { salt, note: { code: "labels-unstable", text: "Labels change after restart" } };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    return { salt, note: { code: "labels-unstable", text: "Labels change after restart" } };
  } finally {
    if (lockToken) releaseSaltLock(fs, lockFile, lockToken);
  }
}

const SALT_DIR_NAME = "cursor-agents-model-routing-config";
const unstableNote = () => ({ code: "labels-unstable", text: "Labels change after restart" });
const permNote = () => ({
  code: "salt-folder-permissions",
  text: "The label salt folder could not be made private"
});

/**
 * The folder for the per-install label salt: a config folder of its own, never the event-log
 * folder (people zip that one for bug reports). CURSOR_EVENT_LOG_DIR plays no part here.
 * Windows %LOCALAPPDATA% (else <home>/AppData/Local), macOS ~/Library/Application Support,
 * elsewhere $XDG_CONFIG_HOME (absolute only) or ~/.config. Returns "" when there is no absolute
 * home (a relative result is never returned).
 * @param {{platform?: string, env?: Record<string, string|undefined>, homedir?: string}} [opts]
 * @returns {string}
 */
function resolveSaltDir({ platform = process.platform, env = process.env, homedir } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const abs = (v) => typeof v === "string" && v !== "" && p.isAbsolute(v);
  // a relative home would put the salt folder under the current folder: no home, no folder
  const rawHome = homedir === undefined ? os.homedir() : homedir;
  const home = abs(rawHome) ? rawHome : "";
  if (platform === "win32") {
    const base = abs(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : home
        ? p.join(home, "AppData", "Local")
        : "";
    return base ? p.join(base, SALT_DIR_NAME) : "";
  }
  if (platform === "darwin") {
    return home ? p.join(home, "Library", "Application Support", SALT_DIR_NAME) : "";
  }
  if (abs(env.XDG_CONFIG_HOME)) return p.join(env.XDG_CONFIG_HOME, SALT_DIR_NAME);
  return home ? p.join(home, ".config", SALT_DIR_NAME) : "";
}

/** Read the salt file: valid, invalid (wrong length), missing, or error (cannot read now). */
function readSaltState(fs, file, retry) {
  try {
    const have = retry ? retryTransient(() => fs.readFileSync(file), retry) : fs.readFileSync(file);
    return validSalt(have) ? { state: "valid", salt: Buffer.from(have) } : { state: "invalid" };
  } catch (e) {
    return { state: e && e.code === "ENOENT" ? "missing" : "error" };
  }
}

/**
 * How do `a` and `b` relate? "same": the same device and a nonzero inode, or the same real path
 * (compared without case when `platform` is win32), so a case variant, symlink or junction counts.
 * "different": provably two files. "missing": `a` does not exist (ENOENT). "bmissing": `b` does
 * not exist. "unknown": any other stat or realpath failure. Only "different" licenses a delete.
 */
function identity(fs, a, b, platform) {
  const enoent = (e) => !!e && e.code === "ENOENT";
  let sa;
  let sb;
  try {
    sa = fs.statSync(a, { bigint: true });
  } catch (e) {
    return enoent(e) ? "missing" : "unknown";
  }
  try {
    sb = fs.statSync(b, { bigint: true });
  } catch (e) {
    return enoent(e) ? "bmissing" : "unknown";
  }
  try {
    // an inode of 0 (or none) is not an identity: Windows may report that
    if (sa.ino && sb.ino && sa.dev === sb.dev && sa.ino === sb.ino) return "same";
    const fold = (s) => (platform === "win32" ? s.toLowerCase() : s);
    return fold(String(fs.realpathSync(a))) === fold(String(fs.realpathSync(b)))
      ? "same"
      : "different";
  } catch {
    return "unknown";
  }
}

/**
 * Remove the salt this code left in the OLD (event-log) folder, by exact name only: the file, a
 * lock older than staleMs, and the temp and grave names this code makes (fixed prefix plus hex
 * and dashes). Anything else in that folder is never touched. Returns true when the salt file
 * itself is gone. The salt file is only deleted when it is provably a different file from
 * `newFile` (see identity): the same file, or one that cannot be told apart, is never touched.
 */
function removeOldSalt(fs, oldDir, newFile, now, staleMs, platform) {
  let gone = false;
  if (identity(fs, path.join(oldDir, SALT_FILE), newFile, platform) !== "different") return false;
  try {
    fs.unlinkSync(path.join(oldDir, SALT_FILE));
    gone = true;
  } catch (e) {
    gone = !!e && e.code === "ENOENT";
  }
  if (!gone) return false; // keep the leftovers too: the salt file is still there
  try {
    const lock = path.join(oldDir, SALT_FILE + ".lock");
    if (Math.abs(now() - fs.statSync(lock).mtimeMs) > staleMs) fs.unlinkSync(lock);
  } catch {
    // no lock, or one that is not ours to remove
  }
  try {
    for (const name of fs.readdirSync(oldDir)) {
      const tmpPrefix = SALT_FILE + ".tmp-";
      const gravePrefix = SALT_FILE + ".stale-";
      const rest = name.startsWith(tmpPrefix)
        ? name.slice(tmpPrefix.length)
        : name.startsWith(gravePrefix)
          ? name.slice(gravePrefix.length)
          : null;
      if (rest === null || !/^[0-9a-f-]+$/.test(rest)) continue;
      try {
        fs.unlinkSync(path.join(oldDir, name));
      } catch {
        // harmless leftover
      }
    }
  } catch {
    // folder not listable: leave the leftovers
  }
  return true;
}

/** POSIX: the folder must be 0700 and the salt file 0600. Returns true when they are. */
function secureSaltPaths(fs, dir, file, posix) {
  if (!posix || typeof fs.chmodSync !== "function" || typeof fs.statSync !== "function") {
    return true;
  }
  let ok = true;
  for (const [p, want] of [
    [dir, 0o700],
    [file, 0o600]
  ]) {
    try {
      const st = fs.statSync(p);
      if ((st.mode & 0o077) !== 0) fs.chmodSync(p, want);
    } catch (e) {
      if (!e || e.code !== "ENOENT") ok = false;
    }
  }
  return ok;
}

/**
 * The per-install label salt in its own config folder `dir` (see resolveSaltDir), with the
 * race-safe create / lock / replace rules of loadOrCreateCore. The folder is made 0700 and the
 * file 0600 on POSIX (a looser existing folder is tightened). Windows relies on the profile ACL.
 *
 * Migration: `oldDir` is the event-log folder an earlier version kept the salt in. When `dir`
 * has no valid salt and `oldDir` has one, that salt is published in `dir` (so ids and labels
 * stay the same), read back and compared, and only then is the old copy deleted. Any failure
 * deletes nothing and gives a per-process salt with a "labels-unstable" note; nothing is ever
 * written into `oldDir`. A valid salt already in `dir` always wins and the old copy is deleted; a
 * wrong-length old file is not migrated and is deleted once a fresh salt is in place. The old state
 * is decided once, before anything is touched: none (provably absent), same (provably the same
 * folder), corrupt, seed, or unknown. Unknown is anything else: a failed stat or realpath of the old
 * folder, or an old file that cannot be read after the sharing-error retries. Unknown has one
 * exit: a valid salt already in `dir` is returned, otherwise this run gets a per-process salt and
 * the note, nothing is published in `dir`, nothing is deleted, and the next start retries.
 * `oldDir` counts as another folder only when provably so (device and inode, else real path,
 * compared without case when `platform` is win32; a symlink or junction of `dir` does not count).
 * @param {{dir?: string, oldDir?: string, posix?: boolean, platform?: string, fs?: any, now?: () => number, mono?: () => number, sleep?: (ms: number) => void, lockStaleMs?: number, lockWaitMs?: number}} [opts]
 * @returns {{salt: Buffer, note?: {code: string, text: string}}}
 */
function loadOrCreateSalt(opts = {}) {
  const {
    oldDir,
    posix = process.platform !== "win32",
    platform = process.platform,
    ...core
  } = opts;
  const fs = core.fs || nodeFs;
  const now = core.now || Date.now;
  const staleMs = core.lockStaleMs === undefined ? SALT_LOCK_STALE_MS : core.lockStaleMs;
  const dir = core.dir;
  if (typeof dir !== "string" || !dir) return loadOrCreateCore(core);
  const file = path.join(dir, SALT_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // reported by the core below
  }
  const dirOk = secureSaltPaths(fs, dir, file, posix);
  const finish = (res) => {
    if (!res.note && (!dirOk || !secureSaltPaths(fs, dir, file, posix))) {
      return { ...res, note: permNote() };
    }
    return res;
  };
  const retry = {
    mono: core.mono || monoMs,
    sleep: core.sleep || sleepMs,
    waitMs: core.lockWaitMs === undefined ? SALT_LOCK_WAIT_MS : core.lockWaitMs
  };
  // The old state is worked out once, before anything is touched:
  //   none    the old folder or file provably does not exist -> create as usual
  //   same    provably the same folder: nothing to migrate or delete
  //   corrupt the old file is the wrong length: never migrated, deleted once a fresh salt is in place
  //   seed    a valid old salt, provably another file: migrate (copy, read back, then delete)
  //   unknown anything else (a failed stat or realpath, an unreadable old file): one exit below
  let state = "none";
  let oldSalt = null;
  const oldFile = typeof oldDir === "string" && oldDir !== "" ? path.join(oldDir, SALT_FILE) : "";
  if (oldFile) {
    if (path.resolve(oldDir) === path.resolve(dir)) state = "same";
    else {
      const rel = identity(fs, oldDir, dir, platform);
      if (rel === "same") state = "same";
      else if (rel === "missing") state = "none";
      else if (rel !== "different") state = "unknown";
      else {
        const old = readSaltState(fs, oldFile, retry);
        if (old.state === "missing") state = "none";
        else if (old.state === "error") state = "unknown";
        else if (old.state === "invalid") state = "corrupt";
        else {
          state = "seed";
          oldSalt = old.salt;
        }
      }
    }
  }
  if (state === "none" || state === "same") return finish(loadOrCreateCore(core));

  const before = readSaltState(fs, file, retry);
  if (state === "unknown" || before.state === "error") {
    // we cannot tell what the old folder holds (or the new file cannot be read now): never publish
    // a fresh salt that would later win over the real one, and never touch the old file. A valid
    // salt already in the new place is used; otherwise this run gets a per-process salt and the
    // note. The next start retries.
    if (before.state === "valid") return finish({ salt: before.salt });
    return { salt: crypto.randomBytes(SALT_BYTES), note: unstableNote() };
  }
  const failed = (res) => !!res.note && res.note.code === "labels-unstable";
  if (before.state === "valid" || state === "corrupt") {
    // a salt already in the new place wins; a wrong-length old file is never migrated
    const res = loadOrCreateCore(core);
    if (!failed(res)) removeOldSalt(fs, oldDir, file, now, staleMs, platform);
    return finish(res);
  }
  const res = loadOrCreateCore({ ...core, seed: oldSalt });
  // nothing deleted; the in-memory salt is a fresh one, not the old one
  if (failed(res)) return { salt: crypto.randomBytes(SALT_BYTES), note: res.note };
  const back = readSaltState(fs, file, retry);
  if (back.state !== "valid" || !back.salt.equals(oldSalt)) {
    return { salt: crypto.randomBytes(SALT_BYTES), note: unstableNote() };
  }
  removeOldSalt(fs, oldDir, file, now, staleMs, platform);
  return finish({ salt: back.salt });
}

/**
 * SystemRoot is only used when it is a drive-absolute path (letter, colon, backslash) with no
 * ".." segment and no control or invisible character; a UNC, relative or odd value gives
 * C:\Windows, so wsl.exe is never looked up on a share or a relative folder.
 */
function systemRoot(value) {
  const fallback = "C:" + BS + "Windows";
  if (typeof value !== "string" || value.length < 3) return fallback;
  if (!/^[A-Za-z]$/.test(value[0]) || value[1] !== ":" || value[2] !== BS) return fallback;
  if (value.replace(INVISIBLE_RE, "") !== value) return fallback;
  if (value.split(BS).join("/").split("/").includes("..")) return fallback;
  return value;
}

/**
 * wsl.exe runner built on an execFile implementation: no shell, only the two allowed argument
 * lists, and the full System32 path (not a PATH lookup). `opts.env` is read at each call.
 */
function makeRunWsl(execFileImpl, opts = {}) {
  return function runWsl(args) {
    const env = opts.env || process.env;
    const exe = path.win32.join(systemRoot(env.SystemRoot), "System32", "wsl.exe");
    return new Promise((resolve, reject) => {
      const ok = [WSL_LIST, WSL_RUNNING].some(
        (a) => a.length === args.length && a.every((x, i) => x === args[i])
      );
      if (!ok) return reject(new Error("wsl arguments not allowed"));
      execFileImpl(
        exe,
        args,
        { windowsHide: true, timeout: WSL_TIMEOUT_MS, encoding: "buffer", maxBuffer: 1 << 20 },
        (err, stdout) => {
          if (!err) return resolve({ status: 0, stdout });
          if (err.code === "ENOENT") return reject(err);
          if (err.killed || err.signal) {
            const e = new Error("wsl timed out");
            // @ts-ignore: marker code read by failureNote
            e.code = "ETIMEDOUT";
            return reject(e);
          }
          resolve({ status: typeof err.code === "number" ? err.code : 1, stdout });
        }
      );
    });
  };
}

const defaultRunWsl = makeRunWsl(execFile);

/** wsl.exe prints UTF-16LE (often with a BOM); accept UTF-8 too. Returns trimmed non-empty lines. */
function decodeLines(out) {
  let text;
  if (typeof out === "string") text = out;
  else if (out && typeof out.length === "number") {
    const b = Buffer.from(out);
    const bom = b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
    // No BOM: UTF-16LE of ASCII text has a NUL in every second byte.
    const wide = b.length >= 4 && b[1] === 0 && b[3] === 0;
    text = bom || wide ? b.toString("utf16le") : b.toString("utf8");
  } else text = "";
  return text
    .split(String.fromCharCode(10))
    .map((l) => l.split(NUL).join("").split(String.fromCharCode(0xfeff)).join("").trim())
    .filter(Boolean);
}

/** Valid distro names (first spelling wins, case-insensitive) plus how many lines were invalid. */
function parseDistros(out) {
  const names = [];
  const seen = new Set();
  let invalid = 0;
  for (const line of decodeLines(out)) {
    if (!DISTRO_RE.test(line)) {
      invalid++;
      continue;
    }
    const k = line.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(line);
  }
  return { names, invalid };
}

function failureNote(err) {
  const code = err && err.code;
  if (code === "ENOENT") return { code: "wsl-not-installed", text: "WSL not installed" };
  if (code === "ETIMEDOUT" || code === "ETIME" || (err && err.killed)) {
    return { code: "wsl-not-responding", text: "WSL not responding" };
  }
  return { code: "wsl-unavailable", text: "WSL unavailable" };
}

/** Running distro names, or [] with notes. Exactly two runner calls, never more. */
async function listRunningDistros(runWsl, notes) {
  let listed;
  try {
    listed = await runWsl(WSL_LIST.slice());
  } catch (e) {
    notes.push(failureNote(e));
    return [];
  }
  if (!listed || listed.status !== 0) {
    notes.push(failureNote(null));
    return [];
  }
  const { names, invalid } = parseDistros(listed.stdout);
  if (invalid && !names.length) {
    notes.push(failureNote(null)); // garbage, not a list of distros
    return [];
  }
  if (invalid) {
    notes.push({
      code: "invalid-distro-name",
      text: invalid + " WSL distro name" + (invalid > 1 ? "s" : "") + " skipped: not a valid name"
    });
  }
  if (!names.length) return [];
  const running = new Set();
  try {
    const r = await runWsl(WSL_RUNNING.slice());
    // A non-zero exit is how some wsl.exe versions say "no running distributions".
    if (r && r.status === 0) {
      for (const n of parseDistros(r.stdout).names) running.add(n.toLowerCase());
    }
  } catch (e) {
    notes.push(failureNote(e));
    return [];
  }
  const out = [];
  for (const name of names) {
    if (running.has(name.toLowerCase())) out.push(name);
    else {
      notes.push({ distro: name, code: "not-running", text: name + " skipped: not running" });
    }
  }
  return out;
}

const errCode = (e) => (e && e.code) || "";
const isMissing = (e) => ["ENOENT", "ENOTDIR"].includes(errCode(e));
const entryName = (e) => (typeof e === "string" ? e : e && e.name);

/** Drops one drive-like prefix: C:, /cygdrive/c, /mnt/c, or a bare /c before Users. */
function stripDrive(segs) {
  if (segs.length && /^[A-Za-z]:$/.test(segs[0])) return segs.slice(1);
  if (segs[0] === "cygdrive" && segs.length > 1) return segs.slice(2);
  if (segs[0] === "mnt" && segs[1] && /^[A-Za-z]$/.test(segs[1])) return segs.slice(2);
  if (segs[0] && /^[A-Za-z]$/.test(segs[0]) && HOMES_RE.test(segs[1] || "")) return segs.slice(1);
  return segs;
}

/**
 * Segments of a path in any slash style, without the extended-length prefix (question mark or
 * dot), the wsl host and distro, a drive, /mnt/c, /cygdrive/c or /c prefix, or a /var prefix.
 */
function homeSegments(p) {
  const norm = p.split(BS).join("/");
  let segs = norm.split("/").filter(Boolean);
  if (norm.startsWith("//") && segs.length && (segs[0] === "?" || segs[0] === ".")) {
    segs = segs.slice(1); // extended-length form, optionally followed by UNC
    if (segs[0] && segs[0].toUpperCase() === "UNC") segs = segs.slice(1);
  }
  if (segs.length > 1 && ["wsl$", "wsl.localhost"].includes(segs[0].toLowerCase())) {
    segs = segs.slice(2); // UNC form: drop the wsl host and the distro
  }
  segs = stripDrive(segs); // also after the UNC strip: wsl$ / distro / mnt / c / Users / x
  if (segs[0] === "var" && /^home$/i.test(segs[1] || "")) segs = segs.slice(1);
  return segs;
}

/** Path in any slash style with "." and ".." resolved (".." above the root drops). */
function normalizePath(p) {
  const flat = p.split(BS).join("/");
  const lead = flat.startsWith("//") ? "//" : flat.startsWith("/") ? "/" : "";
  const out = [];
  for (const seg of flat.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return lead + out.join("/");
}

/**
 * True for a home folder: second-to-last folder is home, Users or Documents and Settings
 * (case-insensitive), or the path is exactly /root. Works on the normalized path.
 */
function isHomeFolder(p) {
  const n = normalizePath(p);
  const segs = n.split("/").filter(Boolean);
  // a drive-relative first segment (C:Users) is a drive plus a folder name
  const drive = segs.length ? /^[A-Za-z]:(.+)$/.exec(segs[0]) : null;
  if (drive) segs[0] = drive[1];
  // Windows ignores trailing dots and spaces in a folder name (Users. is Users)
  const name = segs.length >= 2 ? segs[segs.length - 2].replace(/[. ]+$/, "") : "";
  if (/^(home|users|documents and settings)$/i.test(name)) return true;
  const rest = homeSegments(n);
  return rest.length === 1 && rest[0] === "root";
}

function lastSegment(p) {
  const segs = normalizePath(p).split("/").filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : "";
  return /^[A-Za-z]:$/.test(last) ? "" : last;
}

const cleanLabel = (s) =>
  Array.from(String(s).replace(INVISIBLE_RE, "")).slice(0, LABEL_MAX).join("").trim();

/**
 * Label from the cwd: last folder only; a home folder, or no cwd at all, gets the hash label.
 * Nothing is ever derived from the encoded folder name (it cannot be split back safely).
 * `hashed` tells the collision step not to add a suffix to a label that stands in for a name.
 */
function labelFor(cwd, fullPath, salt) {
  if (!cwd) return { label: hashLabel(fullPath, salt), hashed: true };
  if (isHomeFolder(cwd)) return { label: hashLabel(cwd, salt), hashed: true };
  const name = cleanLabel(lastSegment(cwd));
  return name ? { label: name, hashed: false } : { label: hashLabel(cwd, salt), hashed: true };
}

/**
 * Reads at most READ_BYTES (one read) from the start of a transcript and returns the cwd of the
 * first of its first READ_LINES lines that is valid JSON with a string cwd, or "". A line cut by
 * the byte cap does not parse and is skipped, so a huge first line is never read whole.
 */
async function readCwd(fs, file) {
  let fh = null;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(READ_BYTES);
    const { bytesRead: n } = await fh.read(buf, 0, READ_BYTES, 0);
    const lines = buf.toString("utf8", 0, n).split(String.fromCharCode(10)).slice(0, READ_LINES);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === "string" && o.cwd && o.cwd.length < 4096) return o.cwd;
      } catch {
        // a cut-off or non-JSON line: try the next
      }
    }
  } catch {
    // unreadable: no cwd
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // nothing to do
      }
    }
  }
  return "";
}

const abortError = () => Object.assign(new Error("discovery aborted"), { code: "EABORT" });

/**
 * The only door to the filesystem during one discovery. At most MAX_CONCURRENCY calls are in
 * flight (queued ones start as slots free up, in order); a cwd read (open, read, close one
 * after the other) counts as one. A directory listing comes back sorted by name (code units)
 * and cut to MAX_DIR_ENTRIES, with `cut` telling the caller. After abort() queued calls are
 * rejected and never start.
 */
function makeGuard(fs) {
  const queue = [];
  let active = 0;
  let dead = false;
  const pump = () => {
    while (active < MAX_CONCURRENCY && queue.length) {
      const task = queue.shift();
      if (dead) {
        task.reject(abortError());
        continue;
      }
      active++;
      let p;
      try {
        p = Promise.resolve(task.fn());
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => {
          active--;
          task.resolve(v);
          pump();
        },
        (e) => {
          active--;
          task.reject(e);
          pump();
        }
      );
    }
  };
  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  return {
    abort() {
      dead = true;
      while (queue.length) queue.shift().reject(abortError());
    },
    async list(p, keep) {
      let names = (await run(() => fs.readdir(p))).map(entryName).filter(Boolean);
      if (keep) names = names.filter(keep); // before the cut: only names that count are counted
      names = names.sort();
      const cut = names.length > MAX_DIR_ENTRIES;
      return { names: cut ? names.slice(0, MAX_DIR_ENTRIES) : names, cut };
    },
    lstat: (p) => run(() => fs.lstat(p)),
    cwd: (file) => run(() => readCwd(fs, file))
  };
}

/**
 * Candidate projects under one projects root (a folder holding a top-level .jsonl). Only stats
 * are done here; the cwd is read later, and only for projects that survive the cap.
 * `join` builds child paths in the root's style.
 * status: "ok" | "missing" (no such folder) | "error" (could not be read).
 */
async function readProjectsRoot(g, root, join, now) {
  let list;
  try {
    list = await g.list(root);
  } catch (e) {
    return { status: isMissing(e) ? "missing" : "error", items: [], cut: false };
  }
  // Promise.all keeps the listing order whatever order the calls finish in
  const found = await Promise.all(
    list.names.map(async (name) => {
      const dir = join(root, name);
      try {
        const st = await g.lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) return null;
        // only .jsonl names count toward the cap: a project folder also holds one folder per session
        const sub = await g.list(dir, (f) => f.endsWith(".jsonl"));
        const files = sub.names;
        const stats = await Promise.all(
          files.map(async (f) => {
            const file = join(dir, f);
            return { file, fst: await g.lstat(file) };
          })
        );
        let newest = null;
        for (const { file, fst } of stats) {
          if (!fst.isFile() || fst.isSymbolicLink()) continue;
          const mtime = Math.min(Number(fst.mtimeMs) || 0, now());
          if (!newest || mtime > newest.mtime) newest = { file, mtime };
        }
        const item = newest ? { dir, name, mtime: newest.mtime, file: newest.file } : null;
        return { item, cut: sub.cut };
      } catch {
        return null; // one unreadable project folder is skipped
      }
    })
  );
  const items = [];
  let cut = list.cut;
  for (const f of found) {
    if (!f) continue;
    if (f.item) items.push(f.item);
    if (f.cut) cut = true;
  }
  return { status: "ok", items, cut };
}

/**
 * The per-source cap: newest transcript first (ties by folder path, so the result does not
 * depend on directory order), keep MAX_PROJECTS, then read the cwd of the survivors only.
 * `truncated` is true only when a real project exists past the cap.
 */
async function selectNewest(g, items) {
  const sorted = items
    .slice()
    .sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const kept = sorted.slice(0, MAX_PROJECTS);
  const cwds = await Promise.all(kept.map((it) => g.cwd(it.file).catch(() => "")));
  return {
    truncated: sorted.length > MAX_PROJECTS,
    items: kept.map((it, i) => ({ ...it, cwd: cwds[i] }))
  };
}

/** Git Bash (/c/Users/x) and Cygwin (/cygdrive/c/Users/x) roots to C:\Users\x. */
function toWindowsHome(h) {
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(h);
  if (!m) return h;
  return m[1].toUpperCase() + ":" + (m[2] || "/").split("/").join(BS);
}

const wslJoin = (...parts) => parts.join(BS);

/** Scans one running distro. Only called for names that wsl.exe reported as running. */
async function scanDistro(g, distro, now) {
  const out = { items: [], truncated: false, unreadable: 0, homesFailed: false };
  const roots = [
    wslJoin(BS + BS + "wsl.localhost", distro, "home"),
    wslJoin(BS + BS + "wsl$", distro, "home")
  ];
  let homeRoot = "";
  let list = null;
  for (const r of roots) {
    try {
      list = await g.list(r); // sorted: the first MAX_HOMES are the same on every run
      homeRoot = r;
      break;
    } catch {
      // try the next spelling
    }
  }
  if (!list) {
    out.homesFailed = true;
    return out;
  }
  let homes = list.names;
  if (list.cut) out.truncated = true;
  if (homes.length > MAX_HOMES) {
    out.truncated = true;
    homes = homes.slice(0, MAX_HOMES);
  }
  const perHome = await Promise.all(
    homes.map(async (h) => {
      const home = wslJoin(homeRoot, h);
      try {
        const st = await g.lstat(home);
        if (!st.isDirectory() || st.isSymbolicLink()) return null;
      } catch {
        return { unreadable: 1, items: [], cut: false };
      }
      const res = await readProjectsRoot(g, wslJoin(home, ".claude", "projects"), wslJoin, now);
      return { unreadable: res.status === "error" ? 1 : 0, items: res.items, cut: res.cut };
    })
  );
  const all = [];
  for (const r of perHome) {
    if (!r) continue;
    out.unreadable += r.unreadable;
    if (r.cut) out.truncated = true;
    for (const it of r.items) all.push(it);
  }
  const sel = await selectNewest(g, all);
  if (sel.truncated) out.truncated = true;
  out.items = sel.items;
  return out;
}

/** Final labels for one source: collisions get " #<hash of the project folder>". */
function finish(tag, items, salt) {
  const labelled = items.map((it) => ({ it, ...labelFor(it.cwd, it.dir, salt) }));
  const count = new Map();
  for (const { label } of labelled) {
    const k = label.toLowerCase();
    count.set(k, (count.get(k) || 0) + 1);
  }
  return labelled.map(({ it, label, hashed }) => ({
    id: projectId(salt, tag, it.dir),
    label:
      !hashed && count.get(label.toLowerCase()) > 1
        ? label + " #" + hashLabel(it.dir, salt)
        : label,
    sourceTag: tag,
    mtime: it.mtime,
    path: it.dir
  }));
}

/**
 * Never throws. All fs work goes through `opts.fs` (promise style, like fs.promises; default
 * fs.promises) with at most MAX_CONCURRENCY calls in flight. When `opts.timeoutMs` (default
 * 20000) passes, what was collected so far is returned with a "discovery-timeout" note; calls
 * still running then finish unseen and cannot change the returned object.
 * @param {{salt?: Buffer, platform?: string, homedir?: string, fs?: any, runWsl?: Function, now?: () => number, timeoutMs?: number}} [opts]
 * @returns {Promise<{projects: Array<{id: string, label: string, sourceTag: string, mtime: number, path: string}>, notes: Array<{distro?: string, code: string, text: string}>}>}
 */
async function discoverClaudeProjects(opts = {}) {
  const platform = opts.platform || process.platform;
  const g = makeGuard(opts.fs || nodeFs.promises);
  // setTimeout fires at once for a delay above 2^31-1, so a huge or infinite value is clamped
  const wanted = Number(opts.timeoutMs);
  const timeoutMs = wanted > 0 ? Math.min(wanted, MAX_TIMER_MS) : DEFAULT_TIMEOUT_MS;
  const notes = [];
  const projects = [];
  const work = scan(opts, g, platform, projects, notes);
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs, TIMED_OUT);
  });
  work.catch(() => {}); // a scan that settles after the deadline must not become unhandled
  let winner;
  try {
    winner = await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
  if (winner === TIMED_OUT) {
    g.abort(); // queued calls never start; the scan's own pushes can no longer matter
    notes.push({ code: "discovery-timeout", text: "Discovery timed out" });
  }
  // copies, so a scan that is still winding down cannot change what the caller holds
  const out = projects.map((p) => ({ ...p }));
  const outNotes = notes.map((n) => ({ ...n }));
  out.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
  if (out.length > MAX_TOTAL) {
    out.length = MAX_TOTAL;
    outNotes.push({ code: "truncated", text: "Projects: list truncated" });
  }
  return { projects: out, notes: outNotes };
}

const TIMED_OUT = Symbol("timed out");

/** The scan itself: fills `projects` and `notes`. Every failure becomes a note; never rejects. */
async function scan(opts, g, platform, projects, notes) {
  const runWsl = opts.runWsl || defaultRunWsl;
  const now = opts.now || Date.now;
  const salt = validSalt(opts.salt) ? opts.salt : getProcessSalt();
  const isWin = platform === "win32";
  const label = isWin ? "Windows" : "Local";

  try {
    const home = opts.homedir === undefined ? os.homedir() : opts.homedir;
    if (home) {
      const root = isWin
        ? path.win32.join(toWindowsHome(home), ".claude", "projects")
        : path.join(home, ".claude", "projects");
      const join = isWin ? path.win32.join : path.join;
      const tag = isWin ? "windows" : "local";
      const res = await readProjectsRoot(g, root, join, now);
      const sel = await selectNewest(g, res.items);
      projects.push(...finish(tag, sel.items, salt));
      if (res.status === "error") {
        notes.push({ code: "home-unreadable", text: label + ": projects folder unreadable" });
      } else if (!sel.items.length) {
        notes.push({ code: "no-projects", text: label + ": no Claude Code projects" });
      }
      if (sel.truncated || res.cut) {
        notes.push({ code: "truncated", text: label + ": list truncated" });
      }
    }
  } catch {
    notes.push({ code: "home-unreadable", text: label + ": projects folder unreadable" });
  }

  if (isWin) {
    try {
      for (const distro of await listRunningDistros(runWsl, notes)) {
        const res = await scanDistro(g, distro, now);
        const tag = "wsl:" + distro;
        const list = finish(tag, res.items, salt);
        projects.push(...list);
        if (res.homesFailed) {
          notes.push({
            distro,
            code: "home-unreadable",
            text: distro + ": home folders unreadable"
          });
          continue;
        }
        if (res.unreadable) {
          notes.push({
            distro,
            code: "home-unreadable",
            text:
              distro +
              ": " +
              res.unreadable +
              " home folder" +
              (res.unreadable > 1 ? "s" : "") +
              " unreadable"
          });
        }
        if (res.truncated) {
          notes.push({ distro, code: "truncated", text: distro + ": list truncated" });
        }
        if (!list.length) {
          notes.push({ distro, code: "no-projects", text: distro + ": no Claude Code projects" });
        }
      }
    } catch {
      notes.push(failureNote(null));
    }
  }
}

/**
 * A discoverer that shares work: calls made while a scan runs get that one scan; a finished
 * result is reused for ttlMs; invalidate() drops it (a scan already running is not kept).
 * A timed-out or failed scan is never reused. Callers must not change the returned object.
 * @param {object} baseOpts  options for discoverClaudeProjects
 * @param {{ttlMs?: number, now?: () => number}} [cfg]
 */
function makeDiscoverer(baseOpts, { ttlMs = 5000, now = Date.now } = {}) {
  let inflight = null;
  let cached = null;
  let generation = 0;
  return {
    discover() {
      // a clock that went backwards (negative age) must not keep a result alive
      const age = cached ? now() - cached.at : -1;
      if (cached && age >= 0 && age < ttlMs) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      const mine = generation;
      const p = discoverClaudeProjects(baseOpts).then(
        (value) => {
          if (inflight === p) inflight = null;
          const timedOut = value.notes.some((n) => n.code === "discovery-timeout");
          if (mine === generation && !timedOut) cached = { value, at: now() };
          return value;
        },
        (err) => {
          if (inflight === p) inflight = null;
          throw err;
        }
      );
      inflight = p;
      return p;
    },
    invalidate() {
      generation++;
      cached = null;
      inflight = null;
    }
  };
}

/** The result without any path: what may leave the process. */
function publicView(result) {
  return {
    projects: result.projects.map((p) => ({
      id: p.id,
      label: p.label,
      sourceTag: p.sourceTag,
      mtime: p.mtime
    })),
    notes: result.notes.map((n) => {
      const o = { code: n.code, text: n.text };
      return n.distro ? { distro: n.distro, ...o } : o;
    })
  };
}

/** Public body for /api/projects in Claude Code mode. */
function toProjectsResponse(result) {
  return { source: "claude-code", ...publicView(result) };
}

/** Public body for /api/status in Claude Code mode. */
function toStatusResponse(result) {
  const v = publicView(result);
  return { source: "claude-code", projectCount: v.projects.length, notes: v.notes };
}

/** Public body for /api/events in Claude Code mode: parser rows (already path-free) plus notes. */
function toEventsResponse(result, events = []) {
  return {
    source: "claude-code",
    events: events.map((e) => ({ ...e })),
    notes: publicView(result).notes
  };
}

module.exports = {
  discoverClaudeProjects,
  makeDiscoverer,
  publicView,
  toProjectsResponse,
  toStatusResponse,
  toEventsResponse,
  defaultRunWsl,
  makeRunWsl,
  // exported for tests
  decodeLines,
  hashLabel,
  loadOrCreateSalt,
  resolveSaltDir,
  READ_BYTES,
  READ_LINES,
  MAX_CONCURRENCY,
  MAX_DIR_ENTRIES
};
