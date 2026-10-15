(function () {
  "use strict";

  var STEP_MS = 1500;
  var ACTIVITY_CAP = 40;
  var RATES = {
    opus: { in: 4.0, out: 20.0 },
    fable: { in: 10.0, out: 50.0 },
    sonnet: { in: 2.0, out: 10.0 },
    haiku: { in: 0.1, out: 0.5 }
  };
  var BRIDGE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin)
    ? location.origin
    : "http://127.0.0.1:3847";

  var AgentCards = window.AgentCards;
  var cards = {};
  var statusEls = {};

  var demoBtn = document.getElementById("demoBtn");
  var modeDemo = document.getElementById("modeDemo");
  var modeLive = document.getElementById("modeLive");
  var liveHint = document.getElementById("liveHint");
  var livePresenceBanner = document.getElementById("livePresenceBanner");
  var liveCoach = document.getElementById("liveCoach");
  var liveCoachDismiss = document.getElementById("liveCoachDismiss");
  var projectPicker = document.getElementById("projectPicker");
  var footerProject = document.getElementById("footerProject");
  var sessionLog = document.getElementById("sessionLog");
  var logEmpty = document.getElementById("logEmpty");
  var activityRead = document.getElementById("activityRead");
  var activityEdit = document.getElementById("activityEdit");
  var currentProjectLabel = null;
  var currentProjectId = null;
  var selectingProject = false;
  var advisorCallsEl = document.getElementById("advisorCalls");
  var advisorLastEl = document.getElementById("advisorLast");
  var billEls = {
    opusIn: document.getElementById("billOpusIn"),
    opusOut: document.getElementById("billOpusOut"),
    opusCost: document.getElementById("billOpusCost"),
    fableIn: document.getElementById("billFableIn"),
    fableOut: document.getElementById("billFableOut"),
    fableCost: document.getElementById("billFableCost"),
    sonnetIn: document.getElementById("billSonnetIn"),
    sonnetOut: document.getElementById("billSonnetOut"),
    sonnetCost: document.getElementById("billSonnetCost"),
    haikuIn: document.getElementById("billHaikuIn"),
    haikuOut: document.getElementById("billHaikuOut"),
    haikuCost: document.getElementById("billHaikuCost"),
    explorerIn: document.getElementById("billExplorerIn"),
    explorerOut: document.getElementById("billExplorerOut"),
    explorerCost: document.getElementById("billExplorerCost"),
    researcherIn: document.getElementById("billResearcherIn"),
    researcherOut: document.getElementById("billResearcherOut"),
    researcherCost: document.getElementById("billResearcherCost"),
    sessionTotal: document.getElementById("billSessionTotal"),
    allOpus: document.getElementById("billAllOpus"),
    multiplier: document.getElementById("billMultiplier"),
    savingsNote: document.getElementById("billSavingsNote"),
    illustrative: document.getElementById("billIllustrative"),
    shareOpus: document.getElementById("shareOpus"),
    shareFable: document.getElementById("shareFable"),
    shareSonnet: document.getElementById("shareSonnet"),
    shareHaiku: document.getElementById("shareHaiku")
  };
  var asksLabel = document.getElementById("asksLabel");
  var delegatesLabel = document.getElementById("delegatesLabel");
  var hudSessionCost = document.getElementById("hudSessionCost");
  var hudActiveRole = document.getElementById("hudActiveRole");
  var hudSubs = document.getElementById("hudSubs");
  var hudEffort = document.getElementById("hudEffort");
  var hudTokens = document.getElementById("hudTokens");
  /** Estimates glossary. Bill + Insights share this trust-layer wording. */
  var ESTIMATES_DISCLAIMER = "Estimates · not official invoices";
  var lastBridgeScanAt = null;
  var bridgePollMs = 900;
  var hudSyncAge = document.getElementById("hudSyncAge");
  (function ensureHudSyncAge() {
    if (hudSyncAge) return;
    var chips = document.querySelector(".hud-chips");
    if (!chips) return;
    var chip = document.createElement("span");
    chip.className = "hud-chip sync-age";
    chip.setAttribute(
      "title",
      "Near-real file polling · last bridge transcript scan (not hook-level realtime)"
    );
    chip.setAttribute("data-tip", "Sync age");
    chip.setAttribute(
      "data-tip-detail",
      "Near-real file polling · last bridge transcript scan (not hook-level realtime)"
    );
    chip.innerHTML = 'sync <strong id="hudSyncAge">n/a</strong>';
    chips.appendChild(chip);
    hudSyncAge = document.getElementById("hudSyncAge");
  })();
  (function tipExistingSyncAge() {
    var chip = hudSyncAge && hudSyncAge.closest ? hudSyncAge.closest(".hud-chip") : null;
    if (!chip || chip.hasAttribute("data-tip")) return;
    chip.setAttribute("data-tip", "Sync age");
    chip.setAttribute(
      "data-tip-detail",
      "Near-real file polling · last bridge transcript scan (not hook-level realtime)"
    );
  })();
  var stageToast = document.getElementById("stageToast");
  var appEl = document.getElementById("app");
  var drawersEl = document.getElementById("drawers");
  var drawerActivity = document.getElementById("drawerActivity");
  var drawerBill = document.getElementById("drawerBill");
  var drawerLog = document.getElementById("drawerLog");
  var drawerStations = document.getElementById("drawerStations");
  var drawerInsights = document.getElementById("drawerInsights");
  var drawerHistory = document.getElementById("drawerHistory");
  var historyHint = document.getElementById("historyHint");
  var panelsBtn = document.getElementById("panelsBtn");
  var soundBtn = document.getElementById("soundBtn");
  var viewStageBtn = document.getElementById("viewStage");
  var viewInsightsBtn = document.getElementById("viewInsights");
  var viewHistoryBtn = document.getElementById("viewHistory");
  var activityFilterRole = null;
  var toastTimer = null;
  var viewMode = "stage";
  var VIEW_MODE_KEY = "cursorAgents.viewMode";
  var replaySessionActive = false;
  var lastReplayIndex = -1;
  var ReplayStage = window.ReplayStage || null;

  /* Move station cards into Stations drawer (keep same card/status IDs). */
  (function relocateStations() {
    var panel = document.getElementById("stationsPanel");
    var body = document.getElementById("stationsDrawerBody");
    if (panel && body) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      panel.remove();
    }
  })();

  /* Card module after relocate so avatars/privacy/daily-stats mount on final DOM. */
  var isBridgeOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin);
  if (AgentCards && typeof AgentCards.init === "function") {
    AgentCards.init(document.getElementById("stationsDrawerBody"), {
      demo: !isBridgeOrigin
    });
    cards = AgentCards.getCards();
    statusEls = AgentCards.getStatusEls();
  } else {
    cards = {
      opus: document.getElementById("card-opus"),
      advisor: document.getElementById("card-advisor"),
      worker: document.getElementById("card-worker"),
      explorer: document.getElementById("card-explorer"),
      researcher: document.getElementById("card-researcher")
    };
    statusEls = {
      opus: document.getElementById("status-opus"),
      advisor: document.getElementById("status-advisor"),
      worker: document.getElementById("status-worker"),
      explorer: document.getElementById("status-explorer"),
      researcher: document.getElementById("status-researcher")
    };
  }

  var mode = "demo"; /* demo | live */
  var insightsPanel = null;

  /* Insights sheet. Mount inside #drawerInsights (not a stacked sibling under drawers). */
  if (window.Insights && typeof window.Insights.init === "function") {
    try {
      insightsPanel = window.Insights.init(
        document.getElementById("insightsDrawerBody") ||
          document.getElementById("drawerInsights") ||
          document.body,
        { demo: mode === "demo" }
      );
      if (insightsPanel && typeof insightsPanel.onReady === "function") {
        insightsPanel.onReady(remountHistoryReplayIfNeeded);
      }
    } catch (_insightsErr) {}
  }
  /* Replay → stage wiring is registered after onReplayIndexChange is defined (below). */
  var lastDemoUsageTotal = 0;
  var playing = false;
  var timers = [];
  var logSeq = 0;
  /** Live event ids already applied to UI + daily stats, keyed by project scope. */
  var liveSeenByProject = {};
  var es = null;
  var livePoll = null;
  /** True while SSE is draining the bridge's initial backlog (connect / reload / reconnect). */
  var liveSseBacklogReplay = false;
  var liveSseBacklogEndTimer = null;
  var LIVE_SSE_BACKLOG_QUIET_MS = 80;
  /** Live presence: file-origin | connecting | bridge-down | no-projects | quiet-healthy | streaming */
  var livePresence = null;
  var lastLiveEventAt = 0;
  var quietHealthyTimer = null;
  var QUIET_AFTER_MS = 45000;
  var LIVE_ONBOARD_KEY = "ca.liveOnboard.v1";
  var lastShipCelebrateAt = 0;
  var lastSessionCostForShip = 0;
  var jumpHighlightTimer = null;

  function scheduleLiveSseBacklogEnd() {
    if (liveSseBacklogEndTimer) clearTimeout(liveSseBacklogEndTimer);
    liveSseBacklogEndTimer = setTimeout(function () {
      liveSseBacklogReplay = false;
      liveSseBacklogEndTimer = null;
    }, LIVE_SSE_BACKLOG_QUIET_MS);
  }

  function armLiveSseBacklogReplay() {
    liveSseBacklogReplay = true;
    scheduleLiveSseBacklogEnd();
  }

  function touchLiveSseBacklogMessage() {
    if (!liveSseBacklogReplay) return;
    scheduleLiveSseBacklogEnd();
  }

  function clearLiveSseBacklogReplay() {
    if (liveSseBacklogEndTimer) clearTimeout(liveSseBacklogEndTimer);
    liveSseBacklogEndTimer = null;
    liveSseBacklogReplay = false;
  }
  var state = {
    calls: 0,
    subs: 0,
    liveSubs: {},
    usage: emptyUsage(),
    activity: []
  };

  /**
   * Alert snooze (shared with alerts.js via localStorage) also silences workshop audio.
   * Snooze is indefinite: the sentinel never expires until the user un-snoozes, so the
   * suppression lasts as long as the user asked for. Legacy numeric timestamps still work.
   */
  var SNOOZE_KEY = "ca.alerts.snoozeUntil";
  var SNOOZE_INDEFINITE = "indefinite";

  function snoozeUntilMs() {
    try {
      var raw = localStorage.getItem(SNOOZE_KEY);
      if (raw === SNOOZE_INDEFINITE) return Infinity;
      var n = Number(raw || 0);
      return isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  function isSnoozed() {
    return Date.now() < snoozeUntilMs();
  }

  /* Web Audio blips (default muted) */
  var sound = (function () {
    var muted = true;
    var ctx = null;
    try {
      muted = localStorage.getItem("workshopSound") !== "on";
    } catch (_) {}

    /* Audio is silent when the user muted it or while alerts are snoozed. */
    function shouldMute() {
      return muted || isSnoozed();
    }

    function ensure() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    function tone(freq, dur, type, gain, slideTo) {
      if (shouldMute()) return;
      var c = ensure();
      if (!c) return;
      var t0 = c.currentTime;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      var vol = gain == null ? 0.045 : gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    function play(name) {
      if (shouldMute()) return;
      switch (name) {
        case "pop":
          tone(520, 0.09, "triangle", 0.04, 180);
          break;
        case "chime":
          tone(660, 0.12, "sine", 0.035);
          setTimeout(function () {
            tone(990, 0.14, "sine", 0.028);
          }, 70);
          break;
        case "tick":
          tone(1400, 0.04, "square", 0.018);
          break;
        case "edit":
          tone(280, 0.11, "sine", 0.04, 420);
          break;
        case "whoosh":
          tone(220, 0.18, "sawtooth", 0.02, 90);
          break;
        case "spark":
          tone(880, 0.06, "sine", 0.025, 1320);
          break;
        case "click":
          tone(700, 0.03, "triangle", 0.02);
          break;
        default:
          tone(440, 0.06, "sine", 0.03);
      }
    }

    function setMuted(m) {
      muted = !!m;
      try {
        localStorage.setItem("workshopSound", muted ? "off" : "on");
      } catch (_) {}
      syncBtn();
    }

    function toggle() {
      setMuted(!muted);
      if (!muted) {
        ensure();
        play("click");
      }
    }

    function syncBtn() {
      if (!soundBtn) return;
      var silent = shouldMute();
      soundBtn.textContent = silent ? "🔇" : "🔊";
      soundBtn.classList.toggle("on", !silent);
      soundBtn.setAttribute("aria-pressed", silent ? "false" : "true");
      if (muted) soundBtn.title = "Sound off (click to unmute)";
      else if (isSnoozed()) soundBtn.title = "Snoozed · sound resumes when you un-snooze alerts";
      else soundBtn.title = "Sound on (click to mute)";
    }

    syncBtn();
    return {
      play: play,
      toggle: toggle,
      isMuted: function () {
        return shouldMute();
      },
      syncBtn: syncBtn
    };
  })();

  /* Stage director: characters, crates, portal */
  var CHAR_HOME = {
    opus: { x: 180, y: 150 },
    advisor: { x: 820, y: 150 },
    worker: { x: 500, y: 280 },
    explorer: { x: 280, y: 360 },
    researcher: { x: 720, y: 360 }
  };
  var PORTAL_PT = { x: 500, y: 445 };
  var ROLE_LABEL = {
    opus: "Opus",
    advisor: "Fable",
    worker: "Sonnet",
    explorer: "Explore",
    researcher: "Research"
  };

  var stageDirector = (function () {
    var cratesLayer = document.getElementById("cratesLayer");
    var sparksLayer = document.getElementById("sparksLayer");
    var portal = document.getElementById("mergePortal");
    var chars = {
      opus: document.getElementById("char-opus"),
      advisor: document.getElementById("char-advisor"),
      worker: document.getElementById("char-worker"),
      explorer: document.getElementById("char-explorer"),
      researcher: document.getElementById("char-researcher")
    };
    var walkTimers = {};

    function setCharacterState(role, on) {
      var el = chars[role];
      if (!el) return;
      el.classList.toggle("busy", !!on);
    }

    function setActiveRoles(roles) {
      var set = {};
      (roles || []).forEach(function (r) {
        set[r] = true;
      });
      Object.keys(chars).forEach(function (key) {
        setCharacterState(key, !!set[key]);
      });
      if (hudActiveRole) {
        var labels = (roles || []).map(function (r) {
          return ROLE_LABEL[r] || r;
        });
        hudActiveRole.textContent = labels.length ? labels.join(" · ") : "n/a";
      }
    }

    function selectCharacter(role) {
      Object.keys(chars).forEach(function (key) {
        if (chars[key]) chars[key].classList.toggle("selected", key === role);
      });
    }

    function clearSelection() {
      Object.keys(chars).forEach(function (key) {
        if (chars[key]) chars[key].classList.remove("selected");
      });
    }

    function pulsePortal() {
      if (!portal) return;
      portal.classList.remove("inhale");
      void portal.offsetWidth;
      portal.classList.add("inhale");
      setTimeout(
        function () {
          portal.classList.remove("inhale");
        },
        prefersReducedMotion() ? 120 : 750
      );
    }

    function tipSpark(role) {
      if (!sparksLayer) return;
      var home = CHAR_HOME[role] || CHAR_HOME.opus;
      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "tip-spark pop");
      g.setAttribute("transform", "translate(" + home.x + " " + (home.y - 28) + ")");
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", "5");
      c.setAttribute(
        "fill",
        role === "advisor"
          ? "#f5a524"
          : role === "worker"
            ? "#3ecfff"
            : role === "opus"
              ? "#f2f4f4"
              : "#b8f000"
      );
      g.appendChild(c);
      var t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("y", "-8");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#b8f000");
      t.setAttribute("font-size", "9");
      t.setAttribute("font-family", "ui-monospace, monospace");
      t.textContent = "$";
      g.appendChild(t);
      sparksLayer.appendChild(g);
      sound.play("spark");
      setTimeout(
        function () {
          if (g.parentNode) g.parentNode.removeChild(g);
        },
        prefersReducedMotion() ? 200 : 700
      );
    }

    function spawnCrate(activity) {
      if (!cratesLayer || !activity) return;
      var role = activity.role === "parent" ? "opus" : activity.role || "explorer";
      if (!CHAR_HOME[role]) role = "explorer";
      var kind = activityKindBucket(activity.kind);
      var from = CHAR_HOME[role];
      var to = PORTAL_PT;
      var reduce = prefersReducedMotion();
      var narrow = window.matchMedia("(max-width: 900px)").matches;

      var el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      el.setAttribute("class", "crate flying " + (kind === "edit" ? "code" : "page"));
      el.setAttribute("width", kind === "edit" ? "14" : "11");
      el.setAttribute("height", kind === "edit" ? "11" : "14");
      el.setAttribute("rx", "4");
      el.setAttribute("x", String(from.x - 6));
      el.setAttribute("y", String(from.y - 10));
      el.dataset.path = activity.path || "n/a";
      el.dataset.detail = activity.detail || kind;
      el.dataset.role = role;
      el.setAttribute("data-tip", activity.path || "Crate");
      el.setAttribute(
        "data-tip-detail",
        (ROLE_LABEL[role] || role) +
          " · " +
          (kind === "edit" ? "edit crate" : "read crate") +
          (activity.detail ? " · " + activity.detail : "") +
          " → merge"
      );
      cratesLayer.appendChild(el);

      if (kind === "edit") sound.play("edit");
      else sound.play("tick");

      if (!reduce && !narrow) {
        var start = performance.now();
        var dur = 900;
        function frame(now) {
          var p = Math.min(1, (now - start) / dur);
          var ease = 1 - Math.pow(1 - p, 2.4);
          var x = from.x + (to.x - from.x) * ease;
          var y = from.y + (to.y - from.y) * ease - Math.sin(Math.PI * ease) * 55;
          el.setAttribute("x", String(x - 6));
          el.setAttribute("y", String(y - 6));
          if (p < 1) {
            requestAnimationFrame(frame);
          } else {
            sound.play("pop");
            pulsePortal();
            setTimeout(function () {
              if (el.parentNode) el.parentNode.removeChild(el);
            }, 180);
          }
        }
        requestAnimationFrame(frame);
      } else {
        el.setAttribute("x", String(to.x - 6));
        el.setAttribute("y", String(to.y - 8));
        el.style.opacity = "0.7";
        pulsePortal();
        sound.play("pop");
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 400);
      }
    }

    var ROUTE_TOKEN_PATH = {
      advisor: "path-asks-pulse",
      worker: "path-d-worker-pulse",
      explorer: "path-d-explorer-pulse",
      researcher: "path-d-researcher-pulse"
    };
    var ROUTE_TOKEN_CFG = {
      advisor: {
        duration: 880,
        easePow: 2.6,
        bobAmp: 7,
        bobFreq: 1.4,
        wiggleAmp: 0,
        liftAmp: 0,
        landHop: false
      },
      worker: {
        duration: 700,
        easePow: 1.7,
        bobAmp: 3,
        bobFreq: 2.2,
        wiggleAmp: 0,
        liftAmp: 0,
        landHop: true
      },
      explorer: {
        duration: 920,
        easePow: 2.2,
        bobAmp: 0,
        bobFreq: 1,
        wiggleAmp: 9,
        liftAmp: 18,
        landHop: false
      },
      researcher: {
        duration: 900,
        easePow: 2.9,
        bobAmp: 5,
        bobFreq: 1.1,
        wiggleAmp: 0,
        liftAmp: 4,
        landHop: false
      }
    };
    var MAX_ROUTE_TOKENS = 3;
    var activeRouteTokens = [];

    function removeRouteToken(el) {
      var idx = activeRouteTokens.indexOf(el);
      if (idx >= 0) activeRouteTokens.splice(idx, 1);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function landCatch(role) {
      var char = chars[role];
      if (!char) return;
      char.classList.add("catching");
      if (ROUTE_TOKEN_CFG[role] && ROUTE_TOKEN_CFG[role].landHop) {
        char.classList.add("catch-hop");
      }
      setTimeout(function () {
        if (!chars[role]) return;
        chars[role].classList.remove("catching", "catch-hop");
      }, 250);
    }

    /**
     * Fly a small role-shaped glyph along the inbound pulse path into a station.
     * Called from animateRoute on ask/delegate. Caps concurrent tokens; reduced
     * motion / narrow layouts snap to the end with a brief land catch.
     * @param {string} role - advisor | worker | explorer | researcher
     */
    function spawnRouteToken(role) {
      if (!cratesLayer || !role || !ROUTE_TOKEN_PATH[role]) return;
      var path = document.getElementById(ROUTE_TOKEN_PATH[role]);
      if (!path || typeof path.getTotalLength !== "function") return;
      var cfg = ROUTE_TOKEN_CFG[role];
      var reduce = prefersReducedMotion();
      var narrow = window.matchMedia("(max-width: 900px)").matches;
      var total = path.getTotalLength();
      if (!total) return;

      while (activeRouteTokens.length >= MAX_ROUTE_TOKENS) {
        removeRouteToken(activeRouteTokens[0]);
      }

      var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "route-token role-" + role + " flying");
      g.setAttribute("data-role", role);
      g.setAttribute("pointer-events", "none");

      var body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      body.setAttribute("class", "block-agent-fill");
      body.setAttribute("x", "-8");
      body.setAttribute("y", "-6");
      body.setAttribute("width", "16");
      body.setAttribute("height", "10");
      g.appendChild(body);
      ["-4", "2"].forEach(function (ex) {
        var eye = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        eye.setAttribute("class", "block-agent-eye");
        eye.setAttribute("x", ex);
        eye.setAttribute("y", "-3");
        eye.setAttribute("width", "2.5");
        eye.setAttribute("height", "2.5");
        g.appendChild(eye);
      });

      function placeAt(dist, t) {
        var pt = path.getPointAtLength(Math.max(0, Math.min(total, dist)));
        var bob = cfg.bobAmp ? Math.sin(t * Math.PI * cfg.bobFreq) * cfg.bobAmp : 0;
        var lift = cfg.liftAmp ? Math.sin(Math.PI * t) * cfg.liftAmp : 0;
        var wig = cfg.wiggleAmp ? Math.sin(t * Math.PI * 3) * cfg.wiggleAmp : 0;
        g.setAttribute("transform", "translate(" + (pt.x + wig) + " " + (pt.y + bob - lift) + ")");
      }

      placeAt(0, 0);
      cratesLayer.appendChild(g);
      activeRouteTokens.push(g);

      if (!reduce && !narrow) {
        var start = performance.now();
        var dur = cfg.duration;
        function frame(now) {
          if (!g.parentNode) return;
          var p = Math.min(1, (now - start) / dur);
          var ease = 1 - Math.pow(1 - p, cfg.easePow);
          placeAt(total * ease, ease);
          if (p < 1) {
            requestAnimationFrame(frame);
          } else {
            landCatch(role);
            setTimeout(function () {
              removeRouteToken(g);
            }, 120);
          }
        }
        requestAnimationFrame(frame);
      } else {
        placeAt(total, 1);
        g.style.opacity = "0.7";
        landCatch(role);
        setTimeout(function () {
          removeRouteToken(g);
        }, 220);
      }
    }

    function playRoute(route, routeTo) {
      sound.play(route === "asks" ? "chime" : "whoosh");
      var walker = null;
      if (route === "asks") walker = "advisor";
      else if (route === "delegates") walker = routeTo || "worker";
      if (!walker || !chars[walker]) return;
      if (window.matchMedia("(max-width: 900px)").matches || prefersReducedMotion()) {
        chars[walker].classList.add("busy");
        return;
      }
      chars[walker].classList.add("walking", "busy");
      if (walkTimers[walker]) clearTimeout(walkTimers[walker]);
      walkTimers[walker] = setTimeout(function () {
        if (chars[walker]) chars[walker].classList.remove("walking");
      }, 850);
    }

    function reset() {
      Object.keys(chars).forEach(function (key) {
        if (!chars[key]) return;
        chars[key].classList.remove("busy", "walking", "selected", "catching", "catch-hop");
        if (walkTimers[key]) {
          clearTimeout(walkTimers[key]);
          delete walkTimers[key];
        }
      });
      activeRouteTokens.length = 0;
      if (cratesLayer) cratesLayer.innerHTML = "";
      if (sparksLayer) sparksLayer.innerHTML = "";
      if (portal) portal.classList.remove("inhale");
      if (hudActiveRole) hudActiveRole.textContent = "n/a";
      clearSelection();
      hideTooltip();
    }

    return {
      setCharacterState: setCharacterState,
      setActiveRoles: setActiveRoles,
      selectCharacter: selectCharacter,
      clearSelection: clearSelection,
      spawnCrate: spawnCrate,
      spawnRouteToken: spawnRouteToken,
      playRoute: playRoute,
      tipSpark: tipSpark,
      pulsePortal: pulsePortal,
      reset: reset,
      chars: chars
    };
  })();

  function showToast(msg) {
    if (!stageToast) return;
    stageToast.textContent = msg;
    stageToast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      stageToast.classList.remove("show");
    }, 1600);
  }

  function hideTooltip() {
    if (window.TipLayer && typeof window.TipLayer.hide === "function") {
      window.TipLayer.hide();
    }
  }

  function showCrateTooltip(ev, el) {
    if (!el || !window.TipLayer || typeof window.TipLayer.show !== "function") return;
    var tip = el.dataset.path || "n/a";
    var detail = (el.dataset.role || "") + (el.dataset.detail ? " · " + el.dataset.detail : "");
    window.TipLayer.show({ tip: tip, detail: detail }, ev);
  }

  function openActivityDrawer(filterRole) {
    activityFilterRole = filterRole || null;
    if (drawerActivity) drawerActivity.open = true;
    renderActivity();
    sound.play("click");
  }

  function normalizeJumpRole(role) {
    var r = String(role || "").toLowerCase();
    if (r === "parent" || r === "opus") return "opus";
    if (r === "advisor" || r === "fable") return "advisor";
    if (r === "worker" || r === "sonnet") return "worker";
    if (r === "explorer") return "explorer";
    if (r === "researcher") return "researcher";
    return "";
  }

  /**
   * Shared stage focus: select character, Activity filter, scroll card, toast.
   * @param {{ role?: string, agentId?: string, name?: string, model?: string }} opts
   */
  function jumpToAgent(opts) {
    opts = opts || {};
    var role = normalizeJumpRole(opts.role);
    if (!role && ReplayStage && typeof ReplayStage.roleFromHistory === "function") {
      role = normalizeJumpRole(
        ReplayStage.roleFromHistory({
          agentId: opts.agentId,
          name: opts.name,
          model: opts.model
        })
      );
    }
    if (!role) role = "opus";

    stageDirector.selectCharacter(role);
    openActivityDrawer(role);
    if (drawerStations) drawerStations.open = true;

    var label = opts.name || ROLE_LABEL[role] || role;
    showToast(label + " · filtering Activity");

    var card = cards[role];
    if (card) {
      card.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth"
      });
      card.classList.add("jump-highlight");
      if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);
      jumpHighlightTimer = setTimeout(
        function () {
          card.classList.remove("jump-highlight");
          jumpHighlightTimer = null;
        },
        prefersReducedMotion() ? 400 : 1400
      );
    }
    return role;
  }

  function onJumpToAgentEvent(ev) {
    var d = (ev && ev.detail) || {};
    jumpToAgent({
      role: d.role,
      agentId: d.agentId,
      name: d.name,
      model: d.model
    });
  }

  function sessionCostTotal() {
    var u = state.usage;
    return (
      modelCost("opus", u.opus.in, u.opus.out) +
      modelCost("fable", u.fable.in, u.fable.out) +
      modelCost("sonnet", u.sonnet.in, u.sonnet.out) +
      modelCost("haiku", u.haiku.in, u.haiku.out)
    );
  }

  function triggerShipCelebration(roles, label) {
    var now = Date.now();
    if (now - lastShipCelebrateAt < 8000) return;
    lastShipCelebrateAt = now;
    var cost = sessionCostTotal();
    var delta = Math.max(0, cost - lastSessionCostForShip);
    lastSessionCostForShip = cost;

    stageDirector.pulsePortal();
    var roleLabel = label || "";
    if (!roleLabel && roles && roles.length) {
      roleLabel = ROLE_LABEL[roles[0]] || roles[0];
    }
    if (!roleLabel) roleLabel = "Session";
    var toast = roleLabel + " · shipped";
    if (delta > 0.0005) toast += " · +" + formatMoney(delta);
    showToast(toast);
    if (AgentCards && typeof AgentCards.celebrateShip === "function") {
      AgentCards.celebrateShip(roles);
    }
    sound.play("chime");
  }

  function looksLikeShipEvent(ev, role, cardRole) {
    if (!ev) return false;
    if (ev.kind === "done" || ev.type === "done") return true;
    var msg = String(ev.message || "");
    if (/\b(Reviewed · shipped|shipped|ship it)\b/i.test(msg)) return true;
    if (/\bmerge(d)?\b/i.test(msg) && (role === "parent" || cardRole === "opus")) return true;
    return false;
  }

  function hasSeenLiveOnboard() {
    try {
      return localStorage.getItem(LIVE_ONBOARD_KEY) === "1";
    } catch (_) {
      return true;
    }
  }

  function markLiveOnboardSeen() {
    try {
      localStorage.setItem(LIVE_ONBOARD_KEY, "1");
    } catch (_) {}
  }

  function setLiveCoachVisible(show) {
    if (!liveCoach) return;
    liveCoach.hidden = !show;
  }

  function maybeShowLiveCoach() {
    if (mode !== "live") {
      setLiveCoachVisible(false);
      return;
    }
    if (livePresence === "file-origin" || livePresence === "bridge-down") {
      setLiveCoachVisible(false);
      return;
    }
    setLiveCoachVisible(!hasSeenLiveOnboard());
  }

  function clearQuietHealthyTimer() {
    if (quietHealthyTimer) {
      clearTimeout(quietHealthyTimer);
      quietHealthyTimer = null;
    }
  }

  function scheduleQuietHealthy() {
    clearQuietHealthyTimer();
    if (mode !== "live") return;
    if (
      livePresence === "bridge-down" ||
      livePresence === "file-origin" ||
      livePresence === "connecting" ||
      livePresence === "no-projects"
    ) {
      return;
    }
    quietHealthyTimer = setTimeout(function () {
      quietHealthyTimer = null;
      if (mode !== "live") return;
      if (!demoBtn.classList.contains("live-connected")) return;
      if (livePresence === "no-projects") return;
      setLivePresence("quiet-healthy");
    }, QUIET_AFTER_MS);
  }

  function presenceHintLabel() {
    return currentProjectLabel || "agent-transcripts";
  }

  function refreshEmptyLogIfIdle() {
    if (!sessionLog) return;
    if (sessionLog.querySelector(".log-line")) return;
    var empty = document.getElementById("logEmpty") || logEmpty;
    if (empty) empty.textContent = emptyLogMessage();
  }

  /**
   * Single source of truth for Live hint + stage banner + empty log copy.
   */
  function setLivePresence(state, detail) {
    livePresence = state || null;
    if (appEl) {
      if (mode === "live" && livePresence) appEl.setAttribute("data-live-presence", livePresence);
      else appEl.removeAttribute("data-live-presence");
    }

    if (mode !== "live") {
      if (livePresenceBanner) {
        livePresenceBanner.hidden = true;
        livePresenceBanner.textContent = "";
        livePresenceBanner.className = "live-presence-banner";
      }
      setLiveCoachVisible(false);
      return;
    }

    var hint = liveHint;
    var banner = livePresenceBanner;
    var label = presenceHintLabel();
    var bannerText = "";
    var bannerClass = "live-presence-banner";
    var showBanner = false;

    if (state === "file-origin") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent =
          detail ||
          "Live needs the bridge. Open " + BRIDGE.replace(/\/$/, "") + "/ (or run npm start)";
      }
      bannerText =
        "Open Electron (npm start) or " +
        BRIDGE.replace(/\/$/, "") +
        ". file:// pages cannot stream Live.";
      bannerClass += " file-origin";
      showBanner = true;
    } else if (state === "connecting") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint";
        hint.textContent = detail || "Connecting to " + BRIDGE + "…";
      }
      bannerText = "Connecting to the Live bridge…";
      bannerClass += " connecting";
      showBanner = true;
    } else if (state === "bridge-down") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent = detail || "Bridge offline. Use npm start or node live-bridge.js";
      }
      bannerText =
        "Bridge offline · stations may look idle. Start the bridge, then click Reconnect.";
      bannerClass += " bridge-down";
      showBanner = true;
    } else if (state === "no-projects") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent = detail || "Connected · no Cursor projects found";
      }
      bannerText =
        "No Cursor projects found under agent-transcripts. Open a project in Cursor, then Reconnect.";
      bannerClass += " no-projects";
      showBanner = true;
    } else if (state === "quiet-healthy") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint quiet";
        hint.textContent = "Quiet · waiting for transcript activity · " + label;
      }
      bannerText = "Workshop idle · bridge online, waiting for transcript activity.";
      bannerClass += " quiet-healthy";
      showBanner = true;
    } else if (state === "streaming") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint ok";
        hint.textContent = "Streaming · " + label;
      }
      showBanner = false;
    }

    if (banner) {
      banner.className = bannerClass;
      banner.textContent = bannerText;
      banner.hidden = !showBanner;
    }

    refreshEmptyLogIfIdle();
    maybeShowLiveCoach();
  }

  function normalizeViewMode(mode) {
    var m = String(mode || "").toLowerCase();
    if (m === "insights" || m === "history") return m;
    return "stage";
  }

  function syncViewModeButtons(mode) {
    var buttons = [
      { el: viewStageBtn, mode: "stage" },
      { el: viewInsightsBtn, mode: "insights" },
      { el: viewHistoryBtn, mode: "history" }
    ];
    buttons.forEach(function (b) {
      if (!b.el) return;
      var on = b.mode === mode;
      b.el.classList.toggle("on", on);
      b.el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function updateHistoryHint(driving) {
    if (!historyHint) return;
    historyHint.textContent = driving
      ? "Replay driving stage"
      : "Play or scrub to drive the workshop stage.";
  }

  function mountHistoryReplay() {
    var host = document.getElementById("historyReplayHost");
    if (!host || !insightsPanel || typeof insightsPanel.mountReplay !== "function") return;
    insightsPanel.mountReplay(host);
    try {
      var playBtn = host.querySelector(".insights-transport-btn");
      (playBtn || host).scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_) {}
  }

  function remountHistoryReplayIfNeeded() {
    if (viewMode !== "history") return;
    mountHistoryReplay();
  }

  if (drawerHistory) {
    drawerHistory.addEventListener("toggle", function () {
      if (drawerHistory.open && viewMode === "history") mountHistoryReplay();
    });
  }

  /**
   * Primary nav: Stage | Insights | History.
   * Sets `data-view-mode` on #app, syncs header buttons, persists to sessionStorage
   * (unless opts.skipPersist). Each mode opens the matching lower drawer and closes others:
   * stage → Activity; insights → Insights (forecast tab); history → History (replay tab,
   * remounts replay transport, scrolls drawer into view; does not auto-play).
   */
  function setViewMode(mode, opts) {
    opts = opts || {};
    viewMode = normalizeViewMode(mode);
    if (appEl) appEl.setAttribute("data-view-mode", viewMode);
    syncViewModeButtons(viewMode);
    if (!opts.skipPersist) {
      try {
        sessionStorage.setItem(VIEW_MODE_KEY, viewMode);
      } catch (_) {}
    }

    if (viewMode === "stage") {
      if (drawerInsights) drawerInsights.open = false;
      if (drawerHistory) drawerHistory.open = false;
      if (drawerActivity) drawerActivity.open = true;
      endReplaySession();
    } else if (viewMode === "insights") {
      if (drawerHistory) drawerHistory.open = false;
      if (drawerActivity) drawerActivity.open = false;
      if (drawerInsights) drawerInsights.open = true;
      if (insightsPanel && typeof insightsPanel.showTab === "function") {
        insightsPanel.showTab("forecast");
      }
      if (insightsPanel && typeof insightsPanel.pause === "function") insightsPanel.pause();
    } else if (viewMode === "history") {
      if (drawerInsights) drawerInsights.open = false;
      if (drawerActivity) drawerActivity.open = false;
      if (drawerStations) drawerStations.open = false;
      if (drawerBill) drawerBill.open = false;
      if (drawerLog) drawerLog.open = false;
      if (drawerHistory) {
        drawerHistory.open = true;
        try {
          drawerHistory.scrollIntoView({ block: "start", behavior: "smooth" });
          drawerHistory.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch (_) {}
      }
      updateHistoryHint(false);
      if (insightsPanel) {
        if (typeof insightsPanel.showTab === "function") insightsPanel.showTab("replay");
        mountHistoryReplay();
        /* Do not auto-play. User hits Play in History transport. */
        if (typeof insightsPanel.pause === "function") insightsPanel.pause();
      }
    }

    if (viewMode !== "history" && insightsPanel && typeof insightsPanel.pause === "function") {
      insightsPanel.pause();
    }
  }

  function openPanels() {
    if (drawerBill) drawerBill.open = true;
    if (drawerLog) drawerLog.open = true;
    if (drawerInsights) drawerInsights.open = true;
    if (drawersEl) drawersEl.classList.add("panels-open");
    if (panelsBtn) {
      panelsBtn.classList.add("on");
      panelsBtn.setAttribute("aria-pressed", "true");
      panelsBtn.setAttribute("title", "Open panels");
      panelsBtn.setAttribute("aria-label", "Open panels");
    }
  }

  function togglePanels() {
    var anyOpen =
      (drawerBill && drawerBill.open) ||
      (drawerLog && drawerLog.open) ||
      (drawerInsights && drawerInsights.open && viewMode === "stage");
    if (anyOpen) {
      if (drawerBill) drawerBill.open = false;
      if (drawerLog) drawerLog.open = false;
      if (viewMode === "stage" && drawerInsights) drawerInsights.open = false;
      if (drawersEl) drawersEl.classList.remove("panels-open");
      if (panelsBtn) {
        panelsBtn.classList.remove("on");
        panelsBtn.setAttribute("aria-pressed", "false");
      }
    } else {
      openPanels();
    }
    sound.play("click");
  }

  function emptyUsage() {
    return {
      opus: { in: 0, out: 0 },
      fable: { in: 0, out: 0 },
      sonnet: { in: 0, out: 0 },
      haiku: { in: 0, out: 0 },
      explorer: { in: 0, out: 0 },
      researcher: { in: 0, out: 0 }
    };
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function clearTimers() {
    timers.forEach(function (t) {
      clearTimeout(t);
    });
    timers = [];
  }

  function setActive(roles, opts) {
    if (AgentCards && typeof AgentCards.setActive === "function") {
      AgentCards.setActive(roles || [], opts);
    } else {
      var set = {};
      (roles || []).forEach(function (r) {
        set[r] = true;
      });
      Object.keys(cards).forEach(function (key) {
        if (cards[key]) cards[key].classList.toggle("active", !!set[key]);
      });
    }
    stageDirector.setActiveRoles(roles || []);
  }

  /* Live only: non-opus cards stay lit across parent active:["opus"] chatter. */
  var STICKY_MS = 14000;
  var stickyActive = {};
  var lastLiveActive = [];
  var stickyTimer = null;

  function clearStickyActive() {
    stickyActive = {};
    lastLiveActive = [];
    if (stickyTimer) {
      clearTimeout(stickyTimer);
      stickyTimer = null;
    }
  }

  function pruneStickyActive(now) {
    now = now || Date.now();
    Object.keys(stickyActive).forEach(function (card) {
      if (!(stickyActive[card] > now)) delete stickyActive[card];
    });
  }

  function scheduleStickyExpiry() {
    if (stickyTimer) {
      clearTimeout(stickyTimer);
      stickyTimer = null;
    }
    var next = 0;
    Object.keys(stickyActive).forEach(function (card) {
      var exp = stickyActive[card];
      if (!next || exp < next) next = exp;
    });
    if (!next) return;
    stickyTimer = setTimeout(
      function () {
        stickyTimer = null;
        pruneStickyActive();
        if (mode !== "live") return;
        setActive(mergeStickyActive(lastLiveActive));
        scheduleStickyExpiry();
      },
      Math.max(0, next - Date.now()) + 30
    );
  }

  function nonOpusCards(active) {
    var out = [];
    var seen = {};
    (active || []).forEach(function (card) {
      if (!card || card === "opus" || seen[card] || !cards[card]) return;
      seen[card] = true;
      out.push(card);
    });
    return out;
  }

  function touchStickyActive(stick) {
    var now = Date.now();
    pruneStickyActive(now);
    stick.forEach(function (card) {
      stickyActive[card] = now + STICKY_MS;
    });
    scheduleStickyExpiry();
  }

  function mergeStickyActive(active) {
    pruneStickyActive();
    var merged = [];
    var seen = {};
    (active || []).forEach(function (card) {
      if (!card || seen[card]) return;
      seen[card] = true;
      merged.push(card);
    });
    Object.keys(stickyActive).forEach(function (card) {
      if (!seen[card]) {
        seen[card] = true;
        merged.push(card);
      }
    });
    return merged;
  }

  function rememberLiveFocus(explicit, active) {
    lastLiveActive = (active || []).slice();
    if (explicit && explicit.length === 0) {
      stickyActive = {};
      if (stickyTimer) {
        clearTimeout(stickyTimer);
        stickyTimer = null;
      }
      return;
    }
    var stick = nonOpusCards(active);
    if (stick.length) {
      touchStickyActive(stick);
      return;
    }
    pruneStickyActive();
    scheduleStickyExpiry();
  }

  function setStatus(role, html, cls) {
    if (AgentCards && typeof AgentCards.setStatus === "function") {
      AgentCards.setStatus(role, html, cls);
      return;
    }
    var el = statusEls[role];
    if (!el) return;
    el.className = "status" + (cls ? " " + cls : "");
    el.innerHTML = html;
  }

  function usageGrandTotal(usage) {
    var t = 0;
    if (!usage) return 0;
    Object.keys(usage).forEach(function (key) {
      if (key === "explorer" || key === "researcher") return;
      var bucket = usage[key];
      if (!bucket) return;
      t += (Number(bucket.in) || 0) + (Number(bucket.out) || 0);
    });
    return t;
  }

  function syncDailyStatsFromUsage() {
    if (!AgentCards) return;
    if (mode === "live") {
      if (typeof AgentCards.syncLiveSubs === "function") AgentCards.syncLiveSubs(state.subs);
      return;
    }
    var total = usageGrandTotal(state.usage);
    var delta = total - lastDemoUsageTotal;
    if (delta > 0 && typeof AgentCards.addTokens === "function") AgentCards.addTokens(delta);
    lastDemoUsageTotal = total;
  }

  function formatTokens(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1000000) {
      return (n / 1000000).toFixed(n % 100000 === 0 ? 1 : 2).replace(/\.00$/, ".0") + "M";
    }
    if (n >= 1000) return Math.round(n / 1000) + "K";
    return String(n);
  }

  function formatMoney(n) {
    if (!isFinite(n) || n < 0) n = 0;
    if (n > 0 && n < 0.01) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
  }

  function normalizeModel(model, role) {
    var m = String(model || "").toLowerCase();
    var r = String(role || "").toLowerCase();
    if (m === "opus" || m === "fable" || m === "sonnet" || m === "haiku") return m;
    if (r === "parent" || r === "opus") return "opus";
    if (r === "advisor" || r === "fable") return "fable";
    if (r === "worker" || r === "sonnet") return "sonnet";
    if (r === "explorer" || r === "researcher" || r === "haiku") return "haiku";
    return "opus";
  }

  function modelCost(model, inn, out) {
    var rates = RATES[model] || RATES.opus;
    return (inn / 1000000) * rates.in + (out / 1000000) * rates.out;
  }

  function renderBill() {
    var u = state.usage;
    var costs = {
      opus: modelCost("opus", u.opus.in, u.opus.out),
      fable: modelCost("fable", u.fable.in, u.fable.out),
      sonnet: modelCost("sonnet", u.sonnet.in, u.sonnet.out),
      haiku: modelCost("haiku", u.haiku.in, u.haiku.out),
      explorer: modelCost("haiku", u.explorer.in, u.explorer.out),
      researcher: modelCost("haiku", u.researcher.in, u.researcher.out)
    };
    billEls.opusIn.textContent = formatTokens(u.opus.in);
    billEls.opusOut.textContent = formatTokens(u.opus.out);
    billEls.opusCost.textContent = formatMoney(costs.opus);
    billEls.fableIn.textContent = formatTokens(u.fable.in);
    billEls.fableOut.textContent = formatTokens(u.fable.out);
    billEls.fableCost.textContent = formatMoney(costs.fable);
    billEls.sonnetIn.textContent = formatTokens(u.sonnet.in);
    billEls.sonnetOut.textContent = formatTokens(u.sonnet.out);
    billEls.sonnetCost.textContent = formatMoney(costs.sonnet);
    billEls.haikuIn.textContent = formatTokens(u.haiku.in);
    billEls.haikuOut.textContent = formatTokens(u.haiku.out);
    billEls.haikuCost.textContent = formatMoney(costs.haiku);
    billEls.explorerIn.textContent = formatTokens(u.explorer.in);
    billEls.explorerOut.textContent = formatTokens(u.explorer.out);
    billEls.explorerCost.textContent = formatMoney(costs.explorer);
    billEls.researcherIn.textContent = formatTokens(u.researcher.in);
    billEls.researcherOut.textContent = formatTokens(u.researcher.out);
    billEls.researcherCost.textContent = formatMoney(costs.researcher);

    var sessionTotal = costs.opus + costs.fable + costs.sonnet + costs.haiku;
    var totalIn = u.opus.in + u.fable.in + u.sonnet.in + u.haiku.in;
    var totalOut = u.opus.out + u.fable.out + u.sonnet.out + u.haiku.out;
    var allOpus = modelCost("opus", totalIn, totalOut);

    billEls.sessionTotal.textContent = formatMoney(sessionTotal);
    billEls.allOpus.textContent = formatMoney(allOpus);
    if (hudSessionCost) hudSessionCost.textContent = formatMoney(sessionTotal);
    if (hudTokens) hudTokens.textContent = formatTokens(u.haiku.in + u.haiku.out);

    if (sessionTotal > 0 && allOpus > sessionTotal) {
      var mult = allOpus / Math.max(sessionTotal, 0.0001);
      billEls.multiplier.textContent =
        "~" + (mult >= 10 ? Math.round(mult) : mult.toFixed(1)) + "×";
      billEls.savingsNote.textContent =
        formatMoney(allOpus) + " → " + formatMoney(sessionTotal) + " · vs all-Opus";
    } else if (sessionTotal > 0) {
      billEls.multiplier.textContent = "~1×";
      billEls.savingsNote.textContent = "routed cost near all-Opus";
    } else {
      billEls.multiplier.textContent = "n/a";
      billEls.savingsNote.textContent = "savings vs all-Opus";
    }

    var shareTotal = sessionTotal || 0;
    function setShare(el, cost) {
      var pct = shareTotal > 0 ? (cost / shareTotal) * 100 : 0;
      el.style.width = pct + "%";
    }
    setShare(billEls.shareOpus, costs.opus);
    setShare(billEls.shareFable, costs.fable);
    setShare(billEls.shareSonnet, costs.sonnet);
    setShare(billEls.shareHaiku, costs.haiku);
  }

  function addUsage(usage, opts) {
    opts = opts || {};
    if (!usage) return;
    var role = String(usage.role || "").toLowerCase();
    var model = normalizeModel(usage.model, role);
    var inn = Math.max(0, Number(usage.in) || 0);
    var out = Math.max(0, Number(usage.out) || 0);
    if (!inn && !out) return;
    state.usage[model].in += inn;
    state.usage[model].out += out;
    if (role === "explorer" || role === "researcher") {
      state.usage[role].in += inn;
      state.usage[role].out += out;
    } else if (model === "haiku") {
      /* Live may send model=haiku without role. Attribute to explorer by default */
      state.usage.explorer.in += inn;
      state.usage.explorer.out += out;
    }
    renderBill();
    var sparkRole =
      role === "advisor" || role === "fable"
        ? "advisor"
        : role === "worker" || role === "sonnet"
          ? "worker"
          : role === "explorer"
            ? "explorer"
            : role === "researcher"
              ? "researcher"
              : model === "fable"
                ? "advisor"
                : model === "sonnet"
                  ? "worker"
                  : model === "haiku"
                    ? "explorer"
                    : "opus";
    stageDirector.tipSpark(sparkRole);
    if (opts.skipDaily) return;
    if (mode === "live" && AgentCards && typeof AgentCards.addTokens === "function") {
      AgentCards.addTokens(inn + out, sparkRole);
    } else {
      syncDailyStatsFromUsage();
    }
  }

  function setUsageSnapshot(snap, sparkRole) {
    state.usage = emptyUsage();
    if (!snap) {
      renderBill();
      return;
    }
    ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"].forEach(function (key) {
      if (!snap[key]) return;
      state.usage[key].in = Math.max(0, Number(snap[key].in) || 0);
      state.usage[key].out = Math.max(0, Number(snap[key].out) || 0);
    });
    /* Keep Haiku total as max of sum of sublines vs explicit haiku */
    var subIn = state.usage.explorer.in + state.usage.researcher.in;
    var subOut = state.usage.explorer.out + state.usage.researcher.out;
    if (subIn > state.usage.haiku.in) state.usage.haiku.in = subIn;
    if (subOut > state.usage.haiku.out) state.usage.haiku.out = subOut;
    renderBill();
    if (sparkRole) stageDirector.tipSpark(sparkRole);
    syncDailyStatsFromUsage();
  }

  function clearActivity() {
    state.activity = [];
    if (activityRead) {
      activityRead.innerHTML = "";
      var er = document.createElement("div");
      er.className = "activity-empty";
      er.id = "activityReadEmpty";
      er.textContent = "No reads yet…";
      activityRead.appendChild(er);
    }
    if (activityEdit) {
      activityEdit.innerHTML = "";
      var ee = document.createElement("div");
      ee.className = "activity-empty";
      ee.id = "activityEditEmpty";
      ee.textContent = "No edits yet…";
      activityEdit.appendChild(ee);
    }
  }

  function activityKindBucket(kind) {
    var k = String(kind || "").toLowerCase();
    if (k === "edit" || k === "edited" || k === "write" || k === "strreplace") return "edit";
    if (k === "read" || k === "search" || k === "grep" || k === "glob" || k === "webfetch")
      return "read";
    if (k === "run") return "edit";
    return "read";
  }

  function appendActivity(item, timeStr) {
    if (!item) return;
    var kind = activityKindBucket(item.kind);
    var role = item.role || "parent";
    if (role === "parent") role = "parent";
    var path = item.path || "n/a";
    var detail = item.detail || "";
    var t = timeStr;
    if (!t) {
      var sec = Math.floor(logSeq * (STEP_MS / 1000));
      t = "00:" + pad2(Math.min(59, sec));
    }
    var entry = {
      kind: kind,
      role: role,
      path: path,
      detail: detail,
      t: t
    };
    state.activity.unshift(entry);
    if (state.activity.length > ACTIVITY_CAP) {
      state.activity.length = ACTIVITY_CAP;
    }
    if (AgentCards && typeof AgentCards.noteSensitivePath === "function") {
      var privacyRole = role === "parent" ? "opus" : role;
      AgentCards.noteSensitivePath(privacyRole, path);
    }
    renderActivity();
    stageDirector.spawnCrate(entry);
  }

  function renderActivity() {
    if (!activityRead || !activityEdit) return;
    activityRead.innerHTML = "";
    activityEdit.innerHTML = "";
    var filter = activityFilterRole;
    var filtered = state.activity.filter(function (a) {
      if (!filter) return true;
      var r = a.role === "parent" ? "opus" : a.role;
      return r === filter;
    });
    var reads = filtered.filter(function (a) {
      return a.kind === "read";
    });
    var edits = filtered.filter(function (a) {
      return a.kind === "edit";
    });
    var emptyHint = filter ? "No " + (ROLE_LABEL[filter] || filter) + " activity yet…" : null;
    function paint(list, host, emptyMsg) {
      if (!list.length) {
        var empty = document.createElement("div");
        empty.className = "activity-empty";
        empty.textContent = emptyHint || emptyMsg;
        host.appendChild(empty);
        return;
      }
      list.forEach(function (a) {
        var row = document.createElement("div");
        row.className = "activity-row role-" + a.role;
        row.innerHTML =
          '<span class="t">' +
          escapeHtml(a.t) +
          "</span>" +
          '<span class="role">' +
          escapeHtml(a.role) +
          "</span>" +
          '<span class="body"><div class="path">' +
          escapeHtml(a.path) +
          "</div>" +
          (a.detail ? '<div class="detail">' + escapeHtml(a.detail) + "</div>" : "") +
          "</span>";
        host.appendChild(row);
      });
    }
    paint(reads, activityRead, "No reads yet…");
    paint(edits, activityEdit, "No edits yet…");
  }

  function setCalls(n) {
    state.calls = n;
    advisorCallsEl.textContent = String(n);
  }

  function setSubs(n) {
    state.subs = n;
    if (hudSubs) hudSubs.textContent = String(n);
    syncDailyStatsFromUsage();
  }

  function setEffort(label) {
    if (hudEffort) hudEffort.textContent = label || "mixed";
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function appendLog(role, message, msgClass, timeStr) {
    if (logEmpty && logEmpty.parentNode) {
      logEmpty.parentNode.removeChild(logEmpty);
      logEmpty = null;
    }
    logSeq += 1;
    var t = timeStr;
    if (!t) {
      var sec = Math.floor((logSeq - 1) * (STEP_MS / 1000));
      t = "00:" + pad2(Math.min(59, sec));
    }
    var line = document.createElement("div");
    line.className = "log-line role-" + role;
    line.innerHTML =
      '<span class="t">' +
      escapeHtml(t) +
      "</span>" +
      '<span class="role">' +
      escapeHtml(role) +
      "</span>" +
      '<span class="msg' +
      (msgClass ? " " + msgClass : "") +
      '">' +
      escapeHtml(message) +
      "</span>";
    sessionLog.appendChild(line);
    sessionLog.scrollTop = sessionLog.scrollHeight;
  }

  function layoutFlow() {
    /* Workshop paths are fixed in SVG viewBox. No card-geometry layout. */
  }

  function pulsePath(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("run");
    void el.offsetWidth;
    el.classList.add("run");
    setTimeout(
      function () {
        el.classList.remove("run");
      },
      prefersReducedMotion() ? 200 : 900
    );
  }

  function animateRoute(route, routeTo) {
    var labelMs = prefersReducedMotion() ? 200 : 900;
    stageDirector.playRoute(route, routeTo);
    if (route === "asks") {
      pulsePath("path-asks-pulse");
      if (asksLabel) {
        asksLabel.classList.add("pulse");
        setTimeout(function () {
          asksLabel.classList.remove("pulse");
        }, labelMs);
      }
      stageDirector.spawnRouteToken("advisor");
      return;
    }
    if (route === "delegates") {
      if (delegatesLabel) {
        delegatesLabel.classList.add("pulse");
        setTimeout(function () {
          delegatesLabel.classList.remove("pulse");
        }, labelMs);
      }
      var map = {
        worker: "path-d-worker-pulse",
        explorer: "path-d-explorer-pulse",
        researcher: "path-d-researcher-pulse",
        advisor: "path-asks-pulse"
      };
      if (routeTo && map[routeTo]) {
        pulsePath(map[routeTo]);
        if (routeTo === "advisor" && asksLabel) {
          asksLabel.classList.add("pulse");
          setTimeout(function () {
            asksLabel.classList.remove("pulse");
          }, labelMs);
        }
        stageDirector.spawnRouteToken(routeTo);
      } else {
        pulsePath("path-d-worker-pulse");
        pulsePath("path-d-explorer-pulse");
        pulsePath("path-d-researcher-pulse");
      }
    }
  }

  function emptyLogMessage() {
    if (mode !== "live") return "Waiting for session… choose Demo · Play or Live.";
    if (livePresence === "file-origin") {
      return "Live needs the bridge. Open via npm start or http://127.0.0.1…";
    }
    if (livePresence === "bridge-down") {
      return "Bridge offline · click Reconnect after starting the bridge.";
    }
    if (livePresence === "no-projects") {
      return "No Cursor projects found · open a project in Cursor, then Reconnect.";
    }
    if (livePresence === "connecting") {
      return "Connecting to the Live bridge…";
    }
    if (livePresence === "quiet-healthy") {
      return "Workshop idle · waiting for transcript activity…";
    }
    return "Live mode · waiting for transcript events from the bridge…";
  }

  function updateFooterProject() {
    if (!footerProject) return;
    if (mode === "live" && currentProjectLabel) {
      footerProject.textContent = currentProjectLabel;
    } else {
      footerProject.textContent = "cursor --model opus --advisor fable";
    }
  }

  function setProjectPickerVisible(visible) {
    if (!projectPicker) return;
    projectPicker.hidden = !visible;
  }

  function fillProjectPicker(data) {
    if (!projectPicker || !data) return;
    var projects = data.projects || [];
    var selected = data.selectedId || currentProjectId;
    currentProjectId = data.selectedId || currentProjectId;
    currentProjectLabel = data.selectedLabel || currentProjectLabel;
    projectPicker.innerHTML = "";
    if (!projects.length) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No Cursor projects found";
      projectPicker.appendChild(opt);
      projectPicker.disabled = true;
      updateFooterProject();
      if (
        mode === "live" &&
        demoBtn.classList.contains("live-connected") &&
        livePresence !== "bridge-down" &&
        livePresence !== "file-origin"
      ) {
        setLivePresence("no-projects");
      }
      return;
    }
    projectPicker.disabled = false;
    if (mode === "live" && livePresence === "no-projects") {
      setLivePresence(
        Date.now() - lastLiveEventAt < QUIET_AFTER_MS && lastLiveEventAt > 0
          ? "streaming"
          : "quiet-healthy"
      );
    }
    projects.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label || p.id;
      if (p.id === selected) opt.selected = true;
      projectPicker.appendChild(opt);
    });
    if (selected && projectPicker.value !== selected) {
      projectPicker.value = selected;
    }
    updateFooterProject();
  }

  function loadProjects() {
    if (!projectPicker) return Promise.resolve(null);
    return fetch(BRIDGE + "/api/projects", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("projects " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (mode === "live") setProjectPickerVisible(true);
        fillProjectPicker(data);
        return data;
      })
      .catch(function () {
        setProjectPickerVisible(false);
        return null;
      });
  }

  function focusInsightsLatestSession(meta) {
    if (!insightsPanel || typeof insightsPanel.focusLatestSession !== "function") return;
    var hint = meta && meta.latestSessionId ? meta.latestSessionId : "";
    insightsPanel.focusLatestSession(hint).then(function () {
      remountHistoryReplayIfNeeded();
    });
  }

  function onLiveProjectScopeChange(meta, opts) {
    opts = opts || {};
    focusInsightsLatestSession(meta);
    if (opts.navigateHistory && typeof setViewMode === "function") {
      setViewMode("history");
    }
  }

  function selectProject(id) {
    if (!id || selectingProject) return Promise.resolve(null);
    selectingProject = true;
    return fetch(BRIDGE + "/api/select", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Cursor-Bridge": "1"
      },
      body: JSON.stringify({ id: id })
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!r.ok) {
              return {
                ok: false,
                error: (body && body.error) || "Select failed (" + r.status + ")"
              };
            }
            return body;
          });
      })
      .then(function (data) {
        if (data && data.ok) {
          currentProjectId = data.projectId;
          currentProjectLabel = data.projectLabel;
          updateFooterProject();
        }
        return data;
      })
      .catch(function () {
        return { ok: false, error: "Could not switch project" };
      })
      .then(function (data) {
        selectingProject = false;
        return data;
      });
  }

  function resetUI(opts) {
    opts = opts || {};
    clearTimers();
    clearStickyActive();
    playing = false;
    logSeq = 0;
    state.liveSubs = {};
    activityFilterRole = null;
    stageDirector.reset();
    demoBtn.classList.remove("playing");
    demoBtn.setAttribute("aria-pressed", "false");
    lastSessionCostForShip = 0;
    if (mode === "demo") {
      demoBtn.textContent = "Play";
      demoBtn.hidden = false;
      liveHint.hidden = true;
      setProjectPickerVisible(false);
      updateFooterProject();
      setLivePresence(null);
    } else {
      demoBtn.textContent = "Reconnect";
      demoBtn.hidden = false;
      setProjectPickerVisible(true);
    }
    if (!opts.keepActive) setActive([]);
    setStatus("opus", '<span class="live">Idle · waiting for task</span>');
    setStatus("advisor", '<span class="live">Quiet</span>');
    setStatus("worker", '<span class="live">Standby</span>');
    setStatus("explorer", '<span class="live">Standby</span>');
    setStatus("researcher", '<span class="live">Standby</span>');
    setCalls(0);
    setSubs(0);
    advisorLastEl.textContent = "Last advice: none";
    setEffort(mode === "live" ? "live" : "mixed");
    state.usage = emptyUsage();
    lastDemoUsageTotal = 0;
    renderBill();
    clearActivity();
    if (AgentCards && typeof AgentCards.reset === "function") {
      AgentCards.reset({ keepDaily: mode === "live", mode: mode });
    }
    billEls.illustrative.textContent =
      mode === "live"
        ? ESTIMATES_DISCLAIMER + " · near-real transcript activity"
        : ESTIMATES_DISCLAIMER + " · demo narrative";
    refreshSyncAgeChip();
    sessionLog.innerHTML = "";
    logEmpty = document.createElement("div");
    logEmpty.className = "log-empty";
    logEmpty.id = "logEmpty";
    logEmpty.textContent = emptyLogMessage();
    sessionLog.appendChild(logEmpty);
  }

  function liveProjectScope() {
    return String(currentProjectId || currentProjectLabel || "_default");
  }

  function hasSeenLiveEvent(ev) {
    if (!ev || ev.id == null) return false;
    var bucket = liveSeenByProject[liveProjectScope()];
    return !!(bucket && bucket[String(ev.id)]);
  }

  function markSeenLiveEvent(ev) {
    if (!ev || ev.id == null) return;
    var scope = liveProjectScope();
    if (!liveSeenByProject[scope]) liveSeenByProject[scope] = {};
    liveSeenByProject[scope][String(ev.id)] = true;
  }

  function clearLiveSeenEvents() {
    liveSeenByProject = {};
  }

  function applyLiveEvent(ev, opts) {
    if (!ev) return;
    opts = opts || {};
    var isReplay = !!opts.replay;
    /* History replay owns the stage. Ignore Live/Demo ingress until Stage resumes. */
    if (replaySessionActive && !isReplay) return;

    var alreadySeen = false;
    if (!isReplay) {
      alreadySeen = hasSeenLiveEvent(ev);
      if (!alreadySeen) markSeenLiveEvent(ev);
    }
    var usageOpts = { skipDaily: alreadySeen || isReplay };
    var skipTiming = !!opts.skipTiming || alreadySeen || liveSseBacklogReplay || !!ev.sseBacklog;
    var skipMotion = !!opts.skipMotion || (isReplay && prefersReducedMotion());

    var role = ev.role || "parent";
    var cardRole =
      role === "parent"
        ? "opus"
        : role === "advisor"
          ? "advisor"
          : role === "worker"
            ? "worker"
            : role === "explorer"
              ? "explorer"
              : role === "researcher"
                ? "researcher"
                : "opus";

    var explicit = Array.isArray(ev.active) ? ev.active : null;
    var active = explicit && explicit.length ? explicit.slice() : [cardRole];
    if (!isReplay) rememberLiveFocus(explicit, active);
    setActive(isReplay ? active : mergeStickyActive(active), {
      skipTiming: skipTiming
    });

    var msg = ev.message || "";
    var statusCls = ev.replayError ? "err" : "live";
    setStatus(cardRole, '<span class="' + statusCls + '">' + escapeHtml(msg) + "</span>");
    if (!isReplay && (role === "advisor" || ev.kind === "asks")) {
      setCalls(state.calls + 1);
      advisorLastEl.textContent = "Last advice: " + msg;
    } else if (isReplay && (role === "advisor" || ev.kind === "asks")) {
      setCalls(state.calls + 1);
      advisorLastEl.textContent = "Last advice: " + msg;
    }
    if (ev.kind === "delegates" || (ev.route === "delegates" && role !== "parent")) {
      var key = role + ":" + (ev.source || "");
      if (!state.liveSubs[key] && role !== "parent" && role !== "advisor") {
        state.liveSubs[key] = true;
        setSubs(Object.keys(state.liveSubs).length);
      }
    }
    if (ev.usage) {
      addUsage(
        {
          model: ev.usage.model,
          role: ev.usage.role || role,
          in: ev.usage.in,
          out: ev.usage.out
        },
        usageOpts
      );
    } else if (ev.tokensDelta) {
      /* Backward compat: attribute legacy deltas to Haiku reads */
      addUsage(
        {
          model: "haiku",
          role: role === "researcher" ? "researcher" : "explorer",
          in: Number(ev.tokensDelta) || 0,
          out: 0
        },
        usageOpts
      );
    }
    if (ev.activity) {
      appendActivity(
        {
          kind: ev.activity.kind,
          path: ev.activity.path,
          detail: ev.activity.detail,
          role: role === "parent" ? "parent" : role
        },
        ev.ts
      );
    }
    if (ev.route && !skipMotion) animateRoute(ev.route, ev.routeTo || cardRole);

    var logRole = role === "parent" ? "parent" : role;
    appendLog(logRole, msg, ev.replayError ? "err" : null, ev.ts);

    if (!isReplay && !alreadySeen && mode === "live") {
      lastLiveEventAt = Date.now();
      if (
        demoBtn.classList.contains("live-connected") &&
        livePresence !== "no-projects" &&
        livePresence !== "bridge-down" &&
        livePresence !== "file-origin"
      ) {
        setLivePresence("streaming");
        scheduleQuietHealthy();
      }
    }

    if (
      !isReplay &&
      !alreadySeen &&
      !skipMotion &&
      !liveSseBacklogReplay &&
      looksLikeShipEvent(ev, role, cardRole)
    ) {
      var shipRoles = active && active.length ? active.slice() : [cardRole];
      triggerShipCelebration(shipRoles, ROLE_LABEL[cardRole] || cardRole);
    }
  }

  function resetReplaySession() {
    replaySessionActive = true;
    lastReplayIndex = -1;
    clearStickyActive();
    clearTimers();
    if (playing) stopDemo();
    stageDirector.reset();
    setActive([]);
    setStatus("opus", '<span class="live">Replay · idle</span>');
    setStatus("advisor", '<span class="live">Quiet</span>');
    setStatus("worker", '<span class="live">Standby</span>');
    setStatus("explorer", '<span class="live">Standby</span>');
    setStatus("researcher", '<span class="live">Standby</span>');
    setCalls(0);
    setSubs(0);
    advisorLastEl.textContent = "Last advice: none";
    state.usage = emptyUsage();
    state.liveSubs = {};
    renderBill();
    clearActivity();
    sessionLog.innerHTML = "";
    logEmpty = document.createElement("div");
    logEmpty.className = "log-empty";
    logEmpty.id = "logEmpty";
    logEmpty.textContent = "Replay session…";
    sessionLog.appendChild(logEmpty);
  }

  function endReplaySession() {
    if (insightsPanel && typeof insightsPanel.pause === "function") insightsPanel.pause();
    replaySessionActive = false;
    lastReplayIndex = -1;
  }

  var replayStageApi = {
    applyLiveEvent: applyLiveEvent,
    resetReplay: resetReplaySession,
    prefersReducedMotion: prefersReducedMotion
  };

  function onReplayIndexChange(payload) {
    if (!ReplayStage || !payload) return;
    /* Insights reloads history in the background on Stage/Insights. Only History view owns the stage. */
    if (viewMode !== "history") {
      replaySessionActive = false;
      return;
    }
    var events = payload.events || [];
    var index = Number(payload.index);
    if (!isFinite(index)) return;
    var source = payload.source || "scrub";

    if (playing) stopDemo();
    /* Live + session load (project pick / focusLatestSession): paint History frame but keep Live SSE. */
    var liveSessionBrowse = mode === "live" && source === "session";
    if (!liveSessionBrowse) replaySessionActive = true;

    if (source === "play" && index === lastReplayIndex + 1 && lastReplayIndex >= 0) {
      var stepEv = events[index];
      if (stepEv) {
        ReplayStage.applyOne(replayStageApi, stepEv, {
          skipTiming: false,
          skipMotion: prefersReducedMotion()
        });
      }
      lastReplayIndex = index;
      if (viewMode === "history") updateHistoryHint(true);
      return;
    }

    /* Scrub / play-start / session / test. Rebuild [0..index] */
    ReplayStage.seek(replayStageApi, events, index, {
      prefersReducedMotion: prefersReducedMotion()
    });
    if (liveSessionBrowse) replaySessionActive = false;
    lastReplayIndex = index;
    if (viewMode === "history") updateHistoryHint(true);
  }

  if (insightsPanel && typeof insightsPanel.onReplayIndex === "function") {
    insightsPanel.onReplayIndex(onReplayIndexChange);
  }

  function formatSyncAge(iso) {
    if (!iso) return "n/a";
    var t = Date.parse(iso);
    if (!isFinite(t)) return "n/a";
    var sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 1) return "just now";
    if (sec < 60) return sec + "s ago";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    return Math.floor(min / 60) + "h ago";
  }

  function refreshSyncAgeChip() {
    if (!hudSyncAge) return;
    var chip = hudSyncAge.closest(".hud-chip");
    if (mode !== "live") {
      lastBridgeScanAt = null;
      hudSyncAge.textContent = "n/a";
      if (chip) {
        chip.classList.remove("stale");
        chip.setAttribute("title", "Sync age · Live mode only (Demo has no bridge poll)");
      }
      return;
    }
    hudSyncAge.textContent = formatSyncAge(lastBridgeScanAt);
    if (chip) {
      var ageMs = lastBridgeScanAt ? Date.now() - Date.parse(lastBridgeScanAt) : NaN;
      var stale = !lastBridgeScanAt || !isFinite(ageMs) || ageMs > Math.max(5000, bridgePollMs * 6);
      chip.classList.toggle("stale", stale);
      chip.setAttribute(
        "title",
        "Near-real file polling (~" +
          bridgePollMs +
          "ms) · last bridge transcript scan (not hook-level realtime)"
      );
    }
  }

  function applyBridgeSyncMeta(meta) {
    if (!meta) return;
    if (meta.lastScanAt) lastBridgeScanAt = meta.lastScanAt;
    if (meta.pollMs != null && isFinite(Number(meta.pollMs))) {
      bridgePollMs = Number(meta.pollMs);
    }
    refreshSyncAgeChip();
  }

  function pollBridgeStatusOnce() {
    if (mode !== "live" || location.protocol === "file:") return;
    fetch(BRIDGE + "/api/status", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (body) {
        if (body && body.ok) applyBridgeSyncMeta(body);
      })
      .catch(function () {});
  }

  function startSyncAgePoll() {
    if (livePoll) {
      clearInterval(livePoll);
      livePoll = null;
    }
    pollBridgeStatusOnce();
    livePoll = setInterval(function () {
      pollBridgeStatusOnce();
      refreshSyncAgeChip();
    }, 1000);
  }

  function stopLive() {
    if (es) {
      try {
        es.close();
      } catch (_) {}
      es = null;
    }
    if (livePoll) {
      clearInterval(livePoll);
      livePoll = null;
    }
    clearLiveSseBacklogReplay();
    clearQuietHealthyTimer();
    clearStickyActive();
    demoBtn.classList.remove("live-connected");
    if (window.AlertCenter && typeof window.AlertCenter.attachEventSource === "function") {
      window.AlertCenter.attachEventSource(null);
    }
    refreshSyncAgeChip();
  }

  function startLive() {
    stopLive();
    resetUI();
    liveHint.hidden = false;
    liveHint.className = "live-hint";

    // file:// cannot use Live (Origin "null" is rejected by the bridge on purpose).
    if (location.protocol === "file:") {
      demoBtn.classList.remove("live-connected");
      demoBtn.textContent = "Reconnect";
      setProjectPickerVisible(false);
      setLivePresence("file-origin");
      refreshSyncAgeChip();
      return;
    }

    setLivePresence("connecting");
    setProjectPickerVisible(true);
    loadProjects();
    startSyncAgePoll();

    function onOk(meta) {
      if (meta && meta.projectLabel) {
        currentProjectLabel = meta.projectLabel;
        currentProjectId = meta.projectId || currentProjectId;
        updateFooterProject();
        if (projectPicker && currentProjectId) {
          projectPicker.value = currentProjectId;
        }
      }
      applyBridgeSyncMeta(meta);
      demoBtn.classList.add("live-connected");
      demoBtn.textContent = "Connected";
      if (
        projectPicker &&
        projectPicker.disabled &&
        projectPicker.options.length === 1 &&
        !projectPicker.options[0].value
      ) {
        setLivePresence("no-projects");
      } else if (Date.now() - lastLiveEventAt < QUIET_AFTER_MS && lastLiveEventAt > 0) {
        setLivePresence("streaming");
        scheduleQuietHealthy();
      } else {
        setLivePresence("quiet-healthy");
      }
      if (window.AlertCenter && typeof window.AlertCenter.hydrate === "function") {
        window.AlertCenter.hydrate(BRIDGE);
      }
    }

    function onErr(msg) {
      demoBtn.classList.remove("live-connected");
      demoBtn.textContent = "Reconnect";
      clearQuietHealthyTimer();
      setLivePresence("bridge-down", msg);
    }

    function onReset(meta) {
      armLiveSseBacklogReplay();
      if (meta) {
        if (meta.projectLabel) currentProjectLabel = meta.projectLabel;
        if (meta.projectId) currentProjectId = meta.projectId;
      }
      resetUI({ keepActive: false });
      demoBtn.classList.add("live-connected");
      demoBtn.textContent = "Connected";
      updateFooterProject();
      setLivePresence("quiet-healthy");
      loadProjects();
      if (window.AlertCenter && typeof window.AlertCenter.hydrate === "function") {
        window.AlertCenter.hydrate(BRIDGE);
      }
    }

    if (typeof EventSource === "undefined") {
      onErr("EventSource unavailable in this browser");
      return;
    }

    try {
      armLiveSseBacklogReplay();
      es = new EventSource(BRIDGE + "/api/stream");
    } catch (_e) {
      onErr("Cannot open SSE. Start the app (npm start)");
      return;
    }

    if (window.AlertCenter && typeof window.AlertCenter.attachEventSource === "function") {
      window.AlertCenter.attachEventSource(es);
    }

    es.addEventListener("hello", function (msg) {
      try {
        onOk(JSON.parse(msg.data));
      } catch (_) {
        onOk();
      }
    });
    es.addEventListener("reset", function (msg) {
      try {
        onReset(JSON.parse(msg.data));
      } catch (_) {
        onReset(null);
      }
    });
    es.onopen = function () {
      onOk();
    };
    es.onmessage = function (msg) {
      try {
        touchLiveSseBacklogMessage();
        applyLiveEvent(JSON.parse(msg.data));
      } catch (_) {}
    };
    es.onerror = function () {
      onErr("Bridge offline. Use npm start or node live-bridge.js");
      stopLive();
    };
  }

  /* Demo narrative. Advances Opus / Fable / Sonnet / Haiku bill buckets */
  var steps = [
    function () {
      setActive(["opus"]);
      setStatus("opus", '<span class="live">Task received · refactor billing webhooks</span>');
      appendLog("parent", "task received · refactor billing webhooks");
      setUsageSnapshot(
        {
          opus: { in: 18000, out: 4200 },
          fable: { in: 0, out: 0 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "opus"
      );
      setEffort("high");
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · before the plan</span>');
      setStatus("advisor", '<span class="live">Reviewing approach…</span>');
      appendLog("parent", "calling advisor · before the plan");
      appendLog("advisor", "triggered · before plan");
      setUsageSnapshot(
        {
          opus: { in: 24000, out: 6100 },
          fable: { in: 12000, out: 3800 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["advisor"]);
      setCalls(1);
      setStatus("advisor", '<span class="live">Quiet</span>');
      setStatus("opus", '<span class="live">Plan approved · delegating reads & edits</span>');
      advisorLastEl.textContent = "Last advice: keep Haiku on reads; Sonnet owns edits";
      appendLog("advisor", "reviews approach → quiet; calls = 1");
      setUsageSnapshot(
        {
          opus: { in: 28000, out: 7200 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "advisor"
      );
    },
    function () {
      setActive(["explorer"]);
      setSubs(1);
      setStatus("explorer", '<span class="live">Searching src/billing/**</span>');
      setUsageSnapshot(
        {
          opus: { in: 28000, out: 7200 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 420000, out: 18000 },
          explorer: { in: 420000, out: 18000 },
          researcher: { in: 0, out: 0 }
        },
        "explorer"
      );
      appendActivity({
        kind: "read",
        role: "explorer",
        path: "src/billing/**",
        detail: "glob · webhook handlers"
      });
      appendActivity({
        kind: "read",
        role: "explorer",
        path: "src/billing/webhooks.ts",
        detail: "lines 1-240"
      });
      /* Demo fixture: sensitive path lights privacy meter (path never shown on badge). */
      appendActivity({
        kind: "read",
        role: "explorer",
        path: "config/.env.example",
        detail: "pattern scan · no values loaded"
      });
      appendLog("explorer", "searching src/billing/** · Session Bill climbs");
      animateRoute("delegates", "explorer");
    },
    function () {
      setActive(["explorer", "researcher"]);
      setSubs(2);
      setStatus("researcher", '<span class="live">Pulling docs · webhook patterns</span>');
      setUsageSnapshot(
        {
          opus: { in: 32000, out: 8000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 980000, out: 42000 },
          explorer: { in: 520000, out: 22000 },
          researcher: { in: 460000, out: 20000 }
        },
        "researcher"
      );
      appendActivity({
        kind: "read",
        role: "researcher",
        path: "docs/webhooks.md",
        detail: "signature verify patterns"
      });
      appendLog("researcher", "pulling docs · Session Bill climbs");
      animateRoute("delegates", "researcher");
    },
    function () {
      setActive(["worker"]);
      setSubs(3);
      setStatus("explorer", '<span class="live">Search complete</span>');
      setStatus("researcher", '<span class="live">Docs cached</span>');
      setStatus("worker", "Editing 4 files · running tests → FAIL", "fail");
      setUsageSnapshot(
        {
          opus: { in: 36000, out: 9000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 85000, out: 32000 },
          haiku: { in: 1050000, out: 45000 },
          explorer: { in: 540000, out: 23000 },
          researcher: { in: 510000, out: 22000 }
        },
        "worker"
      );
      appendActivity({
        kind: "edit",
        role: "worker",
        path: "src/billing/webhooks.ts",
        detail: "edited · signature check"
      });
      appendActivity({
        kind: "edit",
        role: "worker",
        path: "src/billing/verify.ts",
        detail: "edited · HMAC helper"
      });
      appendLog("worker", "editing 4 files · running tests → FAIL", "fail");
      animateRoute("delegates", "worker");
    },
    function () {
      setActive(["worker"]);
      setStatus("worker", "Same error again → FAIL", "fail");
      appendLog("worker", "same error again → FAIL", "fail");
      setUsageSnapshot(
        {
          opus: { in: 40000, out: 10000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "worker"
      );
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · same error twice</span>');
      setStatus("advisor", '<span class="live">Analyzing failure loop…</span>');
      appendLog("parent", "calling advisor · same error twice");
      setUsageSnapshot(
        {
          opus: { in: 52000, out: 14000 },
          fable: { in: 38000, out: 16000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["advisor"]);
      setCalls(2);
      setStatus("advisor", '<span class="live">Quiet</span>');
      advisorLastEl.textContent =
        "Last advice: stop / change approach. Fix signature mismatch first";
      setStatus("worker", '<span class="live">Awaiting revised approach</span>');
      appendLog("advisor", "stop / change approach; calls = 2");
      setUsageSnapshot(
        {
          opus: { in: 56000, out: 15000 },
          fable: { in: 52000, out: 24000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "advisor"
      );
    },
    function () {
      setActive(["worker"]);
      setStatus("worker", "Fix applied · tests → PASS", "pass");
      setUsageSnapshot(
        {
          opus: { in: 60000, out: 16000 },
          fable: { in: 52000, out: 24000 },
          sonnet: { in: 210000, out: 78000 },
          haiku: { in: 1120000, out: 48000 },
          explorer: { in: 570000, out: 24500 },
          researcher: { in: 550000, out: 23500 }
        },
        "worker"
      );
      appendActivity({
        kind: "edit",
        role: "worker",
        path: "src/billing/webhooks.test.ts",
        detail: "edited · fixture sig"
      });
      appendLog("worker", "fix + tests → PASS", "pass");
      animateRoute("delegates", "worker");
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · before done</span>');
      setStatus("advisor", '<span class="live">Final review…</span>');
      setCalls(3);
      appendLog("parent", "calling advisor · before done; calls = 3");
      setUsageSnapshot(
        {
          opus: { in: 78000, out: 22000 },
          fable: { in: 68000, out: 32000 },
          sonnet: { in: 210000, out: 78000 },
          haiku: { in: 1120000, out: 48000 },
          explorer: { in: 570000, out: 24500 },
          researcher: { in: 550000, out: 23500 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["opus"]);
      setStatus("advisor", '<span class="live">Quiet</span>');
      advisorLastEl.textContent = "Last advice: ship it. Haiku covered the read load";
      setStatus("opus", '<span class="live">Reviewed · shipped</span>');
      setStatus("worker", '<span class="live">Done</span>');
      setStatus("explorer", '<span class="live">Done</span>');
      setStatus("researcher", '<span class="live">Done</span>');
      setUsageSnapshot(
        {
          opus: { in: 95000, out: 28000 },
          fable: { in: 72000, out: 36000 },
          sonnet: { in: 225000, out: 82000 },
          haiku: { in: 1200000, out: 52000 },
          explorer: { in: 620000, out: 27000 },
          researcher: { in: 580000, out: 25000 }
        },
        "opus"
      );
      appendLog(
        "parent",
        "reviewed · shipped · Session Bill shows multi-model savings vs all-Opus"
      );
      setEffort("done");
      triggerShipCelebration(["opus", "worker", "explorer", "researcher"], ROLE_LABEL.opus);
      playing = false;
      demoBtn.textContent = "Play";
      demoBtn.classList.remove("playing");
      demoBtn.setAttribute("aria-pressed", "false");
      setTimeout(
        function () {
          setActive([]);
        },
        prefersReducedMotion() ? 0 : 800
      );
    }
  ];

  function playDemo() {
    stopLive();
    resetUI();
    playing = true;
    demoBtn.textContent = "Stop";
    demoBtn.classList.add("playing");
    demoBtn.setAttribute("aria-pressed", "true");
    layoutFlow();
    if (AgentCards && typeof AgentCards.recordRun === "function") {
      AgentCards.recordRun({ agent: "opus", tokens: 0, durationMs: STEP_MS * steps.length });
    }

    var delay = prefersReducedMotion() ? 400 : STEP_MS;
    steps.forEach(function (fn, i) {
      var t = setTimeout(function () {
        if (!playing && i < steps.length - 1) return;
        fn();
      }, delay * i);
      timers.push(t);
    });
  }

  function stopDemo() {
    clearTimers();
    clearStickyActive();
    playing = false;
    demoBtn.textContent = "Play";
    demoBtn.classList.remove("playing");
    demoBtn.setAttribute("aria-pressed", "false");
    setActive([]);
    stageDirector.reset();
  }

  function setMode(next) {
    if (next === mode && next === "live" && es) return;
    mode = next;
    modeDemo.classList.toggle("on", mode === "demo");
    modeLive.classList.toggle("on", mode === "live");
    modeLive.classList.toggle("live-on", mode === "live");
    lastDemoUsageTotal = 0;
    if (next === "demo") clearLiveSeenEvents();
    if (AgentCards && typeof AgentCards.onModeChange === "function") {
      AgentCards.onModeChange(next);
    }
    if (insightsPanel && typeof insightsPanel.setDemoMode === "function" && isBridgeOrigin) {
      insightsPanel.setDemoMode(mode === "demo");
    }
    stopDemo();
    stopLive();
    if (mode === "demo") {
      resetUI();
    } else {
      startLive();
    }
    layoutFlow();
  }

  modeDemo.addEventListener("click", function () {
    setMode("demo");
  });
  modeLive.addEventListener("click", function () {
    setMode("live");
  });

  if (projectPicker) {
    projectPicker.addEventListener("change", function () {
      var id = projectPicker.value;
      var previousId = currentProjectId;
      if (!id || id === previousId) return;
      selectProject(id).then(function (data) {
        if (!data || !data.ok) {
          if (previousId) projectPicker.value = previousId;
          else projectPicker.selectedIndex = 0;
          liveHint.hidden = false;
          liveHint.className = "live-hint err";
          liveHint.textContent = (data && data.error) || "Could not switch project";
          return;
        }
        currentProjectId = data.projectId || id;
        currentProjectLabel = data.projectLabel || currentProjectLabel;
        updateFooterProject();
        // Restart Live stream; SSE "reset" may be missed if the old EventSource closes first
        startLive();
        setViewMode("history");
        onLiveProjectScopeChange(data, { navigateHistory: false });
      });
    });
  }

  demoBtn.addEventListener("click", function () {
    if (mode === "live") {
      startLive();
      return;
    }
    if (playing) stopDemo();
    else playDemo();
  });

  if (soundBtn) {
    soundBtn.addEventListener("click", function () {
      sound.toggle();
    });
  }

  if (panelsBtn) {
    panelsBtn.addEventListener("click", function () {
      togglePanels();
    });
    panelsBtn.setAttribute("title", "Open panels");
    panelsBtn.setAttribute("aria-label", "Open panels");
  }

  function bindViewModeButton(btn, mode) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      setViewMode(mode);
      sound.play("click");
    });
  }
  bindViewModeButton(viewStageBtn, "stage");
  bindViewModeButton(viewInsightsBtn, "insights");
  bindViewModeButton(viewHistoryBtn, "history");

  Object.keys(stageDirector.chars).forEach(function (role) {
    var el = stageDirector.chars[role];
    if (!el) return;
    function onChar() {
      jumpToAgent({ role: role, name: ROLE_LABEL[role] || role });
    }
    el.addEventListener("click", onChar);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onChar();
      }
    });
  });

  window.addEventListener("cursor-agents:jump-to-agent", onJumpToAgentEvent);

  if (liveCoachDismiss) {
    liveCoachDismiss.addEventListener("click", function () {
      markLiveOnboardSeen();
      setLiveCoachVisible(false);
    });
  }

  if (window.AlertCenter && typeof window.AlertCenter.init === "function") {
    window.AlertCenter.init({
      bridge: BRIDGE,
      isQuiet: function () {
        return !!liveSseBacklogReplay;
      },
      onJump: function (detail) {
        jumpToAgent(detail || {});
      }
    });
  }

  globalThis.__cursorAgentsDash = {
    jumpToAgent: jumpToAgent,
    setLivePresence: setLivePresence,
    getLivePresence: function () {
      return livePresence;
    },
    triggerShipCelebration: triggerShipCelebration,
    /* Alert center calls this after snooze/un-snooze so the sound button reflects it. */
    syncSound: function () {
      sound.syncBtn();
    }
  };
  var mergePortal = document.getElementById("mergePortal");
  if (mergePortal) {
    function onPortal() {
      activityFilterRole = null;
      stageDirector.clearSelection();
      openActivityDrawer(null);
      stageDirector.pulsePortal();
      showToast("Activity");
    }
    mergePortal.addEventListener("click", onPortal);
    mergePortal.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPortal();
      }
    });
  }

  var cratesLayerEl = document.getElementById("cratesLayer");
  if (cratesLayerEl) {
    cratesLayerEl.addEventListener("mouseover", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("crate")) showCrateTooltip(e, t);
    });
    cratesLayerEl.addEventListener("mousemove", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("crate")) showCrateTooltip(e, t);
    });
    cratesLayerEl.addEventListener("mouseout", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("crate")) hideTooltip();
    });
  }

  window.addEventListener("resize", function () {
    layoutFlow();
  });

  // Initial
  renderBill();
  if (billEls.illustrative) {
    billEls.illustrative.textContent =
      mode === "live"
        ? ESTIMATES_DISCLAIMER + " · near-real transcript activity"
        : ESTIMATES_DISCLAIMER + " · demo narrative";
  }
  refreshSyncAgeChip();
  clearActivity();
  updateFooterProject();
  sound.syncBtn();
  (function restoreViewMode() {
    var stored = null;
    try {
      stored = sessionStorage.getItem(VIEW_MODE_KEY);
    } catch (_) {}
    setViewMode(normalizeViewMode(stored || "stage"), { skipPersist: true });
  })();
  requestAnimationFrame(function () {
    layoutFlow();
  });

  // Auto-Live when served by the bridge (any localhost port)
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin)) {
    setMode("live");
  }

  /* Test hooks for Playwright (localhost dashboard only). */
  globalThis.__cursorAgentsDashTest = {
    applyLiveEvent: applyLiveEvent,
    jumpToAgent: jumpToAgent,
    getLivePresence: function () {
      return livePresence;
    },
    setLivePresence: setLivePresence,
    triggerShipCelebration: triggerShipCelebration,
    setViewMode: setViewMode,
    getViewMode: function () {
      return viewMode;
    },
    replaySeek: function (events, index, source) {
      if (!ReplayStage) return;
      onReplayIndexChange({
        events: events || [],
        index: index,
        source: source || "test"
      });
    },
    isReplaySessionActive: function () {
      return replaySessionActive;
    },
    demoUsageTokenTotal: function () {
      return usageGrandTotal(state.usage);
    },
    measureDemoUsageTokens: function (usage) {
      return usageGrandTotal(usage || emptyUsage());
    },
    setDemoUsageAndSyncDaily: function (usage) {
      if (mode !== "demo") return;
      state.usage = usage || emptyUsage();
      lastDemoUsageTotal = 0;
      syncDailyStatsFromUsage();
    },
    getDailyStats: function () {
      return AgentCards && typeof AgentCards.getDailyStats === "function"
        ? AgentCards.getDailyStats()
        : null;
    },
    getHudSessionCost: function () {
      return hudSessionCost ? hudSessionCost.textContent.trim() : "";
    },
    getHudSyncAge: function () {
      return hudSyncAge ? hudSyncAge.textContent.trim() : "";
    },
    formatSyncAge: formatSyncAge,
    estimatesDisclaimer: ESTIMATES_DISCLAIMER,
    getLogLineCount: function () {
      return sessionLog ? sessionLog.querySelectorAll(".log-line").length : 0;
    },
    liveProjectScope: liveProjectScope,
    hasSeenLiveEvent: hasSeenLiveEvent,
    isLiveBacklogReplay: function () {
      return liveSseBacklogReplay;
    },
    /* Snooze-aware audio: true when muted by preference or while alerts are snoozed. */
    isSoundSuppressed: function () {
      return sound.isMuted();
    },
    snoozeKey: SNOOZE_KEY
  };
})();
