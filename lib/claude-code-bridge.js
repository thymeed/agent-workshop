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

const FAILED = {
  projects: [],
  notes: [{ code: "discovery-failed", text: "Discovery failed" }]
};

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
