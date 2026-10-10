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

  /** Short model name for avatar tips (TipLayer). */
  var MODEL_LABEL = {
    opus: "Opus",
    advisor: "Fable",
    worker: "Sonnet",
    explorer: "Haiku",
    researcher: "Haiku"
  };

  var STATE_TIP = {
    idle: "hanging out",
    typing: "hard at work",
    thinking: "pondering",
    blocked: "paused",
    done: "all smiles",
    celebrating: "ship party",
    error: "oops"
  };

  /** Cute nook words — CSS classes stay none/low/med/high. */
  var PRIVACY_WORD = {
    none: "cozy",
    low: "peek",
    med: "hush",
    high: "yikes"
  };

  var STATUS_MAX_CHARS = 68;

  var ROLE_CARD_TIPS = {
    opus: {
      name: "Opus",
      nameDetail: "Main session lead · Cursor Agents parent",
      role: "Main session",
      roleDetail: "Routes the workshop, calls Fable, ships the story",
      effort: "Effort · high",
      effortDetail: "Opus usually runs a high-effort band",
      price: "Opus rates",
      priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
    },
    advisor: {
      name: "Fable",
      nameDetail: "Cute advisor · steps in at sticky moments",
      role: "Advisor",
      roleDetail: "Before plan · same error ×2 · before done",
      effort: "Effort · high",
      effortDetail: "Advisor reviews run a high-effort band",
      price: "Fable rates",
      priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
      calls: "Advisor calls",
      callsDetail: "How many times Fable has been asked this session",
      last: "Last advice",
      lastDetail: "Most recent tip from Fable"
    },
    worker: {
      name: "Worker",
      nameDetail: "Sonnet · edits, tests, and fixes",
      role: "Sonnet · edits",
      roleDetail: "The workshop hands that change the code",
      effort: "Effort · medium",
      effortDetail: "Worker usually runs a medium-effort band",
      price: "Sonnet rates",
      priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
    },
    explorer: {
      name: "Explorer",
      nameDetail: "Haiku scout · search & map the repo",
      role: "Haiku · search",
      roleDetail: "Read-only explore · finds paths and patterns",
      effort: "Effort · low",
      effortDetail: "Explorer keeps it light and fast",
      price: "Haiku rates",
      priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
      scout: "Scout mode",
      scoutDetail: "Read-only explore — no edits from this station"
    },
    researcher: {
      name: "Researcher",
      nameDetail: "Haiku bookworm · docs and references",
      role: "Haiku · docs",
      roleDetail: "Read-only research · pulls docs and patterns",
      effort: "Effort · low",
      effortDetail: "Researcher keeps it light and fast",
      price: "Haiku rates",
      priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
      scout: "Scout mode",
      scoutDetail: "Read-only research — no edits from this station"
    }
  };

  var CHIP_TIPS = [
    {
      tip: "Before plan",
      detail: "Fable reviews the approach before the big plan"
    },
    {
      tip: "Same error ×2",
      detail: "Fable jumps in when the same failure loops"
    },
    {
      tip: "Before done",
      detail: "Fable does a final pass before ship"
    }
  ];

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

  function decodeBasicEntities(s) {
    return String(s || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  function escapeHtmlText(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Card status copy: strip markdown noise, collapse SHAs/links, ellipsis on a word edge.
   */
  function prettyStatusText(raw) {
    var s = decodeBasicEntities(String(raw || ""));
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/\*([^*]+)\*/g, "$1");
    s = s.replace(/_([^_]+)_/g, "$1");
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/https?:\/\/\S+/gi, "link");
    s = s.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      function (m) {
        return m.slice(0, 8);
      }
    );
    s = s.replace(/\b[0-9a-f]{40}\b/gi, function (m) {
      return m.slice(0, 7);
    });
    s = s.replace(/\b[0-9a-f]{12,39}\b/gi, function (m) {
      return m.slice(0, 7);
    });
    s = s.replace(/\bCommit:\s*/gi, "");
    s = s.replace(/\bMessage:\s*/gi, "");
    s = s.replace(/^delegates\s*[·•|-]+\s*/i, "");
    s = s.replace(/\bexplore\s*[·•|-]+\s*/i, "scout · ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/\s+'[^']*$/g, "");
    s = s.replace(/\s+\S+_$/g, "");
    s = s.replace(/[\s·,;:]+$/g, "").trim();

    if (s.length > STATUS_MAX_CHARS) {
      var cut = s.slice(0, STATUS_MAX_CHARS);
      var sp = cut.lastIndexOf(" ");
      if (sp > Math.floor(STATUS_MAX_CHARS * 0.55)) cut = cut.slice(0, sp);
      cut = cut.replace(/[\s·,;:'"-]+$/g, "");
      if (/^[a-z0-9]{1,3}$/i.test(cut.split(/\s+/).pop() || "")) {
        cut = cut.replace(/\s+\S+$/, "");
      }
      s = cut + "…";
    }
    return s;
  }

  function formatStatusHtml(html) {
    var raw = String(html == null ? "" : html);
    var cls = null;
    var inner = raw;
    var m = raw.match(/^<span\s+class="([^"]*)">([\s\S]*)<\/span>\s*$/i);
    if (m) {
      cls = m[1];
      inner = m[2];
    }
    var plain = prettyStatusText(inner.replace(/<[^>]+>/g, " "));
    var safe = escapeHtmlText(plain);
    if (cls) return '<span class="' + cls + '">' + safe + "</span>";
    return safe;
  }

  function privacyCopy(level) {
    var lv = level || "none";
    var word = PRIVACY_WORD[lv] || lv;
    var detail =
      "Path-based heuristic · not ground truth · sensitive paths never shown on the badge · " +
      word;
    return {
      word: word,
      tip: "Nook · " + word,
      detail: detail,
      title: "Nook · path-based heuristic · not ground truth · " + word,
      aria: "Nook privacy meter (heuristic): " + word
    };
  }

  function applyPrivacyChrome(el, level) {
    if (!el) return;
    var copy = privacyCopy(level);
    el.className = "privacy-meter level-" + level;
    var label = el.querySelector(".privacy-level");
    if (label) label.textContent = copy.word;
    setTip(el, copy.tip, copy.detail);
    el.setAttribute("title", copy.title);
    el.setAttribute("aria-label", copy.aria);
  }

  function setTip(el, tip, detail) {
    if (!el) return;
    el.setAttribute("data-tip", String(tip || ""));
    if (detail) el.setAttribute("data-tip-detail", String(detail));
    else el.removeAttribute("data-tip-detail");
    if (el.hasAttribute("title")) el.removeAttribute("title");
  }

  function avatarTipText(role, state) {
    var label = ROLE_LABEL[role] || role;
    var st = STATE_TIP[state] || state || "hanging out";
    return label + " is " + st;
  }

  function syncAvatarTip(role) {
    var el = avatarEls[role];
    if (!el) return;
    var state = avatarState[role] || "idle";
    var tip = avatarTipText(role, state);
    var model = MODEL_LABEL[role] || "";
    var detail =
      (ROLE_LABEL[role] || role) +
      (model ? " · " + model : "") +
      " · Cursor Agents station · " +
      (STATE_TIP[state] || state);
    setTip(el, tip, detail);
    el.setAttribute("aria-label", tip);
  }

  function syncStatusTip(role, plain) {
    var el = statusEls[role];
    if (!el) return;
    var label = ROLE_LABEL[role] || role;
    var text = String(plain || "").trim() || "Quiet for now";
    var tip = text.length > 44 ? text.slice(0, 42).replace(/[\s·,;:]+$/, "") + "…" : text;
    setTip(el, label + " · " + tip, text);
  }

  function decorateCardTips(role) {
    var card = cards[role];
    var tips = ROLE_CARD_TIPS[role];
    if (!card || !tips) return;

    var nameEl = card.querySelector(".card-name");
    var roleEl = card.querySelector(".card-role");
    var effortEl = card.querySelector(".effort");
    var priceEl = card.querySelector(".price");
    var scoutEl = card.querySelector(".readonly-pill");
    var callsEl = card.querySelector(".call-count");
    var lastEl = card.querySelector("#advisorLast, .advisor-quiet");
    var chips = card.querySelectorAll(".trigger-chips .chip");

    setTip(nameEl, tips.name, tips.nameDetail);
    setTip(roleEl, tips.role, tips.roleDetail);
    setTip(effortEl, tips.effort, tips.effortDetail);
    setTip(priceEl, tips.price, tips.priceDetail);
    if (scoutEl && tips.scout) setTip(scoutEl, tips.scout, tips.scoutDetail);
    if (callsEl && tips.calls) setTip(callsEl, tips.calls, tips.callsDetail);
    if (lastEl && tips.last) setTip(lastEl, tips.last, tips.lastDetail);

    for (var i = 0; i < chips.length; i++) {
      var chipTip = CHIP_TIPS[i] || {
        tip: chips[i].textContent || "Trigger",
        detail: "Advisor trigger chip"
      };
      setTip(chips[i], chipTip.tip, chipTip.detail);
    }

    if (statusEls[role] && !statusEls[role].getAttribute("data-tip")) {
      syncStatusTip(role, (statusEls[role].textContent || "").trim());
    }
  }

  function decorateDailyTips() {
    var article = dailyStatsEl || document.getElementById("dailyStatsCard");
    if (!article) return;
    setTip(
      article,
      "Daily bench",
      "Cute client-side totals for today · resets with the calendar day"
    );
    setTip(
      article.querySelector(".card-name"),
      "Daily bench",
      "Workshop chalkboard for today's runs"
    );
    setTip(
      article.querySelector(".card-role"),
      "On the floor today",
      "What the stations have been up to since midnight"
    );
    var runs = document.getElementById("dailyRuns");
    var tokens = document.getElementById("dailyTokens");
    var fastest = document.getElementById("dailyFastest");
    if (runs && runs.parentElement) {
      setTip(runs.parentElement, "Runs today", "How many agent runs hit the floor today");
    }
    if (tokens && tokens.parentElement) {
      setTip(tokens.parentElement, "Tokens spun", "Illustrative token total from Demo or Live");
    }
    if (fastest && fastest.parentElement) {
      setTip(fastest.parentElement, "Quickest hand", "Who wrapped a turn the fastest today");
    }
  }

  function decorateAllTips() {
    ROLE_KEYS.forEach(decorateCardTips);
    decorateDailyTips();
  }

  /**
   * Cute face markup for a role — soft blush + real eye dots + mouth.
   * Never letter-circle initials (Op/Fb/…). Props (crown/star/band/hat/glasses)
   * live on `.avatar-chrome` via cards.css. Keep mouths in sync with stage SVG.
   */
  function faceMarkup(role, opts) {
    opts = opts || {};
    var r = ROLE_KEYS.indexOf(role) >= 0 ? role : "opus";
    var size = opts.size === "sm" ? " avatar-sm" : "";
    var state = opts.state ? " state-" + opts.state : " state-idle";
    return (
      '<span class="agent-avatar' +
      size +
      state +
      '" data-avatar="' +
      r +
      '" aria-hidden="true">' +
      '<span class="avatar-chrome" aria-hidden="true"></span>' +
      '<span class="avatar-face">' +
      '<span class="avatar-blush" aria-hidden="true"></span>' +
      '<span class="avatar-eyes" aria-hidden="true">' +
      '<span class="avatar-eye"></span>' +
      '<span class="avatar-eye"></span>' +
      "</span>" +
      '<span class="avatar-mouth" aria-hidden="true"></span>' +
      "</span>" +
      "</span>"
    );
  }

  /** Map alert / history hints → card role key (opus/advisor/worker/explorer/researcher). */
  function roleFromAgentHint(hint) {
    if (!hint) return "";
    if (typeof hint === "string") {
      hint = { name: hint, agentId: hint };
    }
    var name = String(hint.name || hint.role || "").toLowerCase();
    var agentId = String(hint.agentId || "").toLowerCase();
    var model = String(hint.model || "").toLowerCase();
    if (
      name.indexOf("advisor") >= 0 ||
      name.indexOf("fable") >= 0 ||
      model.indexOf("fable") >= 0 ||
      agentId.indexOf("advisor") >= 0
    ) {
      return "advisor";
    }
    if (
      name.indexOf("worker") >= 0 ||
      name.indexOf("sonnet") >= 0 ||
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
      agentId.indexOf("explor") >= 0 ||
      (model.indexOf("haiku") >= 0 && name.indexOf("research") < 0)
    ) {
      return "explorer";
    }
    if (
      name.indexOf("parent") >= 0 ||
      name.indexOf("opus") >= 0 ||
      model.indexOf("opus") >= 0 ||
      agentId.indexOf("parent") >= 0
    ) {
      return "opus";
    }
    return "";
  }

  /**
   * Mount the per-role cute face (`data-avatar`) into the card head.
   * Idle mouths are CSS per role in cards.css (flat / grin / dash / U / o) —
   * keep in sync with stage SVG mouths in model-routing-dashboard.html.
   */
  function mountAvatar(card, role) {
    if (!card || avatarEls[role]) return;
    var head = card.querySelector(".card-head");
    if (!head) return;
    head.insertAdjacentHTML("afterbegin", faceMarkup(role));
    var wrap = head.querySelector('.agent-avatar[data-avatar="' + role + '"]');
    if (!wrap) return;
    wrap.setAttribute("role", "img");
    avatarEls[role] = wrap;
    avatarState[role] = "idle";
    syncAvatarTip(role);
  }

  function mountPrivacy(card, role) {
    if (!card || privacyEls[role]) return;
    var row = card.querySelector(".badge-row");
    if (!row) return;
    var badge = document.createElement("span");
    badge.setAttribute("data-privacy", role);
    badge.innerHTML =
      '<span class="privacy-label" aria-hidden="true">nook</span>' +
      '<span class="privacy-dots" aria-hidden="true">' +
      "<i></i><i></i><i></i>" +
      "</span>" +
      '<span class="privacy-level">cozy</span>';
    applyPrivacyChrome(badge, "none");
    row.insertBefore(badge, row.firstChild);
    privacyEls[role] = badge;
    privacyLevel[role] = "none";
  }

  function mountDailyStats() {
    if (dailyStatsEl) return dailyStatsEl;
    var existing = document.getElementById("dailyStatsCard");
    if (existing) {
      dailyStatsEl = existing;
      decorateDailyTips();
      return dailyStatsEl;
    }
    var host =
      document.getElementById("stationsDrawerBody") || document.getElementById("stationsPanel");
    if (!host) return null;
    var article = document.createElement("article");
    article.className = "card daily-stats-card";
    article.id = "dailyStatsCard";
    article.setAttribute("aria-label", "Daily bench");
    article.innerHTML =
      '<div class="card-head">' +
      '<div><div class="card-name">Daily bench</div>' +
      '<div class="card-role">On the floor today</div></div>' +
      "</div>" +
      '<div class="daily-stats-grid">' +
      '<div class="daily-stat"><span class="daily-stat-label">Runs</span>' +
      '<strong id="dailyRuns">0</strong></div>' +
      '<div class="daily-stat"><span class="daily-stat-label">Tokens spun</span>' +
      '<strong id="dailyTokens">0</strong></div>' +
      '<div class="daily-stat"><span class="daily-stat-label">Quickest</span>' +
      '<strong id="dailyFastest">—</strong></div>' +
      "</div>";
    var mid = host.querySelector(".row.mid") || host;
    if (mid.parentNode && mid !== host) {
      mid.parentNode.insertBefore(article, mid.nextSibling);
    } else {
      host.appendChild(article);
    }
    dailyStatsEl = article;
    decorateDailyTips();
    return article;
  }

  function setPrivacyLevel(role, level) {
    var el = privacyEls[role];
    if (!el) return;
    var rank = { none: 0, low: 1, med: 2, high: 3 };
    var prev = privacyLevel[role] || "none";
    if ((rank[level] || 0) <= (rank[prev] || 0)) return;
    privacyLevel[role] = level;
    applyPrivacyChrome(el, level);
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
    el.setAttribute("data-avatar", role);
    syncAvatarTip(role);
  }

  /**
   * Map card status copy → avatar expression. Awake open eye dots everywhere except
   * done / celebrating (closed arcs). Per-role mouths from CSS; typing animates mouth only.
   */
  function inferAvatarFromStatus(role, html, cls) {
    var text = String(html || "").replace(/<[^>]+>/g, " ");
    var fail = cls === "fail" || /\bFAIL\b/i.test(text);
    var blocked = /\b(Blocked|Stalled|Stall|stuck)\b/i.test(text);
    var celebrating = /\b(shipped|ship|merge[d]?)\b/i.test(text);
    var idle =
      /\b(Standby|Quiet|idle|Turn|turn)\b/i.test(text) ||
      /Idle · waiting/i.test(text) ||
      /Replay · idle/i.test(text);
    var done = cls === "pass" || /\b(Done|PASS|complete)\b/i.test(text);
    var typing =
      /Editing|Searching|Pulling|Calling|Task received|Plan approved|Fix applied|Reviewing|Analyzing/i.test(
        text
      );

    if (fail) return "error";
    if (blocked) return "blocked";
    if (celebrating) return "celebrating";
    if (typing) return "typing";
    if (done) return "done";
    if (idle) return "idle";
    return "idle";
  }

  function statusClassFromEl(el) {
    if (!el) return "";
    var parts = String(el.className || "")
      .split(/\s+/)
      .filter(Boolean);
    if (parts[0] === "status" && parts.length > 1) return parts.slice(1).join(" ");
    return "";
  }

  /** Re-apply avatar expression from the card's current status copy. */
  function syncAvatarFromStatus(role) {
    var el = statusEls[role];
    if (!el) return;
    setAvatarState(role, inferAvatarFromStatus(role, el.innerHTML, statusClassFromEl(el)));
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
    var fullPlain = prettyStatusText(String(html || "").replace(/<[^>]+>/g, " "));
    el.innerHTML = formatStatusHtml(html);
    syncStatusTip(role, fullPlain);
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
      } else if (!skipTiming && dayStats.roleActiveStarted[key]) {
        var started = dayStats.roleActiveStarted[key];
        delete dayStats.roleActiveStarted[key];
        var dur = Math.max(0, now - started);
        if (dayStats.fastestMs == null || dur < dayStats.fastestMs) {
          dayStats.fastestMs = dur;
          dayStats.fastestAgent = key;
        }
        if (
          avatarState[key] !== "error" &&
          avatarState[key] !== "done" &&
          avatarState[key] !== "celebrating" &&
          avatarState[key] !== "blocked"
        ) {
          syncAvatarFromStatus(key);
        }
      } else if (skipTiming && dayStats.roleActiveStarted[key]) {
        delete dayStats.roleActiveStarted[key];
        if (
          avatarState[key] !== "error" &&
          avatarState[key] !== "done" &&
          avatarState[key] !== "celebrating" &&
          avatarState[key] !== "blocked"
        ) {
          syncAvatarFromStatus(key);
        }
      } else if (
        !on &&
        avatarState[key] !== "error" &&
        avatarState[key] !== "done" &&
        avatarState[key] !== "celebrating" &&
        avatarState[key] !== "blocked"
      ) {
        syncAvatarFromStatus(key);
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
      if (privacyEls[role]) applyPrivacyChrome(privacyEls[role], "none");
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
      if (privacyEls[role]) applyPrivacyChrome(privacyEls[role], "none");
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
    decorateAllTips();
    ready = true;
    dailyMode = opts.demo ? "demo" : "live";
    if (opts.demo) applyDemoFixtures();
    else renderDailyStats();
    ensureTestHooks();
    if (global.TipLayer && typeof global.TipLayer.bind === "function") {
      global.TipLayer.bind(document);
    }
    return api;
  }

  var api = {
    init: init,
    onModeChange: onModeChange,
    setActive: setActive,
    setStatus: setStatus,
    prettyStatusText: prettyStatusText,
    formatStatusHtml: formatStatusHtml,
    faceMarkup: faceMarkup,
    roleFromAgentHint: roleFromAgentHint,
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
