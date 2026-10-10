/**
 * Cursor Agents · Insights panel
 * Self-contained: window.Insights.init(containerEl, { demo })
 * Demo loads test/fixtures/history-demo.json (with inlined fallback).
 * Live fetches GET /api/history?since=&session=
 */
(function (global) {
  "use strict";

  /* —— Single configurable price table + spend limit —— */
  var CONFIG = {
    /** USD per 1M tokens */
    prices: {
      opus: { in: 4.0, out: 20.0 },
      fable: { in: 10.0, out: 50.0 },
      sonnet: { in: 2.0, out: 10.0 },
      haiku: { in: 0.1, out: 0.5 },
      auto: { in: 1.0, out: 5.0 }
    },
    /** Soft monthly spend cap used for forecast projection */
    limitUsd: 50,
    /** Models ranked cheapest → dearest (for suggestions / what-if) */
    cheaperOrder: ["auto", "haiku", "sonnet", "opus", "fable"],
    /** Basename used when resolving demo fixture URLs from the page location */
    fixtureName: "history-demo.json"
  };

  var DEMO_HISTORY = {
    events: [
      {
        ts: "2026-10-09T14:00:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-parent",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:00:05.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-parent",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "turn",
        inputTokens: 18000,
        outputTokens: 4200,
        files: ["dashboard/app.js"]
      },
      {
        ts: "2026-10-09T14:00:20.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-advisor",
        parentId: "agent-parent",
        name: "Advisor",
        model: "fable",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:00:35.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-advisor",
        parentId: "agent-parent",
        name: "Advisor",
        model: "fable",
        type: "turn",
        inputTokens: 12000,
        outputTokens: 3800,
        files: []
      },
      {
        ts: "2026-10-09T14:00:50.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-advisor",
        parentId: "agent-parent",
        name: "Advisor",
        model: "fable",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:01:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-explorer",
        parentId: "agent-parent",
        name: "Explorer",
        model: "haiku",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:01:15.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-explorer",
        parentId: "agent-parent",
        name: "Explorer",
        model: "haiku",
        type: "turn",
        inputTokens: 420000,
        outputTokens: 18000,
        files: ["live-bridge.js", "README.md"]
      },
      {
        ts: "2026-10-09T14:01:40.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-explorer",
        parentId: "agent-parent",
        name: "Explorer",
        model: "haiku",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:02:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-researcher",
        parentId: "agent-parent",
        name: "Researcher",
        model: "sonnet",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:02:20.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-researcher",
        parentId: "agent-parent",
        name: "Researcher",
        model: "sonnet",
        type: "turn",
        inputTokens: 8500,
        outputTokens: 1200,
        files: ["package.json"]
      },
      {
        ts: "2026-10-09T14:02:35.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-researcher",
        parentId: "agent-parent",
        name: "Researcher",
        model: "sonnet",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:03:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-worker",
        parentId: "agent-parent",
        name: "Worker",
        model: "opus",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:03:25.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-worker",
        parentId: "agent-parent",
        name: "Worker",
        model: "opus",
        type: "turn",
        inputTokens: 22000,
        outputTokens: 9000,
        files: ["dashboard/styles.css"]
      },
      {
        ts: "2026-10-09T14:04:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-worker",
        parentId: "agent-parent",
        name: "Worker",
        model: "opus",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: ["dashboard/styles.css"]
      },
      {
        ts: "2026-10-09T14:04:30.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-parent",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "turn",
        inputTokens: 14000,
        outputTokens: 3500,
        files: []
      },
      {
        ts: "2026-10-09T14:05:00.000Z",
        sessionId: "sess-demo-01",
        agentId: "agent-parent",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T15:10:00.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-parent-2",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T15:10:10.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-parent-2",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "turn",
        inputTokens: 9000,
        outputTokens: 2100,
        files: []
      },
      {
        ts: "2026-10-09T15:10:30.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-scan",
        parentId: "agent-parent-2",
        name: "File scan",
        model: "fable",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T15:10:45.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-scan",
        parentId: "agent-parent-2",
        name: "File scan",
        model: "fable",
        type: "turn",
        inputTokens: 6000,
        outputTokens: 800,
        files: ["eslint.config.js"]
      },
      {
        ts: "2026-10-09T15:11:00.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-scan",
        parentId: "agent-parent-2",
        name: "File scan",
        model: "fable",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T15:11:20.000Z",
        sessionId: "sess-demo-02",
        agentId: "agent-parent-2",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      }
    ]
  };

  function normalizeModel(model) {
    var m = String(model || "")
      .toLowerCase()
      .trim();
    if (CONFIG.prices[m]) return m;
    if (m.indexOf("opus") >= 0) return "opus";
    if (m.indexOf("fable") >= 0 || m.indexOf("advisor") >= 0) return "fable";
    if (m.indexOf("sonnet") >= 0) return "sonnet";
    if (m.indexOf("haiku") >= 0) return "haiku";
    if (m.indexOf("auto") >= 0) return "auto";
    return "opus";
  }

  function costFor(model, inn, out) {
    var rates = CONFIG.prices[normalizeModel(model)] || CONFIG.prices.opus;
    return (Math.max(0, inn || 0) / 1e6) * rates.in + (Math.max(0, out || 0) / 1e6) * rates.out;
  }

  function formatMoney(n) {
    if (!isFinite(n)) return "$—";
    if (n < 0.01 && n > 0) return "$" + n.toFixed(4);
    return "$" + n.toFixed(2);
  }

  function formatTokens(n) {
    n = Math.round(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sortEvents(events) {
    return (events || []).slice().sort(function (a, b) {
      var ta = Date.parse(a.ts) || 0;
      var tb = Date.parse(b.ts) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.agentId || "").localeCompare(String(b.agentId || ""));
    });
  }

  function sessionIds(events) {
    var seen = {};
    var ids = [];
    sortEvents(events).forEach(function (ev) {
      var id = ev.sessionId || "unknown";
      if (!seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    });
    return ids;
  }

  function filterSession(events, sessionId) {
    if (!sessionId) return sortEvents(events);
    return sortEvents(events).filter(function (ev) {
      return ev.sessionId === sessionId;
    });
  }

  function usageByModel(events) {
    var usage = {};
    Object.keys(CONFIG.prices).forEach(function (k) {
      usage[k] = { in: 0, out: 0, cost: 0 };
    });
    (events || []).forEach(function (ev) {
      if (ev.type !== "turn") return;
      var m = normalizeModel(ev.model);
      if (!usage[m]) usage[m] = { in: 0, out: 0, cost: 0 };
      usage[m].in += ev.inputTokens || 0;
      usage[m].out += ev.outputTokens || 0;
    });
    Object.keys(usage).forEach(function (m) {
      usage[m].cost = costFor(m, usage[m].in, usage[m].out);
    });
    return usage;
  }

  function totalCost(events) {
    var u = usageByModel(events);
    return Object.keys(u).reduce(function (sum, m) {
      return sum + u[m].cost;
    }, 0);
  }

  function forecast(events, limitUsd) {
    var limit = limitUsd == null ? CONFIG.limitUsd : limitUsd;
    var sorted = sortEvents(events);
    var spend = totalCost(sorted);
    var first = sorted.length ? Date.parse(sorted[0].ts) : NaN;
    var last = sorted.length ? Date.parse(sorted[sorted.length - 1].ts) : NaN;
    var spanMs = isFinite(first) && isFinite(last) ? Math.max(last - first, 0) : 0;
    var spanDays = spanMs > 0 ? spanMs / 86400000 : 0;
    if (sorted.length && spanDays < 1) spanDays = 1;
    var usdPerDay = spanDays > 0 ? spend / spanDays : 0;
    var remaining = Math.max(0, limit - spend);
    var daysToLimit = usdPerDay > 0 ? remaining / usdPerDay : Infinity;
    var hitAt = null;
    if (isFinite(daysToLimit) && isFinite(last)) {
      hitAt = new Date(last + daysToLimit * 86400000).toISOString();
    }
    return {
      spend: spend,
      limit: limit,
      remaining: remaining,
      spanDays: spanDays,
      usdPerDay: usdPerDay,
      daysToLimit: daysToLimit,
      hitAt: hitAt,
      usage: usageByModel(sorted)
    };
  }

  function agentSummaries(events) {
    var byId = {};
    sortEvents(events).forEach(function (ev) {
      var id = ev.agentId || "unknown";
      if (!byId[id]) {
        byId[id] = {
          agentId: id,
          parentId: ev.parentId == null ? null : ev.parentId,
          name: ev.name || id,
          model: normalizeModel(ev.model),
          files: [],
          inputTokens: 0,
          outputTokens: 0,
          types: {},
          done: false,
          error: false
        };
      }
      var a = byId[id];
      if (ev.name) a.name = ev.name;
      if (ev.model) a.model = normalizeModel(ev.model);
      if (ev.parentId != null) a.parentId = ev.parentId;
      a.types[ev.type] = (a.types[ev.type] || 0) + 1;
      if (ev.type === "turn") {
        a.inputTokens += ev.inputTokens || 0;
        a.outputTokens += ev.outputTokens || 0;
      }
      if (ev.type === "done") a.done = true;
      if (ev.type === "error") a.error = true;
      (ev.files || []).forEach(function (f) {
        if (a.files.indexOf(f) < 0) a.files.push(f);
      });
    });
    return Object.keys(byId).map(function (k) {
      return byId[k];
    });
  }

  function routingSuggestions(events) {
    var agents = agentSummaries(events).filter(function (a) {
      return a.done || a.types.turn;
    });
    var out = [];
    agents.forEach(function (a) {
      var model = a.model;
      var cost = costFor(model, a.inputTokens, a.outputTokens);
      var readHeavy = a.files.length >= 1 && a.outputTokens < a.inputTokens * 0.15;
      var lightEdit =
        a.files.length <= 2 && a.inputTokens + a.outputTokens < 40000 && a.outputTokens < 12000;
      var lookUpOnly = /scan|explor|research|read|search/i.test(a.name || "");
      var suggestion = null;
      var reason = "";

      if (model === "fable" && (lookUpOnly || readHeavy || lightEdit)) {
        suggestion = lookUpOnly || readHeavy ? "haiku" : "sonnet";
        reason = lookUpOnly
          ? "Lookup-style agent on Fable — Haiku is enough for file scans."
          : readHeavy
            ? "Read-heavy turns with little output — cheaper model fits."
            : "Light edit volume — Sonnet or Auto could cover this.";
      } else if (model === "opus" && a.parentId && (lightEdit || readHeavy)) {
        suggestion = readHeavy ? "haiku" : "auto";
        reason = readHeavy
          ? "Child agent mostly reading — Haiku or Auto instead of Opus."
          : "Non-parent Opus on a small edit — Auto is a plausible fit.";
      } else if (model === "sonnet" && readHeavy && a.outputTokens < 2000) {
        suggestion = "haiku";
        reason = "Mostly input tokens, tiny output — Haiku is enough.";
      } else if (model === "opus" && !a.parentId && lightEdit && a.inputTokens < 12000) {
        suggestion = "auto";
        reason = "Short parent turn — Auto could have handled planning lightly.";
      }

      if (suggestion && suggestion !== model) {
        var altCost = costFor(suggestion, a.inputTokens, a.outputTokens);
        out.push({
          agentId: a.agentId,
          name: a.name,
          model: model,
          suggestion: suggestion,
          reason: reason,
          actualCost: cost,
          altCost: altCost,
          savings: Math.max(0, cost - altCost)
        });
      }
    });
    return out;
  }

  function whatIfScenarios(events) {
    var actual = totalCost(events);
    var agents = agentSummaries(events);
    function remapCost(mapper) {
      return agents.reduce(function (sum, a) {
        var m = mapper(a);
        return sum + costFor(m, a.inputTokens, a.outputTokens);
      }, 0);
    }
    return [
      { id: "actual", label: "As run", cost: actual },
      {
        id: "all-auto",
        label: "All Auto",
        cost: remapCost(function () {
          return "auto";
        })
      },
      {
        id: "all-haiku",
        label: "All Haiku",
        cost: remapCost(function () {
          return "haiku";
        })
      },
      {
        id: "cheap-children",
        label: "Parent Opus · children Haiku",
        cost: remapCost(function (a) {
          return a.parentId ? "haiku" : "opus";
        })
      },
      {
        id: "suggested",
        label: "Apply suggestions",
        cost: (function () {
          var map = {};
          routingSuggestions(events).forEach(function (s) {
            map[s.agentId] = s.suggestion;
          });
          return remapCost(function (a) {
            return map[a.agentId] || a.model;
          });
        })()
      }
    ];
  }

  function buildTreeAt(events, index) {
    var slice = sortEvents(events).slice(0, index + 1);
    var nodes = {};
    slice.forEach(function (ev) {
      var id = ev.agentId || "unknown";
      if (!nodes[id]) {
        nodes[id] = {
          agentId: id,
          parentId: ev.parentId == null ? null : ev.parentId,
          name: ev.name || id,
          model: normalizeModel(ev.model),
          state: "spawn",
          children: []
        };
      }
      var n = nodes[id];
      if (ev.name) n.name = ev.name;
      if (ev.model) n.model = normalizeModel(ev.model);
      if (ev.parentId != null) n.parentId = ev.parentId;
      if (ev.type === "spawn") n.state = "spawn";
      else if (ev.type === "turn") n.state = "active";
      else if (ev.type === "done") n.state = "done";
      else if (ev.type === "error") n.state = "error";
    });
    var roots = [];
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id];
      if (n.parentId && nodes[n.parentId]) nodes[n.parentId].children.push(n);
      else roots.push(n);
    });
    return { roots: roots, event: slice[slice.length - 1] || null, count: slice.length };
  }

  function renderTree(roots) {
    function walk(list, depth) {
      return list
        .map(function (n) {
          var pad = depth * 14;
          return (
            '<div class="insights-tree-node state-' +
            escapeHtml(n.state) +
            " model-" +
            escapeHtml(n.model) +
            '" style="padding-left:' +
            pad +
            'px">' +
            '<span class="insights-tree-name">' +
            escapeHtml(n.name) +
            "</span>" +
            '<span class="insights-tree-model">' +
            escapeHtml(n.model) +
            "</span>" +
            '<span class="insights-tree-state">' +
            escapeHtml(n.state) +
            "</span>" +
            "</div>" +
            walk(n.children || [], depth + 1)
          );
        })
        .join("");
    }
    if (!roots.length) return '<p class="insights-empty">No agents yet.</p>';
    return '<div class="insights-tree">' + walk(roots, 0) + "</div>";
  }

  function demoFixtureUrls() {
    var name = CONFIG.fixtureName || "history-demo.json";
    var urls = [];
    try {
      var pathName = (typeof location !== "undefined" && location.pathname) || "";
      var origin = (typeof location !== "undefined" && location.origin) || "";
      if (/\/test(\/|$)/.test(pathName)) {
        urls.push(new URL("fixtures/" + name, location.href).href);
      } else if (origin && origin !== "null") {
        urls.push(origin.replace(/\/$/, "") + "/test/fixtures/" + name);
      }
    } catch (_) {}
    return urls;
  }

  function useInlinedDemoHistory() {
    if (typeof location === "undefined") return false;
    if (location.protocol === "file:") return true;
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin || "");
  }

  async function loadDemoEvents() {
    /* file:// and the live bridge do not ship test/fixtures — use inlined copy */
    if (useInlinedDemoHistory()) {
      return DEMO_HISTORY.events.slice();
    }
    var urls = demoFixtureUrls();
    var i;
    for (i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i], { cache: "no-store" });
        if (res && res.ok) {
          var data = await res.json();
          if (data && Array.isArray(data.events)) return data.events;
        }
      } catch (_) {}
    }
    return DEMO_HISTORY.events.slice();
  }

  async function loadLiveEvents(opts) {
    var since = (opts && opts.since) || new Date(Date.now() - 7 * 86400000).toISOString();
    var session = (opts && opts.session) || "";
    var q = "/api/history?since=" + encodeURIComponent(since);
    if (session) q += "&session=" + encodeURIComponent(session);
    var res = await fetch(q, { cache: "no-store" });
    if (!res.ok) throw new Error("history " + res.status);
    var data = await res.json();
    return (data && data.events) || [];
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = String(html).trim();
    return t.content.firstChild;
  }

  function init(containerEl, opts) {
    if (!containerEl) throw new Error("Insights.init: containerEl required");
    opts = opts || {};
    var demo = !!opts.demo;
    var destroyed = false;
    var allEvents = [];
    var sessionId = "";
    var replayIndex = 0;
    var replayIndexListeners = [];
    var replayMountEl = null;
    var transportPlaying = false;
    var transportSpeed = 1;
    var transportTimer = null;
    var root = el(
      '<section class="insights-root" data-insights="1" aria-label="Insights">' +
        '<header class="insights-header">' +
        "<div>" +
        '<div class="insights-eyebrow">Cursor Agents · Insights</div>' +
        '<h2 class="insights-title">Cost, routing &amp; replay</h2>' +
        "</div>" +
        '<div class="insights-controls">' +
        '<label class="insights-session-label">Session ' +
        '<select class="insights-session" aria-label="Session"></select>' +
        "</label>" +
        '<span class="insights-mode-pill" data-mode></span>' +
        "</div>" +
        "</header>" +
        '<nav class="insights-tabs" role="tablist">' +
        '<button type="button" class="insights-tab on" data-tab="forecast" role="tab" aria-selected="true">Forecast</button>' +
        '<button type="button" class="insights-tab" data-tab="suggestions" role="tab" aria-selected="false">Suggestions</button>' +
        '<button type="button" class="insights-tab" data-tab="replay" role="tab" aria-selected="false">Replay</button>' +
        '<button type="button" class="insights-tab" data-tab="whatif" role="tab" aria-selected="false">What-if</button>' +
        "</nav>" +
        '<div class="insights-panels">' +
        '<div class="insights-panel on" data-panel="forecast" role="tabpanel"></div>' +
        '<div class="insights-panel" data-panel="suggestions" role="tabpanel" hidden></div>' +
        '<div class="insights-panel" data-panel="replay" role="tabpanel" hidden></div>' +
        '<div class="insights-panel" data-panel="whatif" role="tabpanel" hidden></div>' +
        "</div>" +
        '<p class="insights-status" data-status role="status"></p>' +
        "</section>"
    );

    containerEl.innerHTML = "";
    containerEl.appendChild(root);

    var statusEl = root.querySelector("[data-status]");
    var modePill = root.querySelector("[data-mode]");
    var sessionSelect = root.querySelector(".insights-session");
    modePill.textContent = demo ? "Demo" : "Live";
    modePill.classList.toggle("demo", demo);

    function setStatus(msg) {
      statusEl.textContent = msg || "";
    }

    function activeEvents() {
      return filterSession(allEvents, sessionId);
    }

    function fillSessions() {
      var ids = sessionIds(allEvents);
      sessionSelect.innerHTML = ids
        .map(function (id) {
          return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + "</option>";
        })
        .join("");
      if (!ids.length) {
        sessionSelect.innerHTML = '<option value="">No sessions</option>';
        sessionId = "";
        return;
      }
      if (ids.indexOf(sessionId) < 0) sessionId = ids[0];
      sessionSelect.value = sessionId;
    }

    function renderForecast() {
      var panel = root.querySelector('[data-panel="forecast"]');
      var period = forecast(allEvents);
      var sessionUsage = usageByModel(activeEvents());
      var rows = Object.keys(sessionUsage)
        .filter(function (m) {
          return sessionUsage[m].in + sessionUsage[m].out > 0;
        })
        .map(function (m) {
          var u = sessionUsage[m];
          return (
            '<tr class="model-' +
            escapeHtml(m) +
            '">' +
            "<td>" +
            escapeHtml(m) +
            "</td>" +
            "<td>" +
            formatTokens(u.in) +
            "</td>" +
            "<td>" +
            formatTokens(u.out) +
            "</td>" +
            "<td>" +
            formatMoney(u.cost) +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
      var hitLabel = !isFinite(period.daysToLimit)
        ? "No spend pace yet — cannot project limit."
        : period.remaining <= 0
          ? "Limit already reached at current tally."
          : "All sessions · avg " +
            formatMoney(period.usdPerDay) +
            "/day · limit (" +
            formatMoney(period.limit) +
            ") in ~" +
            (period.daysToLimit < 1
              ? (period.daysToLimit * 24).toFixed(1) + "h"
              : period.daysToLimit.toFixed(1) + "d") +
            (period.hitAt ? " · " + period.hitAt.replace("T", " ").replace(/\.\d+Z$/, "Z") : "");

      panel.innerHTML =
        '<div class="insights-forecast">' +
        '<div class="insights-kpi-row">' +
        '<div class="insights-kpi"><span>Period spend</span><strong data-forecast-spend>' +
        formatMoney(period.spend) +
        "</strong></div>" +
        '<div class="insights-kpi"><span>Limit</span><strong data-forecast-limit>' +
        formatMoney(period.limit) +
        "</strong></div>" +
        '<div class="insights-kpi"><span>Avg daily</span><strong data-forecast-pace>' +
        formatMoney(period.usdPerDay) +
        "/day</strong></div>" +
        "</div>" +
        '<p class="insights-forecast-note" data-forecast-hit data-forecast-scope="all-sessions">' +
        escapeHtml(hitLabel) +
        "</p>" +
        '<p class="insights-session-breakdown">Session breakdown' +
        (sessionId ? ": " + escapeHtml(sessionId) : "") +
        "</p>" +
        '<table class="insights-usage-table" data-forecast-table>' +
        "<thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>" +
        "<tbody>" +
        (rows || '<tr><td colspan="4">No turn usage yet.</td></tr>') +
        "</tbody></table>" +
        '<p class="insights-config-hint">Prices &amp; limit live in Insights CONFIG (limit ' +
        formatMoney(CONFIG.limitUsd) +
        ").</p>" +
        "</div>";
    }

    function renderSuggestions() {
      var panel = root.querySelector('[data-panel="suggestions"]');
      var list = routingSuggestions(activeEvents());
      if (!list.length) {
        panel.innerHTML =
          '<p class="insights-empty" data-suggestions-empty>No cheaper-route flags for this session.</p>';
        return;
      }
      panel.innerHTML =
        '<ul class="insights-suggest-list" data-suggestions-list>' +
        list
          .map(function (s) {
            return (
              "<li>" +
              '<div class="insights-suggest-head">' +
              "<strong>" +
              escapeHtml(s.name) +
              "</strong>" +
              '<span class="insights-badge from">' +
              escapeHtml(s.model) +
              "</span>" +
              '<span aria-hidden="true">→</span>' +
              '<span class="insights-badge to">' +
              escapeHtml(s.suggestion) +
              "</span>" +
              '<span class="insights-save">save ' +
              formatMoney(s.savings) +
              "</span>" +
              "</div>" +
              '<p class="insights-suggest-reason">' +
              escapeHtml(s.reason) +
              "</p>" +
              "</li>"
            );
          })
          .join("") +
        "</ul>";
    }

    function notifyReplayIndex(source) {
      var payload = {
        index: replayIndex,
        events: activeEvents().slice(),
        source: source || "scrub"
      };
      replayIndexListeners.forEach(function (cb) {
        try {
          cb(payload);
        } catch (_) {}
      });
    }

    function paintReplayInto(host, opts) {
      opts = opts || {};
      if (!host) return;
      var events = activeEvents();
      var max = Math.max(0, events.length - 1);
      if (replayIndex > max) replayIndex = max;
      var snap = buildTreeAt(events, replayIndex);
      var ev = snap.event;
      var showTransport = !!opts.transport;
      host.innerHTML =
        '<div class="insights-replay">' +
        (showTransport
          ? '<div class="insights-transport" data-transport>' +
            '<button type="button" class="insights-transport-btn" data-replay-play aria-pressed="false">Play</button>' +
            '<button type="button" class="insights-transport-btn" data-replay-pause>Pause</button>' +
            '<div class="insights-speed" role="group" aria-label="Replay speed">' +
            '<button type="button" data-speed="0.5" aria-pressed="false">0.5×</button>' +
            '<button type="button" data-speed="1" aria-pressed="true">1×</button>' +
            '<button type="button" data-speed="2" aria-pressed="false">2×</button>' +
            "</div>" +
            "</div>"
          : "") +
        '<div class="insights-scrubber-row">' +
        '<input type="range" class="insights-scrubber" data-scrubber min="0" max="' +
        max +
        '" value="' +
        replayIndex +
        '" aria-label="Session timeline" />' +
        '<span class="insights-scrubber-meta" data-scrubber-meta>' +
        (events.length ? replayIndex + 1 : 0) +
        " / " +
        events.length +
        "</span>" +
        "</div>" +
        '<p class="insights-replay-event" data-replay-event>' +
        (ev
          ? escapeHtml(ev.ts) +
            " · " +
            escapeHtml(ev.type) +
            " · " +
            escapeHtml(ev.name || ev.agentId) +
            " · " +
            escapeHtml(normalizeModel(ev.model))
          : "No events") +
        "</p>" +
        "<div data-replay-tree>" +
        renderTree(snap.roots) +
        "</div>" +
        "</div>";

      var scrubber = host.querySelector("[data-scrubber]");
      if (scrubber) {
        scrubber.addEventListener("input", function () {
          if (transportPlaying) pauseTransport();
          setReplayIndex(Number(scrubber.value) || 0, { source: "scrub", skipPaint: true });
          var next = buildTreeAt(events, replayIndex);
          var meta = host.querySelector("[data-scrubber-meta]");
          var eventEl = host.querySelector("[data-replay-event]");
          var treeEl = host.querySelector("[data-replay-tree]");
          if (meta)
            meta.textContent = (events.length ? replayIndex + 1 : 0) + " / " + events.length;
          if (eventEl && next.event) {
            eventEl.textContent =
              next.event.ts +
              " · " +
              next.event.type +
              " · " +
              (next.event.name || next.event.agentId) +
              " · " +
              normalizeModel(next.event.model);
          }
          if (treeEl) treeEl.innerHTML = renderTree(next.roots);
          syncScrubbers();
        });
      }

      if (showTransport) {
        var playBtn = host.querySelector("[data-replay-play]");
        var pauseBtn = host.querySelector("[data-replay-pause]");
        if (playBtn) {
          playBtn.addEventListener("click", function () {
            playTransport();
          });
        }
        if (pauseBtn) {
          pauseBtn.addEventListener("click", function () {
            pauseTransport();
          });
        }
        host.querySelectorAll("[data-speed]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            setSpeed(Number(btn.getAttribute("data-speed")) || 1);
          });
        });
        syncTransportUi();
      }
    }

    function replayHosts() {
      return [root.querySelector('[data-panel="replay"]'), replayMountEl].filter(Boolean);
    }

    function syncScrubbers() {
      var events = activeEvents();
      var max = Math.max(0, events.length - 1);
      var metaText = (events.length ? replayIndex + 1 : 0) + " / " + events.length;
      var snap = buildTreeAt(events, replayIndex);
      var eventText = snap.event
        ? snap.event.ts +
          " · " +
          snap.event.type +
          " · " +
          (snap.event.name || snap.event.agentId) +
          " · " +
          normalizeModel(snap.event.model)
        : "No events";
      var treeHtml = renderTree(snap.roots);
      replayHosts().forEach(function (host) {
        host.querySelectorAll("[data-scrubber]").forEach(function (s) {
          s.max = String(max);
          s.value = String(replayIndex);
        });
        host.querySelectorAll("[data-scrubber-meta]").forEach(function (m) {
          m.textContent = metaText;
        });
        host.querySelectorAll("[data-replay-event]").forEach(function (el) {
          el.textContent = eventText;
        });
        host.querySelectorAll("[data-replay-tree]").forEach(function (el) {
          el.innerHTML = treeHtml;
        });
      });
    }

    function syncTransportUi() {
      replayHosts().forEach(function (host) {
        var playBtn = host.querySelector("[data-replay-play]");
        if (playBtn) {
          playBtn.setAttribute("aria-pressed", transportPlaying ? "true" : "false");
          playBtn.textContent = transportPlaying ? "Playing" : "Play";
        }
        host.querySelectorAll("[data-speed]").forEach(function (btn) {
          var on = Number(btn.getAttribute("data-speed")) === transportSpeed;
          btn.setAttribute("aria-pressed", on ? "true" : "false");
          btn.classList.toggle("on", on);
        });
      });
    }

    function clearTransportTimer() {
      if (transportTimer) {
        clearInterval(transportTimer);
        transportTimer = null;
      }
    }

    function playTransport() {
      var events = activeEvents();
      if (!events.length) return;
      transportPlaying = true;
      clearTransportTimer();
      /* Sync stage to current scrubber frame before advancing. */
      notifyReplayIndex("play-start");
      var baseMs = 900;
      var tick = Math.max(120, baseMs / Math.max(0.25, transportSpeed));
      transportTimer = setInterval(function () {
        var max = Math.max(0, activeEvents().length - 1);
        if (replayIndex >= max) {
          pauseTransport();
          return;
        }
        setReplayIndex(replayIndex + 1, { source: "play" });
      }, tick);
      syncTransportUi();
    }

    function pauseTransport() {
      transportPlaying = false;
      clearTransportTimer();
      syncTransportUi();
    }

    function setSpeed(mult) {
      var n = Number(mult);
      if (n !== 0.5 && n !== 1 && n !== 2) n = 1;
      transportSpeed = n;
      syncTransportUi();
      if (transportPlaying) playTransport();
    }

    function setReplayIndex(i, opts) {
      opts = opts || {};
      var events = activeEvents();
      var max = Math.max(0, events.length - 1);
      var next = Math.max(0, Math.min(max, Number(i) || 0));
      var changed = next !== replayIndex;
      replayIndex = next;
      if (!opts.skipPaint && opts.source !== "play") {
        renderReplay();
        if (replayMountEl) paintReplayInto(replayMountEl, { transport: true });
      }
      syncScrubbers();
      if (changed || opts.forceNotify) notifyReplayIndex(opts.source || "set");
    }

    function renderReplay() {
      var panel = root.querySelector('[data-panel="replay"]');
      paintReplayInto(panel, { transport: false });
    }

    function showTab(name) {
      var tab = String(name || "forecast").toLowerCase();
      if (tab === "what-if") tab = "whatif";
      var btn = root.querySelector('.insights-tab[data-tab="' + tab + '"]');
      if (!btn) return;
      root.querySelectorAll(".insights-tab").forEach(function (b) {
        var on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      root.querySelectorAll(".insights-panel").forEach(function (p) {
        var on = p.getAttribute("data-panel") === tab;
        p.classList.toggle("on", on);
        p.hidden = !on;
      });
    }

    function mountReplay(containerEl) {
      replayMountEl = containerEl || null;
      if (replayMountEl) paintReplayInto(replayMountEl, { transport: true });
      return getReplayController();
    }

    function getReplayController() {
      return {
        play: playTransport,
        pause: pauseTransport,
        setSpeed: setSpeed,
        setReplayIndex: setReplayIndex,
        getTransportState: getTransportState,
        getIndex: function () {
          return replayIndex;
        },
        getEvents: function () {
          return activeEvents().slice();
        }
      };
    }

    function getTransportState() {
      return {
        playing: transportPlaying,
        speed: transportSpeed,
        index: replayIndex,
        count: activeEvents().length
      };
    }

    function onReplayIndex(cb) {
      if (typeof cb !== "function") return function () {};
      replayIndexListeners.push(cb);
      return function () {
        replayIndexListeners = replayIndexListeners.filter(function (fn) {
          return fn !== cb;
        });
      };
    }

    function renderWhatIf() {
      var panel = root.querySelector('[data-panel="whatif"]');
      var scenarios = whatIfScenarios(activeEvents());
      var maxCost = Math.max.apply(
        null,
        scenarios
          .map(function (s) {
            return s.cost;
          })
          .concat([0.01])
      );
      panel.innerHTML =
        '<div class="insights-whatif">' +
        '<p class="insights-whatif-disclaimer" data-whatif-disclaimer>' +
        "Estimate: same tokens, different prices; real behavior may differ." +
        "</p>" +
        '<ul class="insights-whatif-list" data-whatif-list>' +
        scenarios
          .map(function (s) {
            var pct = Math.round((s.cost / maxCost) * 100);
            return (
              "<li>" +
              '<div class="insights-whatif-row">' +
              "<span>" +
              escapeHtml(s.label) +
              "</span>" +
              "<strong>" +
              formatMoney(s.cost) +
              "</strong>" +
              "</div>" +
              '<div class="insights-whatif-bar" style="width:' +
              pct +
              '%"></div>' +
              "</li>"
            );
          })
          .join("") +
        "</ul>" +
        "</div>";
    }

    function renderAll() {
      renderForecast();
      renderSuggestions();
      renderReplay();
      renderWhatIf();
    }

    root.querySelectorAll(".insights-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showTab(btn.getAttribute("data-tab"));
      });
    });

    sessionSelect.addEventListener("change", function () {
      sessionId = sessionSelect.value;
      pauseTransport();
      replayIndex = 0;
      renderAll();
      if (replayMountEl) paintReplayInto(replayMountEl, { transport: true });
      notifyReplayIndex("session");
    });

    async function load() {
      setStatus(demo ? "Loading demo history…" : "Loading /api/history…");
      try {
        allEvents = demo ? await loadDemoEvents() : await loadLiveEvents(opts);
        allEvents = sortEvents(allEvents);
        fillSessions();
        pauseTransport();
        replayIndex = 0;
        renderAll();
        if (replayMountEl) paintReplayInto(replayMountEl, { transport: true });
        setStatus(
          (demo ? "Demo" : "Live") +
            " · " +
            allEvents.length +
            " events" +
            (sessionId ? " · " + sessionId : "")
        );
      } catch (err) {
        allEvents = demo ? DEMO_HISTORY.events.slice() : [];
        fillSessions();
        renderAll();
        if (replayMountEl) paintReplayInto(replayMountEl, { transport: true });
        setStatus("Load failed: " + (err && err.message ? err.message : String(err)));
      }
    }

    load();

    function setDemoMode(isDemo) {
      demo = !!isDemo;
      modePill.textContent = demo ? "Demo" : "Live";
      modePill.classList.toggle("demo", demo);
      return load();
    }

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        pauseTransport();
        replayIndexListeners = [];
        replayMountEl = null;
        if (root.parentNode) root.parentNode.removeChild(root);
      },
      reload: load,
      setDemoMode: setDemoMode,
      showTab: showTab,
      mountReplay: mountReplay,
      getReplayController: getReplayController,
      onReplayIndex: onReplayIndex,
      setReplayIndex: setReplayIndex,
      play: playTransport,
      pause: pauseTransport,
      setSpeed: setSpeed,
      getTransportState: getTransportState,
      getConfig: function () {
        return CONFIG;
      },
      /** Test helpers */
      _api: {
        forecast: forecast,
        routingSuggestions: routingSuggestions,
        whatIfScenarios: whatIfScenarios,
        costFor: costFor,
        usageByModel: usageByModel,
        buildTreeAt: buildTreeAt
      }
    };
  }

  global.Insights = {
    init: init,
    CONFIG: CONFIG,
    /** Pure helpers for unit-style checks without DOM */
    analyze: {
      forecast: forecast,
      routingSuggestions: routingSuggestions,
      whatIfScenarios: whatIfScenarios,
      costFor: costFor,
      usageByModel: usageByModel,
      totalCost: totalCost,
      buildTreeAt: buildTreeAt,
      normalizeModel: normalizeModel
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
