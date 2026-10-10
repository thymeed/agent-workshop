/**
 * Agent card rendering — avatars, privacy meter, daily stats, ship celebration.
 * Loaded before app.js; exposes window.AgentCards.
 * Works from file:// (Demo) and bridge-served Live.
 */
(function (global) {
  "use strict";

  var ROLE_KEYS = ["opus", "advisor", "worker", "explorer", "researcher"];

  var ROLE_LABEL = {
    opus: "Opus",
    advisor: "Fable",
    worker: "Sonnet",
    explorer: "Explore",
    researcher: "Research"
  };

  var INITIALS = {
    opus: "Op",
    advisor: "Fb",
    worker: "Sn",
    explorer: "Ex",
    researcher: "Rs"
  };

  /** Short model name for avatar tips (TipLayer). */
  var MODEL_LABEL = {
    opus: "Opus",
    advisor: "Fable",
    worker: "Sonnet",
    explorer: "Haiku",
    researcher: "Haiku"
  };

  var STATE_TIP = {
    idle: "idle",
    typing: "working",
    thinking: "thinking",
    blocked: "blocked",
    done: "done",
    celebrating: "celebrating",
    error: "error"
  };

  /**
   * Demo fixtures for privacy + daily-stats without a live bridge.
   * Paths are scanned for the meter; UI never displays them.
   */
  var DEMO_FIXTURES = {
    sensitivePaths: ["config/.env.local", "deploy/credentials.json", "keys/id_rsa.pub"],
    runs: [
      { id: "demo-run-1", agent: "explorer", tokens: 438000, durationMs: 4200 },
      { id: "demo-run-2", agent: "worker", tokens: 307000, durationMs: 9100 },
      { id: "demo-run-3", agent: "researcher", tokens: 480000, durationMs: 6100 },
      { id: "demo-run-4", agent: "opus", tokens: 123000, durationMs: 15000 },
      { id: "demo-run-5", agent: "advisor", tokens: 108000, durationMs: 2800 }
    ]
  };

  var cards = {};
  var statusEls = {};
  var avatarEls = {};
  var privacyEls = {};
  var privacyLevel = {};
  var avatarState = {};
  var dailyStatsEl = null;
  var dayKey = null;
  var dayStats = emptyDayStats();
  var dailyMode = "demo";
  var demoFixtureApplied = false;
  var reducedMotion = false;
  var ready = false;

  function emptyDayStats() {
    return {
      runs: 0,
      tokens: 0,
      fastestAgent: null,
      fastestMs: null,
      roleTokens: {},
      roleActiveStarted: {}
    };
  }

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function ensureDay() {
    var key = todayKey();
    if (dayKey !== key) {
      dayKey = key;
      dayStats = emptyDayStats();
    }
  }

  function normalizePrivacyPath(path) {
    return String(path || "")
      .toLowerCase()
      .replace(/\\/g, "/");
  }

  /** Public key / template env files are never flagged. */
  function isPrivacySafeExample(path) {
    var p = normalizePrivacyPath(path);
    if (/\.env\.(example|sample|template)$/.test(p)) return true;
    if (/id_rsa\.pub$/.test(p)) return true;
    if (/id_ed25519\.pub$/.test(p)) return true;
    return false;
  }

  function privacyScore(path) {
    if (!path || typeof path !== "string") return 0;
    if (isPrivacySafeExample(path)) return 0;
    var p = normalizePrivacyPath(path);
    var base = p.split("/").pop() || p;

    if (base === ".env" || /^\.env\./.test(base)) return 3;
    if (/credentials\.json$/.test(base) || /(^|\/)credentials(\/|$)/.test(p)) return 3;
    if (/id_rsa/.test(p) && !/id_rsa\.pub/.test(p)) return 3;
    if (/id_ed25519/.test(p) && !/id_ed25519\.pub/.test(p)) return 3;
    if (/secrets?/.test(p) || /keychain/.test(p) || /oauth/.test(p) || /token\.json/.test(p)) {
      return 3;
    }

    if (/(?:^|\/)\.ssh(?:\/|$)/.test(p) || p.indexOf("/.ssh/") !== -1) return 2;
    if (/(?:^|\/)\.aws(?:\/|$)/.test(p) || p.indexOf("/.aws/") !== -1) return 2;
    if (/\.(pem|key|p12|pfx)$/.test(p)) return 2;
    if (base === ".npmrc" || base === ".netrc") return 2;

    return 0;
  }

  function levelFromScore(score) {
    if (score >= 3) return "high";
    if (score >= 2) return "med";
    if (score >= 1) return "low";
    return "none";
  }

  function detectPrivacyLevel(path) {
    return levelFromScore(privacyScore(path));
  }

  function formatTokens(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1000000) {
      return (n / 1000000).toFixed(n % 100000 === 0 ? 1 : 2).replace(/\.00$/, ".0") + "M";
    }
    if (n >= 1000) return Math.round(n / 1000) + "K";
    return String(n);
  }

  function avatarTipText(role, state) {
    var label = ROLE_LABEL[role] || role;
    var model = MODEL_LABEL[role] || "";
    var st = STATE_TIP[state] || state || "idle";
    return label + (model ? " · " + model : "") + " · " + st;
  }

  function syncAvatarTip(role) {
    var el = avatarEls[role];
    if (!el) return;
    var state = avatarState[role] || "idle";
    var tip = avatarTipText(role, state);
    el.setAttribute("data-tip", tip);
    el.setAttribute(
      "data-tip-detail",
      (ROLE_LABEL[role] || role) + " station · " + (STATE_TIP[state] || state)
    );
  }

  function mountAvatar(card, role) {
    if (!card || avatarEls[role]) return;
    var head = card.querySelector(".card-head");
    if (!head) return;
    var wrap = document.createElement("div");
    wrap.className = "agent-avatar state-idle";
    wrap.setAttribute("data-avatar", role);
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML =
      '<span class="avatar-chrome" aria-hidden="true"></span>' +
      '<span class="avatar-face">' +
      '<span class="avatar-initials">' +
      (INITIALS[role] || "?") +
      "</span>" +
      '<span class="avatar-eyes"></span>' +
      '<span class="avatar-mouth"></span>' +
      "</span>";
    head.insertBefore(wrap, head.firstChild);
    avatarEls[role] = wrap;
    avatarState[role] = "idle";
    syncAvatarTip(role);
  }

  function mountPrivacy(card, role) {
    if (!card || privacyEls[role]) return;
    var row = card.querySelector(".badge-row");
    if (!row) return;
    var badge = document.createElement("span");
    badge.className = "privacy-meter level-none";
    badge.setAttribute("data-privacy", role);
    badge.setAttribute(
      "title",
      "Privacy · path-based heuristic · not ground truth · no sensitive paths"
    );
    badge.setAttribute("aria-label", "Privacy meter (heuristic): none");
    badge.innerHTML =
      '<span class="privacy-label">Privacy · heuristic</span>' +
      '<span class="privacy-dots" aria-hidden="true">' +
      "<i></i><i></i><i></i>" +
      "</span>" +
      '<span class="privacy-level">none</span>';
    row.insertBefore(badge, row.firstChild);
    privacyEls[role] = badge;
    privacyLevel[role] = "none";
  }

  function mountDailyStats() {
    if (dailyStatsEl) return dailyStatsEl;
    var existing = document.getElementById("dailyStatsCard");
    if (existing) {
      dailyStatsEl = existing;
      return dailyStatsEl;
    }
    var host =
      document.getElementById("stationsDrawerBody") || document.getElementById("stationsPanel");
    if (!host) return null;
    var article = document.createElement("article");
    article.className = "card daily-stats-card";
    article.id = "dailyStatsCard";
    article.setAttribute("aria-label", "Daily stats");
    article.innerHTML =
      '<div class="card-head">' +
      '<div><div class="card-name">Daily stats</div>' +
      '<div class="card-role">Today · client totals</div></div>' +
      "</div>" +
      '<div class="daily-stats-grid">' +
      '<div class="daily-stat"><span class="daily-stat-label">Runs today</span>' +
      '<strong id="dailyRuns">0</strong></div>' +
      '<div class="daily-stat"><span class="daily-stat-label">Total tokens</span>' +
      '<strong id="dailyTokens">0</strong></div>' +
      '<div class="daily-stat"><span class="daily-stat-label">Fastest agent</span>' +
      '<strong id="dailyFastest">—</strong></div>' +
      "</div>";
    var mid = host.querySelector(".row.mid") || host;
    if (mid.parentNode && mid !== host) {
      mid.parentNode.insertBefore(article, mid.nextSibling);
    } else {
      host.appendChild(article);
    }
    dailyStatsEl = article;
    return article;
  }

  function setPrivacyLevel(role, level) {
    var el = privacyEls[role];
    if (!el) return;
    var rank = { none: 0, low: 1, med: 2, high: 3 };
    var prev = privacyLevel[role] || "none";
    if ((rank[level] || 0) <= (rank[prev] || 0)) return;
    privacyLevel[role] = level;
    el.className = "privacy-meter level-" + level;
    var label = el.querySelector(".privacy-level");
    if (label) label.textContent = level;
    el.setAttribute("title", "Privacy · path-based heuristic · not ground truth · " + level);
    el.setAttribute("aria-label", "Privacy meter (heuristic): " + level);
  }

  function noteSensitivePath(role, path) {
    if (!role || !cards[role]) return detectPrivacyLevel(path);
    var level = detectPrivacyLevel(path);
    if (level !== "none") setPrivacyLevel(role, level);
    return level;
  }

  function setAvatarState(role, state, opts) {
    opts = opts || {};
    var el = avatarEls[role];
    if (!el) return;
    var next = state || "idle";
    var force = !!opts.force;
    if (!force && avatarState[role] === next) return;
    avatarState[role] = next;
    var cls = "agent-avatar state-" + next + (reducedMotion ? " reduced-motion" : "");
    if (force) {
      // Retrigger CSS keyframes (ship wave / done bounce).
      el.className = "agent-avatar" + (reducedMotion ? " reduced-motion" : "");
      void el.offsetWidth;
    }
    el.className = cls;
    syncAvatarTip(role);
  }

  function inferAvatarFromStatus(role, html, cls) {
    var text = String(html || "").replace(/<[^>]+>/g, " ");
    var fail = cls === "fail" || /\bFAIL\b/i.test(text);
    var blocked = /\b(Blocked|Stalled|Stall|stuck)\b/i.test(text);
    var celebrating = /\b(shipped|ship|merge[d]?)\b/i.test(text);
    var done =
      cls === "pass" ||
      /\b(Done|PASS|complete|Quiet)\b/i.test(text) ||
      /Idle · waiting/i.test(text);
    var thinking = /Reviewing|Analyzing|Awaiting|waiting|Standby|Quiet/i.test(text);
    var typing = /Editing|Searching|Pulling|Calling|Task received|Plan approved|Fix applied/i.test(
      text
    );

    if (fail) return "error";
    if (blocked) return "blocked";
    if (celebrating) return "celebrating";
    if (typing) return "typing";
    if (thinking && !done) return "thinking";
    if (/\b(Done|PASS)\b/i.test(text) || cls === "pass") return "done";
    if (done) return "idle";
    return "thinking";
  }

  /**
   * Ship / merge payoff for avatars only (portal + toast stay in app.js).
   * @param {string[]|string} [roles] — roles to celebrate; defaults to currently active cards
   */
  function celebrateShip(roles) {
    var list = [];
    if (typeof roles === "string") list = [roles];
    else if (Array.isArray(roles) && roles.length) list = roles.slice();
    else {
      ROLE_KEYS.forEach(function (key) {
        if (cards[key] && cards[key].classList.contains("active")) list.push(key);
      });
    }
    if (!list.length) return;
    list.forEach(function (role) {
      if (!avatarEls[role]) return;
      setAvatarState(role, "celebrating", { force: true });
    });
  }

  /** Same clock setActive uses (Date.now when role became active). */
  function getRoleActiveStarted(role) {
    ensureDay();
    if (role) {
      var ts = dayStats.roleActiveStarted[role];
      return ts == null ? null : ts;
    }
    var out = {};
    Object.keys(dayStats.roleActiveStarted).forEach(function (k) {
      out[k] = dayStats.roleActiveStarted[k];
    });
    return out;
  }

  function getActiveStartMs(role) {
    if (!role) return null;
    return getRoleActiveStarted(role);
  }

  /** Attach timing hooks for Playwright; re-apply after app.js replaces the object. */
  function ensureTestHooks() {
    var t = global.__cursorAgentsDashTest;
    if (!t || typeof t !== "object") {
      global.__cursorAgentsDashTest = t = {};
    }
    t.getRoleActiveStarted = getRoleActiveStarted;
    t.getActiveStartMs = getActiveStartMs;
  }

  function setStatus(role, html, cls) {
    var el = statusEls[role];
    if (!el) return;
    el.className = "status" + (cls ? " " + cls : "");
    el.innerHTML = html;
    setAvatarState(role, inferAvatarFromStatus(role, html, cls));
  }

  function setActive(roles, opts) {
    opts = opts || {};
    var skipTiming = !!opts.skipTiming;
    var set = {};
    (roles || []).forEach(function (r) {
      set[r] = true;
    });
    var now = Date.now();
    ensureDay();
    ROLE_KEYS.forEach(function (key) {
      if (!cards[key]) return;
      var on = !!set[key];
      cards[key].classList.toggle("active", on);
      if (on) {
        if (!skipTiming && !dayStats.roleActiveStarted[key]) dayStats.roleActiveStarted[key] = now;
        if (
          avatarState[key] !== "error" &&
          avatarState[key] !== "done" &&
          avatarState[key] !== "celebrating" &&
          avatarState[key] !== "blocked"
        ) {
          setAvatarState(key, "typing");
        }
      } else if (!skipTiming && dayStats.roleActiveStarted[key]) {
        var started = dayStats.roleActiveStarted[key];
        delete dayStats.roleActiveStarted[key];
        var dur = Math.max(0, now - started);
        if (dayStats.fastestMs == null || dur < dayStats.fastestMs) {
          dayStats.fastestMs = dur;
          dayStats.fastestAgent = key;
        }
        if (avatarState[key] === "typing") setAvatarState(key, "thinking");
      } else if (skipTiming && dayStats.roleActiveStarted[key]) {
        delete dayStats.roleActiveStarted[key];
        if (avatarState[key] === "typing") setAvatarState(key, "thinking");
      }
    });
    ensureTestHooks();
  }

  function renderDailyStats() {
    ensureDay();
    var runsEl = document.getElementById("dailyRuns");
    var tokensEl = document.getElementById("dailyTokens");
    var fastestEl = document.getElementById("dailyFastest");
    if (runsEl) runsEl.textContent = String(dayStats.runs);
    if (tokensEl) tokensEl.textContent = formatTokens(dayStats.tokens);
    if (fastestEl) {
      fastestEl.textContent = dayStats.fastestAgent
        ? ROLE_LABEL[dayStats.fastestAgent] || dayStats.fastestAgent
        : "—";
    }
  }

  function addTokens(n, role) {
    ensureDay();
    var add = Math.max(0, Number(n) || 0);
    if (!add) return;
    dayStats.tokens += add;
    if (role) {
      dayStats.roleTokens[role] = (dayStats.roleTokens[role] || 0) + add;
    }
    renderDailyStats();
  }

  function recordRun(meta) {
    ensureDay();
    dayStats.runs += 1;
    meta = meta || {};
    if (meta.tokens) addTokens(meta.tokens, meta.agent);
    if (meta.durationMs != null && meta.agent) {
      var dur = Math.max(0, Number(meta.durationMs) || 0);
      if (dayStats.fastestMs == null || dur < dayStats.fastestMs) {
        dayStats.fastestMs = dur;
        dayStats.fastestAgent = meta.agent;
      }
    }
    renderDailyStats();
  }

  /** Demo-only: bump runs when subagent count rises (Live uses recordLiveSession). */
  function syncLiveSubs(subs) {
    if (dailyMode !== "live") return;
    var n = Math.max(0, Number(subs) || 0);
    if (n > dayStats.runs) {
      dayStats.runs = n;
      renderDailyStats();
    }
  }

  function recordLiveSession() {
    if (dailyMode !== "live") return;
    recordRun({ agent: null, tokens: 0, durationMs: null });
  }

  function onModeChange(mode) {
    dailyMode = mode === "live" ? "live" : "demo";
    demoFixtureApplied = false;
    dayKey = todayKey();
    dayStats = emptyDayStats();
    ROLE_KEYS.forEach(function (role) {
      privacyLevel[role] = "none";
      if (privacyEls[role]) {
        privacyEls[role].className = "privacy-meter level-none";
        var label = privacyEls[role].querySelector(".privacy-level");
        if (label) label.textContent = "none";
        privacyEls[role].setAttribute(
          "title",
          "Privacy · path-based heuristic · not ground truth · no sensitive paths"
        );
        privacyEls[role].setAttribute("aria-label", "Privacy meter (heuristic): none");
      }
    });
    if (dailyMode === "demo") applyDemoFixtures();
    else renderDailyStats();
  }

  function applyDemoFixtures() {
    if (demoFixtureApplied || dailyMode !== "demo") return;
    DEMO_FIXTURES.sensitivePaths.forEach(function (p, i) {
      var role = ROLE_KEYS[i % ROLE_KEYS.length];
      noteSensitivePath(role, p);
    });
    ensureDay();
    dayStats.runs = 0;
    dayStats.tokens = 0;
    dayStats.fastestAgent = null;
    dayStats.fastestMs = null;
    DEMO_FIXTURES.runs.forEach(function (r) {
      recordRun(r);
    });
    demoFixtureApplied = true;
  }

  function reset(opts) {
    opts = opts || {};
    ROLE_KEYS.forEach(function (role) {
      if (cards[role]) cards[role].classList.remove("active");
      privacyLevel[role] = "none";
      if (privacyEls[role]) {
        privacyEls[role].className = "privacy-meter level-none";
        var label = privacyEls[role].querySelector(".privacy-level");
        if (label) label.textContent = "none";
        privacyEls[role].setAttribute(
          "title",
          "Privacy · path-based heuristic · not ground truth · no sensitive paths"
        );
        privacyEls[role].setAttribute("aria-label", "Privacy meter (heuristic): none");
      }
      setAvatarState(role, "idle");
    });
    if (!opts.keepDaily) {
      dayKey = todayKey();
      dayStats = emptyDayStats();
      demoFixtureApplied = false;
      renderDailyStats();
    }
    if (opts.mode === "demo" && dailyMode === "demo") applyDemoFixtures();
  }

  function init(_containerEl, opts) {
    opts = opts || {};
    reducedMotion = prefersReducedMotion();
    ROLE_KEYS.forEach(function (role) {
      cards[role] = document.getElementById("card-" + role);
      statusEls[role] = document.getElementById("status-" + role);
      if (cards[role]) {
        mountAvatar(cards[role], role);
        mountPrivacy(cards[role], role);
      }
    });
    mountDailyStats();
    ready = true;
    dailyMode = opts.demo ? "demo" : "live";
    if (opts.demo) applyDemoFixtures();
    else renderDailyStats();
    ensureTestHooks();
    return api;
  }

  var api = {
    init: init,
    onModeChange: onModeChange,
    setActive: setActive,
    setStatus: setStatus,
    setAvatarState: setAvatarState,
    celebrateShip: celebrateShip,
    getRoleActiveStarted: getRoleActiveStarted,
    getActiveStartMs: getActiveStartMs,
    noteSensitivePath: noteSensitivePath,
    detectPrivacyLevel: detectPrivacyLevel,
    isPrivacySafeExample: isPrivacySafeExample,
    privacyScore: privacyScore,
    addTokens: addTokens,
    recordRun: recordRun,
    recordLiveSession: recordLiveSession,
    syncLiveSubs: syncLiveSubs,
    renderDailyStats: renderDailyStats,
    applyDemoFixtures: applyDemoFixtures,
    reset: reset,
    getDailyMode: function () {
      return dailyMode;
    },
    getCards: function () {
      return cards;
    },
    getStatusEls: function () {
      return statusEls;
    },
    getAvatarState: function (role) {
      return role ? avatarState[role] || null : Object.assign({}, avatarState);
    },
    getDailyStats: function () {
      ensureDay();
      return {
        runs: dayStats.runs,
        tokens: dayStats.tokens,
        fastestAgent: dayStats.fastestAgent,
        fastestMs: dayStats.fastestMs
      };
    },
    DEMO_FIXTURES: DEMO_FIXTURES,
    ROLE_KEYS: ROLE_KEYS,
    isReady: function () {
      return ready;
    }
  };

  global.AgentCards = api;
  ensureTestHooks();
})(typeof window !== "undefined" ? window : globalThis);
