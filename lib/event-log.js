/**
 * Local JSONL event log for bridge history (profile/app-data, never the repo).
 * Redacts secrets before write; 30-day retention with prune-on-start.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LOG_FILENAME = "event-log.jsonl";
const EVENT_TYPES = new Set(["spawn", "turn", "done", "error"]);
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** @param {string} key */
function isSensitiveFieldName(key) {
  return /token|secret|password|passwd|api.?key|private.?key|authorization|cookie/i.test(
    String(key)
  );
}

function usePosixLogPermissions() {
  return process.platform !== "win32";
}

/**
 * Replace secret material in a string. Each matcher returns the redacted string.
 * Patterns cover API keys, tokens, passwords, and bearer secrets.
 */
function redactString(text) {
  let out = String(text);
  out = out.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]");
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  out = out.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]");
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[REDACTED]"
  );
  out = out.replace(/([?&])(token|key)=([^&\s"'#]+)/gi, "$1$2=[REDACTED]");
  out = out.replace(
    /"(password|passwd|secret|token|api[_-]?key|access[_-]?token|auth[_-]?token)"\s*:\s*"[^"]*"/gi,
    '"$1": "[REDACTED]"'
  );
  out = out.replace(
    /\b(api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|password|passwd|pwd|secret|client[_-]?secret)\s*[:=]\s*["']?[^\s"'&,;]+/gi,
    (m) => m.replace(/([:=]\s*["']?).+$/i, "$1[REDACTED]")
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  out = out.replace(/\bAuthorization\s*[:=]\s*["']?Bearer\s+[^\s"'&,;]+/gi, (m) =>
    m.replace(/Bearer\s+\S+/i, "Bearer [REDACTED]")
  );
  out = out.replace(/\bAuthorization\s*[:=]\s*["']?(?!Bearer\b)[^\s"'&,;]+/gi, (m) =>
    m.replace(/([:=]\s*["']?).+$/i, "$1[REDACTED]")
  );
  /* Signed-URL and presigned-query parameters, incl. AWS X-Amz-*. */
  out = out.replace(
    /([?&](?:X-Amz-(?:Signature|Credential|Security-Token|SignedHeaders)|Signature|Sig|SharedAccessSignature|Code|Session|SessionId|SAS))=[^&\s"'#]*/gi,
    "$1=[REDACTED]"
  );
  out = out.replace(/\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED]");
  out = out.replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@");
  return out;
}

/**
 * Resolve a writable app-data directory for the event log.
 * Override with CURSOR_EVENT_LOG_DIR or opts.logDir (tests).
 */
function resolveLogDir(opts) {
  opts = opts || {};
  if (opts.logDir) return path.resolve(opts.logDir);
  if (process.env.CURSOR_EVENT_LOG_DIR) {
    return path.resolve(process.env.CURSOR_EVENT_LOG_DIR);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, "cursor-agents-model-routing");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "cursor-agents-model-routing");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "cursor-agents-model-routing");
}

function resolveLogPath(opts) {
  opts = opts || {};
  if (opts.logPath) return path.resolve(opts.logPath);
  if (process.env.CURSOR_EVENT_LOG) return path.resolve(process.env.CURSOR_EVENT_LOG);
  return path.join(resolveLogDir(opts), LOG_FILENAME);
}

/**
 * Redact anything that looks like an API key, token, password, or bearer secret.
 * Works on strings; recursively walks objects/arrays.
 * @param {*} value
 * @returns {*}
 */
function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveFieldName(k)) {
        out[k] = typeof v === "string" && v.length ? "[REDACTED]" : redactSecrets(v);
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function clampNonNegInt(n) {
  const x = Math.round(Number(n) || 0);
  if (!Number.isFinite(x) || x < 0) return 0;
  return x;
}

/**
 * Normalize to the shared history event contract.
 * @param {Partial<import("../types/events").HistoryEvent>} partial
 * @returns {import("../types/events").HistoryEvent|null}
 */
function normalizeEvent(partial) {
  if (!partial || typeof partial !== "object") return null;
  const type = String(partial.type || "");
  if (!EVENT_TYPES.has(type)) return null;
  const ts =
    partial.ts && !Number.isNaN(Date.parse(partial.ts))
      ? new Date(partial.ts).toISOString()
      : new Date().toISOString();
  const files = Array.isArray(partial.files)
    ? partial.files.map((f) => String(f || "")).filter(Boolean)
    : [];
  const parentId =
    partial.parentId == null || partial.parentId === "" ? null : String(partial.parentId);
  return {
    ts,
    sessionId: String(partial.sessionId || ""),
    agentId: String(partial.agentId || ""),
    parentId,
    name: String(partial.name || ""),
    model: String(partial.model || ""),
    /* Raw Cursor model slug when a delegation pinned one (claude-haiku-5-5-thinking-high).
       Empty when the child inherited the parent's route or the line named no model.
       Separate from `model`, which stays the billable bucket. */
    modelRaw: String(partial.modelRaw || ""),
    type: /** @type {import("../types/events").HistoryEventType} */ (type),
    inputTokens: clampNonNegInt(partial.inputTokens),
    outputTokens: clampNonNegInt(partial.outputTokens),
    files
  };
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (usePosixLogPermissions()) {
    fs.mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function secureLogDir(dir, logPath) {
  if (!usePosixLogPermissions()) return;
  try {
    if (!fs.existsSync(dir)) return;
    /* Only narrow a directory that holds nothing but this log. A path override
       (CURSOR_EVENT_LOG_DIR) can point at a shared directory such as $HOME, and
       chmod-ing that would restrict unrelated data. */
    const foreign = fs.readdirSync(dir).filter((name) => path.join(dir, name) !== logPath);
    if (foreign.length > 0) return;
    fs.chmodSync(dir, LOG_DIR_MODE);
  } catch (_e) {
    /* ignore chmod failures */
  }
}

function secureLogFile(filePath) {
  if (!usePosixLogPermissions()) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, LOG_FILE_MODE);
    }
  } catch (_e) {
    /* ignore chmod failures */
  }
}

function writeLogBytes(filePath, data, append) {
  ensureParentDir(filePath);
  if (usePosixLogPermissions()) {
    if (append) {
      fs.appendFileSync(filePath, data, { encoding: "utf8", mode: LOG_FILE_MODE });
    } else {
      fs.writeFileSync(filePath, data, { encoding: "utf8", mode: LOG_FILE_MODE });
    }
    secureLogFile(filePath);
  } else if (append) {
    fs.appendFileSync(filePath, data, "utf8");
  } else {
    fs.writeFileSync(filePath, data, "utf8");
  }
}

/**
 * @param {{logDir?:string, logPath?:string, retentionMs?:number}} [opts]
 */
function createEventLog(opts) {
  opts = opts || {};
  const logPath = resolveLogPath(opts);
  const retentionMs = opts.retentionMs != null ? Number(opts.retentionMs) : RETENTION_MS;
  let prunedOnStart = false;

  function readAllRaw() {
    if (!fs.existsSync(logPath)) return [];
    let text;
    try {
      text = fs.readFileSync(logPath, "utf8");
    } catch (_e) {
      return [];
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch (_e) {
        /* skip corrupt lines */
      }
    }
    return out;
  }

  function writeAll(events) {
    const body = events.map((e) => JSON.stringify(e)).join("\n");
    writeLogBytes(logPath, body ? body + "\n" : "", false);
  }

  /**
   * Drop events older than retention window. Safe to call repeatedly.
   * @returns {{kept:number, removed:number}}
   */
  function prune() {
    const cutoff = Date.now() - retentionMs;
    const all = readAllRaw();
    const kept = [];
    let removed = 0;
    for (const ev of all) {
      const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
      if (!Number.isFinite(t) || t < cutoff) {
        removed += 1;
        continue;
      }
      kept.push(ev);
    }
    if (removed > 0 || !fs.existsSync(logPath)) {
      writeAll(kept);
    }
    return { kept: kept.length, removed };
  }

  /** Prune once on first use after create (start). */
  function ensureStarted() {
    if (prunedOnStart) return;
    prunedOnStart = true;
    ensureParentDir(logPath);
    secureLogDir(path.dirname(logPath), logPath);
    try {
      prune();
    } catch (_e) {
      /* ignore prune failures on start */
    }
  }

  /**
   * Append one history event (redacted + normalized) to JSONL.
   * @returns {object|null} the written event
   */
  function append(partial) {
    ensureStarted();
    const redacted = redactSecrets(partial);
    const ev = normalizeEvent(redacted);
    if (!ev) return null;
    writeLogBytes(logPath, JSON.stringify(ev) + "\n", true);
    return ev;
  }

  /**
   * Query persisted events.
   * @param {{since?:string, session?:string, sessionId?:string, limit?:number}} [filter]
   * @returns {object[]}
   */
  function query(filter) {
    ensureStarted();
    filter = filter || {};
    const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
    const session = filter.session != null ? filter.session : filter.sessionId;
    const sessionFilter = session != null && session !== "" ? String(session) : null;
    const all = readAllRaw();
    const matched = all.filter((ev) => {
      if (!ev || typeof ev !== "object") return false;
      if (sessionFilter != null && String(ev.sessionId || "") !== sessionFilter) return false;
      if (Number.isFinite(sinceMs)) {
        const t = Date.parse(ev.ts);
        if (!Number.isFinite(t) || t < sinceMs) return false;
      }
      return true;
    });
    /* Keep the newest N so a long session cannot push an unbounded payload into the
       dashboard's replay list. The log itself keeps everything. */
    const limit = Number(filter.limit);
    if (Number.isFinite(limit) && limit > 0 && matched.length > limit) {
      return matched.slice(matched.length - limit);
    }
    return matched;
  }

  /** Delete all history. */
  function clear() {
    writeLogBytes(logPath, "", false);
    return { ok: true };
  }

  function getLogPath() {
    return logPath;
  }

  return {
    append,
    query,
    clear,
    prune,
    getLogPath,
    ensureStarted
  };
}

module.exports = {
  createEventLog,
  redactSecrets,
  normalizeEvent,
  resolveLogDir,
  resolveLogPath,
  RETENTION_DAYS,
  RETENTION_MS,
  EVENT_TYPES,
  LOG_FILENAME,
  LOG_DIR_MODE,
  LOG_FILE_MODE,
  isSensitiveFieldName
};
