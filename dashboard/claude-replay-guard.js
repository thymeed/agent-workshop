/**
 * Claude Code History replay guard. While a replay of an older session owns the stage, the Live
 * state it overwrites is kept as a snapshot and the Live rows that arrive meanwhile are queued
 * in arrival order. end() is the only way the replay stops owning the stage: it puts the
 * snapshot back and then applies the queued rows through the normal Live path. No DOM and no
 * app state in here: loaded before app.js, exposes window.ClaudeReplayGuard, unit tested in
 * test/unit/claude-replay-guard.test.js.
 *
 * Past the queue cap the queue is dropped and an overflow flag is set; end() then asks the page
 * to rebuild Live from the bridge (deps.rebuild) instead of restoring and applying rows.
 */
(function (global) {
  "use strict";

  var DEFAULT_CAP = 20000;

  /**
   * @param {object} deps
   *   capture() -> snapshot of the Live state a replay is about to overwrite
   *   restore(snapshot) -> put it back
   *   applyQueued(row) -> apply one queued Live row (quietly: no sound, ship or timing)
   *   rebuild() -> rebuild Live from the bridge (queue overflow)
   *   cap -> most rows queued (default 20000)
   */
  function create(deps) {
    var cap = deps.cap > 0 ? Math.floor(deps.cap) : DEFAULT_CAP;
    var snap = null;
    var queue = [];
    var overflow = false;
    var counts = { taken: 0, restored: 0, discarded: 0, rebuilt: 0, applied: 0 };

    function discard() {
      snap = null;
      queue = [];
      overflow = false;
    }

    return {
      /** A replay takes the stage: keep the Live state once (a second call keeps the first). */
      take: function () {
        if (snap) return false;
        snap = { state: deps.capture() };
        queue = [];
        overflow = false;
        counts.taken += 1;
        return true;
      },
      holding: function () {
        return snap !== null;
      },
      /** A Live row arrived while the replay owns the stage. True when the guard kept (or dropped past the cap) it. */
      offer: function (row) {
        if (!snap) return false;
        if (overflow) return true;
        if (queue.length >= cap) {
          overflow = true;
          queue = [];
          return true;
        }
        queue.push(row);
        return true;
      },
      /**
       * The replay stops owning the stage. Restores the snapshot, then applies the queued rows in
       * order. opts.discard throws both away instead (the stage is about to be rebuilt anyway).
       * Returns true when a replay was held.
       */
      end: function (opts) {
        if (!snap) return false;
        var held = snap;
        var rows = queue;
        var over = overflow;
        discard();
        if (opts && opts.discard) {
          counts.discarded += 1;
          return true;
        }
        if (over) {
          counts.rebuilt += 1;
          deps.rebuild();
          return true;
        }
        counts.restored += 1;
        deps.restore(held.state);
        rows.forEach(function (row) {
          counts.applied += 1;
          deps.applyQueued(row);
        });
        return true;
      },
      info: function () {
        return {
          holding: snap !== null,
          queued: queue.length,
          overflow: overflow,
          taken: counts.taken,
          restored: counts.restored,
          discarded: counts.discarded,
          rebuilt: counts.rebuilt,
          applied: counts.applied
        };
      }
    };
  }

  global.ClaudeReplayGuard = { create: create, DEFAULT_CAP: DEFAULT_CAP };
})(typeof window !== "undefined" ? window : globalThis);
