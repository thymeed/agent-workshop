/**
 * Claude Code mode for the live bridge: discovery, the server-side id -> folder map and the
 * selected project. Every body this module returns is built from the public helpers in
 * lib/claude-code-sources.js, so no folder path, home path or username can leave through it.
 * Absolute folders stay in the private `paths` map and are never returned.
 */
"use strict";

const {
  makeDiscoverer,
  toProjectsResponse,
  toStatusResponse,
  toEventsResponse
} = require("./claude-code-sources");
const history = require("./claude-code-history");

const FAILED = {
  projects: [],
  notes: [{ code: "discovery-failed", text: "Discovery failed" }]
};

const NO_SELECTION = { status: 409, body: { ok: false, error: "No project selected" } };
/** {status, body} of a history answer: the answer itself, or a refusal cut to its fixed text. */
const answer = (/** @type {any} */ r) =>
  r.ok ? { status: 200, body: r } : { status: r.status, body: { ok: false, error: r.error } };

/**
 * @param {{salt: Buffer, saltNote?: {code: string, text: string}|null, discover?: Record<string, any>, ttlMs?: number}} cfg
 *   `discover` is the injectable bag (platform, homedir, fs, runWsl, now, timeoutMs).
 */
function createClaudeCodeMode(cfg) {
  const discoverOpts = cfg.discover || {};
  const saltNote = cfg.saltNote || null;
  const discoverer = makeDiscoverer(
    { ...discoverOpts, salt: cfg.salt },
    { ttlMs: cfg.ttlMs, now: discoverOpts.now }
  );
  /** id -> {label, path} from the LAST discovery. The path is never serialised. */
  let known = new Map();
  let loaded = false;
  /** @type {{id: string, label: string, path: string}|null} */
  let selected = null;

  /** One discovery result (shared, never mutated) as a fresh object with the salt note added. */
  async function load() {
    let result;
    try {
      result = await discoverer.discover();
    } catch {
      result = FAILED;
    }
    known = new Map(result.projects.map((p) => [p.id, { label: p.label, path: p.path }]));
    loaded = true;
    return {
      projects: result.projects,
      notes: saltNote ? [...result.notes, { ...saltNote }] : result.notes
    };
  }

  return {
    invalidate() {
      discoverer.invalidate();
    },
    /** The selected project's private folder, for the ingest only. Never serialise it. */
    projectDir() {
      return selected ? selected.path : null;
    },
    selection() {
      return selected ? { id: selected.id, label: selected.label } : { id: null, label: null };
    },
    async projectsBody() {
      return toProjectsResponse(await load());
    },
    async statusBody() {
      return toStatusResponse(await load());
    },
    async eventsBody(list) {
      return toEventsResponse(await load(), list);
    },
    /**
     * Older sessions of the selected project (read-only): {status, body}. No selection is a
     * path-free 409; the folder never appears in a body.
     */
    sessionsBody() {
      if (!selected) return NO_SELECTION;
      const r = history.listSessions(selected.path, { salt: cfg.salt, now: discoverOpts.now });
      return answer(r);
    },
    /** One older session of the selected project by its opaque id: {status, body}. */
    sessionBody(id) {
      if (!selected) return NO_SELECTION;
      const r = history.loadSession(selected.path, id, { salt: cfg.salt, now: discoverOpts.now });
      return answer(r);
    },
    /**
     * Select by id from the last discovery (one is run when there is none yet).
     * `canApply` is checked after any discovery wait, right before the selection is stored.
     */
    async select(id, canApply) {
      if (typeof id !== "string" || !id) return { ok: false };
      if (!loaded) await load();
      const proj = known.get(id);
      if (!proj) return { ok: false };
      if (canApply && !canApply()) return { ok: false };
      selected = { id, label: proj.label, path: proj.path };
      return { ok: true };
    }
  };
}

module.exports = { createClaudeCodeMode };
