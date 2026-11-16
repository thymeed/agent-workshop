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
 *   (loadOrCreateSalt) so short labels cannot be reversed by guessing names. The salt is
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

/**
 * The per-install label salt: label-salt.bin in `dir`, 16 random bytes, written to a temp name
 * and renamed, mode 0600. Missing, short or long file: a new one. Unreadable or unwritable:
 * a random in-memory salt and a "labels-unstable" note. Never a fixed fallback.
 * @returns {{salt: Buffer, note?: {code: string, text: string}}}
 */
function loadOrCreateSalt({ dir, fs = nodeFs } = {}) {
  const file = dir ? path.join(dir, SALT_FILE) : "";
  try {
    const have = fs.readFileSync(file);
    if (validSalt(have)) return { salt: Buffer.from(have) };
  } catch {
    // missing or unreadable: make a new one
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
  try {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // the write below reports the real problem
    }
    fs.writeFileSync(tmp, salt, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    return { salt };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    return { salt, note: { code: "labels-unstable", text: "Labels change after restart" } };
  }
}

/**
 * wsl.exe runner built on an execFile implementation: no shell, only the two allowed argument
 * lists, and the full System32 path (not a PATH lookup). `opts.env` is read at each call.
 */
function makeRunWsl(execFileImpl, opts = {}) {
  return function runWsl(args) {
    const env = opts.env || process.env;
    const exe = path.win32.join(env.SystemRoot || "C:" + BS + "Windows", "System32", "wsl.exe");
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
  if (segs.length >= 2 && /^(home|users|documents and settings)$/i.test(segs[segs.length - 2])) {
    return true;
  }
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
function readCwd(fs, file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(READ_BYTES);
    const n = fs.readSync(fd, buf, 0, READ_BYTES, 0);
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
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
  return "";
}

/**
 * Candidate projects under one projects root (a folder holding a top-level .jsonl). Only stats
 * are done here; the cwd is read later, and only for projects that survive the cap.
 * `join` builds child paths in the root's style.
 * status: "ok" | "missing" (no such folder) | "error" (could not be read).
 */
function readProjectsRoot(fs, root, join, now) {
  let names;
  try {
    names = fs.readdirSync(root).map(entryName).filter(Boolean);
  } catch (e) {
    return { status: isMissing(e) ? "missing" : "error", items: [] };
  }
  const items = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let newest = null;
      for (const f of fs.readdirSync(dir).map(entryName)) {
        if (!f || !f.endsWith(".jsonl")) continue;
        const file = join(dir, f);
        const fst = fs.lstatSync(file);
        if (!fst.isFile() || fst.isSymbolicLink()) continue;
        const mtime = Math.min(Number(fst.mtimeMs) || 0, now());
        if (!newest || mtime > newest.mtime) newest = { file, mtime };
      }
      if (!newest) continue;
      items.push({ dir, name, mtime: newest.mtime, file: newest.file });
    } catch {
      // one unreadable project folder is skipped
    }
  }
  return { status: "ok", items };
}

/**
 * The per-source cap: newest transcript first (ties by folder path, so the result does not
 * depend on directory order), keep MAX_PROJECTS, then read the cwd of the survivors only.
 * `truncated` is true only when a real project exists past the cap.
 */
function selectNewest(fs, items) {
  const sorted = items
    .slice()
    .sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return {
    truncated: sorted.length > MAX_PROJECTS,
    items: sorted.slice(0, MAX_PROJECTS).map((it) => ({ ...it, cwd: readCwd(fs, it.file) }))
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
function scanDistro(fs, distro, now) {
  const out = { items: [], truncated: false, unreadable: 0, homesFailed: false };
  const roots = [
    wslJoin(BS + BS + "wsl.localhost", distro, "home"),
    wslJoin(BS + BS + "wsl$", distro, "home")
  ];
  let homeRoot = "";
  let homes = null;
  for (const r of roots) {
    try {
      homes = fs.readdirSync(r).map(entryName).filter(Boolean);
      homeRoot = r;
      break;
    } catch {
      // try the next spelling
    }
  }
  if (!homes) {
    out.homesFailed = true;
    return out;
  }
  homes.sort(); // plain code-unit order: the first MAX_HOMES are the same on every run
  if (homes.length > MAX_HOMES) {
    out.truncated = true;
    homes = homes.slice(0, MAX_HOMES);
  }
  const all = [];
  for (const h of homes) {
    const home = wslJoin(homeRoot, h);
    try {
      const st = fs.lstatSync(home);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch {
      out.unreadable++;
      continue;
    }
    const res = readProjectsRoot(fs, wslJoin(home, ".claude", "projects"), wslJoin, now);
    if (res.status === "error") out.unreadable++;
    for (const it of res.items) all.push(it);
  }
  const sel = selectNewest(fs, all);
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
 * @param {{salt?: Buffer, platform?: string, homedir?: string, fs?: any, runWsl?: Function, now?: () => number}} [opts]
 * @returns {Promise<{projects: Array<{id: string, label: string, sourceTag: string, mtime: number, path: string}>, notes: Array<{distro?: string, code: string, text: string}>}>}
 */
async function discoverClaudeProjects(opts = {}) {
  const platform = opts.platform || process.platform;
  const fs = opts.fs || nodeFs;
  const runWsl = opts.runWsl || defaultRunWsl;
  const now = opts.now || Date.now;
  const salt = validSalt(opts.salt) ? opts.salt : getProcessSalt();
  const notes = [];
  const projects = [];
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
      const res = readProjectsRoot(fs, root, join, now);
      const sel = selectNewest(fs, res.items);
      projects.push(...finish(tag, sel.items, salt));
      if (res.status === "error") {
        notes.push({ code: "home-unreadable", text: label + ": projects folder unreadable" });
      } else if (!sel.items.length) {
        notes.push({ code: "no-projects", text: label + ": no Claude Code projects" });
      }
      if (sel.truncated) notes.push({ code: "truncated", text: label + ": list truncated" });
    }
  } catch {
    notes.push({ code: "home-unreadable", text: label + ": projects folder unreadable" });
  }

  if (isWin) {
    try {
      for (const distro of await listRunningDistros(runWsl, notes)) {
        const res = scanDistro(fs, distro, now);
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

  projects.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
  if (projects.length > MAX_TOTAL) {
    projects.length = MAX_TOTAL;
    notes.push({ code: "truncated", text: "Projects: list truncated" });
  }
  return { projects, notes };
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
  READ_BYTES,
  READ_LINES
};
