/**
 * Cursor Agents · Replay → stage adapter
 * Maps history events → live-shaped stage events (shared applyLiveEvent engine).
 * window.ReplayStage.mapHistoryEvent / seek / applyOne
 */
(function (global) {
  "use strict";

  function roleFromHistory(ev) {
    if (!ev) return "opus";
    var name = String(ev.name || "").toLowerCase();
    var model = String(ev.model || "").toLowerCase();
    var agentId = String(ev.agentId || "").toLowerCase();
    if (
      name.indexOf("advisor") >= 0 ||
      model.indexOf("fable") >= 0 ||
      agentId.indexOf("advisor") >= 0
    ) {
      return "advisor";
    }
    if (
      name.indexOf("worker") >= 0 ||
      model.indexOf("sonnet") >= 0 ||
      agentId.indexOf("worker") >= 0
    ) {
      return "worker";
    }
    if (name.indexOf("research") >= 0 || agentId.indexOf("research") >= 0) {
      return "researcher";
    }
    if (
      name.indexOf("explor") >= 0 ||
      model.indexOf("haiku") >= 0 ||
      agentId.indexOf("explor") >= 0
    ) {
      return "explorer";
    }
    if (name.indexOf("parent") >= 0 || model.indexOf("opus") >= 0 || agentId.indexOf("parent") >= 0) {
      return "opus";
    }
    return "opus";
  }

  function liveRole(cardRole) {
    return cardRole === "opus" ? "parent" : cardRole;
  }

  function modelForRole(cardRole, model) {
    var m = String(model || "").toLowerCase();
    if (m.indexOf("fable") >= 0) return "fable";
    if (m.indexOf("sonnet") >= 0) return "sonnet";
    if (m.indexOf("haiku") >= 0) return "haiku";
    if (m.indexOf("opus") >= 0) return "opus";
    if (cardRole === "advisor") return "fable";
    if (cardRole === "worker") return "sonnet";
    if (cardRole === "explorer" || cardRole === "researcher") return "haiku";
    return "opus";
  }

  /**
   * historyEvent → one or more live-shaped events for applyLiveEvent.
   */
  function mapHistoryEvent(ev) {
    if (!ev) return [];
    var cardRole = roleFromHistory(ev);
    var role = liveRole(cardRole);
    var type = String(ev.type || "").toLowerCase();
    var name = ev.name || ev.agentId || cardRole;
    var model = modelForRole(cardRole, ev.model);
    var ts = ev.ts || null;
    var out = [];

    if (type === "spawn") {
      var spawnEv = {
        role: role,
        active: [cardRole],
        message: "Spawn · " + name + " · " + model,
        ts: ts,
        source: ev.agentId || ""
      };
      if (ev.parentId) {
        spawnEv.route = "delegates";
        spawnEv.routeTo = cardRole;
        spawnEv.kind = "delegates";
      }
      out.push(spawnEv);
      return out;
    }

    if (type === "turn") {
      var turnEv = {
        role: role,
        active: [cardRole],
        message: "Turn · " + name,
        ts: ts,
        usage: {
          model: model,
          role: role === "parent" ? "opus" : role,
          in: Number(ev.inputTokens) || 0,
          out: Number(ev.outputTokens) || 0
        }
      };
      if (Array.isArray(ev.files) && ev.files.length) {
        var path = String(ev.files[0] || "");
        var kind =
          cardRole === "worker" || /\.(js|ts|css|html|md)$/i.test(path) ? "edit" : "read";
        if (cardRole === "explorer" || cardRole === "researcher") kind = "read";
        if (cardRole === "worker") kind = "edit";
        turnEv.activity = {
          kind: kind,
          path: path,
          detail: ev.files.length > 1 ? "+" + (ev.files.length - 1) + " files" : ""
        };
      }
      out.push(turnEv);
      return out;
    }

    if (type === "done") {
      out.push({
        role: role,
        active: [cardRole],
        message: "Done · " + name,
        ts: ts,
        replayDone: true
      });
      return out;
    }

    if (type === "error") {
      out.push({
        role: role,
        active: [cardRole],
        message: "Error · " + (ev.message || name),
        ts: ts,
        replayError: true
      });
      return out;
    }

    out.push({
      role: role,
      active: [cardRole],
      message: type + " · " + name,
      ts: ts
    });
    return out;
  }

  /**
   * @param {object} api stage bridge from app.js
   * @param {object} historyEv
   * @param {object} [opts] { skipTiming, skipMotion, replay }
   */
  function applyOne(api, historyEv, opts) {
    opts = opts || {};
    if (!api || typeof api.applyLiveEvent !== "function") return;
    var mapped = mapHistoryEvent(historyEv);
    mapped.forEach(function (liveEv) {
      if (opts.skipMotion) liveEv.route = null;
      api.applyLiveEvent(liveEv, {
        replay: true,
        skipTiming: !!opts.skipTiming,
        skipMotion: !!opts.skipMotion || !!opts.skipTiming
      });
    });
  }

  /**
   * Rebuild stage from events[0..index] (inclusive).
   */
  function seek(api, events, index, opts) {
    opts = opts || {};
    if (!api) return;
    var list = Array.isArray(events) ? events : [];
    var max = Math.max(-1, Math.min(list.length - 1, Number(index)));
    if (typeof api.resetReplay === "function") api.resetReplay();
    if (max < 0) return;
    var reduced =
      opts.prefersReducedMotion ||
      (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    for (var i = 0; i <= max; i++) {
      applyOne(api, list[i], {
        skipTiming: true,
        skipMotion: true,
        reduced: reduced
      });
    }
  }

  global.ReplayStage = {
    roleFromHistory: roleFromHistory,
    mapHistoryEvent: mapHistoryEvent,
    applyOne: applyOne,
    seek: seek
  };
})(typeof window !== "undefined" ? window : globalThis);
