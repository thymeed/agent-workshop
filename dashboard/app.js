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

  var cards = {
    opus: document.getElementById("card-opus"),
    advisor: document.getElementById("card-advisor"),
    worker: document.getElementById("card-worker"),
    explorer: document.getElementById("card-explorer"),
    researcher: document.getElementById("card-researcher")
  };

  var statusEls = {
    opus: document.getElementById("status-opus"),
    advisor: document.getElementById("status-advisor"),
    worker: document.getElementById("status-worker"),
    explorer: document.getElementById("status-explorer"),
    researcher: document.getElementById("status-researcher")
  };

  var demoBtn = document.getElementById("demoBtn");
  var modeDemo = document.getElementById("modeDemo");
  var modeLive = document.getElementById("modeLive");
  var liveHint = document.getElementById("liveHint");
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
  var footerSubs = document.getElementById("footerSubs");
  var footerTokens = document.getElementById("footerTokens");
  var footerSessionCost = document.getElementById("footerSessionCost");
  var footerEffort = document.getElementById("footerEffort");
  var workshop = document.getElementById("workshop");
  var asksLabel = document.getElementById("asksLabel");
  var delegatesLabel = document.getElementById("delegatesLabel");
  var hudSessionCost = document.getElementById("hudSessionCost");
  var hudActiveRole = document.getElementById("hudActiveRole");
  var hudSubs = document.getElementById("hudSubs");
  var crateTooltip = document.getElementById("crateTooltip");
  var stageToast = document.getElementById("stageToast");
  var drawersEl = document.getElementById("drawers");
  var drawerActivity = document.getElementById("drawerActivity");
  var drawerBill = document.getElementById("drawerBill");
  var drawerLog = document.getElementById("drawerLog");
  var drawerStations = document.getElementById("drawerStations");
  var panelsBtn = document.getElementById("panelsBtn");
  var soundBtn = document.getElementById("soundBtn");
  var activityFilterRole = null;
  var toastTimer = null;

  /* Move station cards into Stations drawer (keep same card/status IDs). */
  (function relocateStations() {
    var panel = document.getElementById("stationsPanel");
    var body = document.getElementById("stationsDrawerBody");
    if (panel && body) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      panel.remove();
    }
  })();

  var mode = "demo"; /* demo | live */
  var playing = false;
  var timers = [];
  var logSeq = 0;
  var seenLiveIds = {};
  var es = null;
  var livePoll = null;
  var state = {
    calls: 0,
    subs: 0,
    liveSubs: {},
    usage: emptyUsage(),
    activity: []
  };

  /* —— Cute Web Audio blips (default muted) —— */
  var sound = (function () {
    var muted = true;
    var ctx = null;
    try {
      muted = localStorage.getItem("workshopSound") !== "on";
    } catch (_) {}

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
      if (muted) return;
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
      if (muted) return;
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
      soundBtn.textContent = muted ? "🔇" : "🔊";
      soundBtn.classList.toggle("on", !muted);
      soundBtn.setAttribute("aria-pressed", muted ? "false" : "true");
      soundBtn.title = muted ? "Sound off (click to unmute)" : "Sound on (click to mute)";
    }

    syncBtn();
    return {
      play: play,
      toggle: toggle,
      isMuted: function () {
        return muted;
      },
      syncBtn: syncBtn
    };
  })();

  /* —— Stage director: characters, crates, portal —— */
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
        hudActiveRole.textContent = labels.length ? labels.join(" · ") : "—";
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
      el.setAttribute("rx", "2");
      el.setAttribute("x", String(from.x - 6));
      el.setAttribute("y", String(from.y - 10));
      el.dataset.path = activity.path || "—";
      el.dataset.detail = activity.detail || kind;
      el.dataset.role = role;
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
        chars[key].classList.remove("busy", "walking", "selected");
        if (walkTimers[key]) {
          clearTimeout(walkTimers[key]);
          delete walkTimers[key];
        }
      });
      if (cratesLayer) cratesLayer.innerHTML = "";
      if (sparksLayer) sparksLayer.innerHTML = "";
      if (portal) portal.classList.remove("inhale");
      if (hudActiveRole) hudActiveRole.textContent = "—";
      clearSelection();
      hideTooltip();
    }

    return {
      setCharacterState: setCharacterState,
      setActiveRoles: setActiveRoles,
      selectCharacter: selectCharacter,
      clearSelection: clearSelection,
      spawnCrate: spawnCrate,
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
    if (crateTooltip) crateTooltip.hidden = true;
  }

  function showCrateTooltip(ev, el) {
    if (!crateTooltip || !workshop) return;
    var wr = workshop.getBoundingClientRect();
    crateTooltip.hidden = false;
    crateTooltip.innerHTML =
      '<div class="tt-path">' +
      escapeHtml(el.dataset.path || "—") +
      "</div>" +
      '<div class="tt-detail">' +
      escapeHtml((el.dataset.role || "") + (el.dataset.detail ? " · " + el.dataset.detail : "")) +
      "</div>";
    var x = ev.clientX - wr.left + 12;
    var y = ev.clientY - wr.top + 12;
    crateTooltip.style.left = Math.min(x, wr.width - 200) + "px";
    crateTooltip.style.top = Math.min(y, wr.height - 60) + "px";
  }

  function openActivityDrawer(filterRole) {
    activityFilterRole = filterRole || null;
    if (drawerActivity) drawerActivity.open = true;
    renderActivity();
    sound.play("click");
  }

  function openPanels() {
    if (drawerBill) drawerBill.open = true;
    if (drawerLog) drawerLog.open = true;
    if (drawersEl) drawersEl.classList.add("panels-open");
    if (panelsBtn) {
      panelsBtn.classList.add("on");
      panelsBtn.setAttribute("aria-pressed", "true");
    }
  }

  function togglePanels() {
    var anyOpen = (drawerBill && drawerBill.open) || (drawerLog && drawerLog.open);
    if (anyOpen) {
      if (drawerBill) drawerBill.open = false;
      if (drawerLog) drawerLog.open = false;
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

  function setActive(roles) {
    var set = {};
    (roles || []).forEach(function (r) {
      set[r] = true;
    });
    Object.keys(cards).forEach(function (key) {
      if (cards[key]) cards[key].classList.toggle("active", !!set[key]);
    });
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
    var el = statusEls[role];
    if (!el) return;
    el.className = "status" + (cls ? " " + cls : "");
    el.innerHTML = html;
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
    footerSessionCost.textContent = formatMoney(sessionTotal);
    if (hudSessionCost) hudSessionCost.textContent = formatMoney(sessionTotal);
    footerTokens.textContent = formatTokens(u.haiku.in + u.haiku.out);

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
      billEls.multiplier.textContent = "—";
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

  function addUsage(usage) {
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
      /* Live may send model=haiku without role — attribute to explorer by default */
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
    var path = item.path || "—";
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
    footerSubs.textContent = String(n);
    if (hudSubs) hudSubs.textContent = String(n);
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
    /* Workshop paths are fixed in SVG viewBox — no card-geometry layout. */
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
      } else {
        pulsePath("path-d-worker-pulse");
        pulsePath("path-d-explorer-pulse");
        pulsePath("path-d-researcher-pulse");
      }
    }
  }

  function emptyLogMessage() {
    return mode === "live"
      ? "Live mode · waiting for transcript events from the bridge…"
      : "Waiting for session… choose Demo · Play or Live.";
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
      return;
    }
    projectPicker.disabled = false;
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
    if (mode === "demo") {
      demoBtn.textContent = "Play";
      demoBtn.hidden = false;
      liveHint.hidden = true;
      setProjectPickerVisible(false);
      updateFooterProject();
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
    advisorLastEl.textContent = "Last advice: —";
    footerEffort.textContent = mode === "live" ? "live" : "mixed";
    state.usage = emptyUsage();
    renderBill();
    clearActivity();
    billEls.illustrative.textContent =
      mode === "live"
        ? "Live estimates from transcript activity · not official usage"
        : "estimated · not official usage · demo narrative";
    sessionLog.innerHTML = "";
    logEmpty = document.createElement("div");
    logEmpty.className = "log-empty";
    logEmpty.id = "logEmpty";
    logEmpty.textContent = emptyLogMessage();
    sessionLog.appendChild(logEmpty);
  }

  function applyLiveEvent(ev) {
    if (!ev || seenLiveIds[ev.id]) return;
    seenLiveIds[ev.id] = true;

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
    rememberLiveFocus(explicit, active);
    setActive(mergeStickyActive(active));

    var msg = ev.message || "";
    setStatus(cardRole, '<span class="live">' + escapeHtml(msg) + "</span>");
    if (role === "advisor" || ev.kind === "asks") {
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
      addUsage({
        model: ev.usage.model,
        role: ev.usage.role || role,
        in: ev.usage.in,
        out: ev.usage.out
      });
    } else if (ev.tokensDelta) {
      /* Backward compat: attribute legacy deltas to Haiku reads */
      addUsage({
        model: "haiku",
        role: role === "researcher" ? "researcher" : "explorer",
        in: Number(ev.tokensDelta) || 0,
        out: 0
      });
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
    if (ev.route) animateRoute(ev.route, ev.routeTo || cardRole);

    var logRole = role === "parent" ? "parent" : role;
    appendLog(logRole, msg, null, ev.ts);
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
    clearStickyActive();
    demoBtn.classList.remove("live-connected");
  }

  function startLive() {
    stopLive();
    seenLiveIds = {};
    resetUI();
    liveHint.hidden = false;
    liveHint.className = "live-hint";

    // file:// cannot use Live (Origin "null" is rejected by the bridge on purpose).
    if (location.protocol === "file:") {
      liveHint.className = "live-hint err";
      liveHint.textContent =
        "Live needs the bridge — open " + BRIDGE.replace(/\/$/, "") + "/ (or run npm start)";
      demoBtn.classList.remove("live-connected");
      demoBtn.textContent = "Reconnect";
      setProjectPickerVisible(false);
      return;
    }

    liveHint.textContent = "Connecting to " + BRIDGE + "…";
    setProjectPickerVisible(true);
    loadProjects();

    function hintLabel() {
      return currentProjectLabel || "agent-transcripts";
    }

    function onOk(meta) {
      if (meta && meta.projectLabel) {
        currentProjectLabel = meta.projectLabel;
        currentProjectId = meta.projectId || currentProjectId;
        updateFooterProject();
        if (projectPicker && currentProjectId) {
          projectPicker.value = currentProjectId;
        }
      }
      liveHint.className = "live-hint ok";
      liveHint.textContent = "Streaming · " + hintLabel();
      demoBtn.classList.add("live-connected");
      demoBtn.textContent = "Connected";
    }

    function onErr(msg) {
      liveHint.className = "live-hint err";
      liveHint.textContent = msg || "Bridge offline — use npm start or node live-bridge.js";
      demoBtn.classList.remove("live-connected");
      demoBtn.textContent = "Reconnect";
    }

    function onReset(meta) {
      seenLiveIds = {};
      if (meta) {
        if (meta.projectLabel) currentProjectLabel = meta.projectLabel;
        if (meta.projectId) currentProjectId = meta.projectId;
      }
      resetUI({ keepActive: false });
      liveHint.hidden = false;
      liveHint.className = "live-hint ok";
      liveHint.textContent = "Switched · " + hintLabel();
      demoBtn.classList.add("live-connected");
      demoBtn.textContent = "Connected";
      updateFooterProject();
      loadProjects();
    }

    if (typeof EventSource === "undefined") {
      onErr("EventSource unavailable in this browser");
      return;
    }

    try {
      es = new EventSource(BRIDGE + "/api/stream");
    } catch (_e) {
      onErr("Cannot open SSE — start the app (npm start)");
      return;
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
        applyLiveEvent(JSON.parse(msg.data));
      } catch (_) {}
    };
    es.onerror = function () {
      onErr("Bridge offline — use npm start or node live-bridge.js");
      stopLive();
    };
  }

  /* Demo narrative — advances Opus / Fable / Sonnet / Haiku bill buckets */
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
      footerEffort.textContent = "high";
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
        detail: "lines 1–240"
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
        "Last advice: stop / change approach — fix signature mismatch first";
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
      advisorLastEl.textContent = "Last advice: ship it — Haiku absorbed the read load";
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
      footerEffort.textContent = "done";
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
        // Restart Live stream; SSE "reset" also clears if the bridge emits it
        startLive();
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
  }

  Object.keys(stageDirector.chars).forEach(function (role) {
    var el = stageDirector.chars[role];
    if (!el) return;
    function onChar() {
      stageDirector.selectCharacter(role);
      openActivityDrawer(role);
      if (drawerStations) drawerStations.open = true;
      showToast((ROLE_LABEL[role] || role) + " · filtering Activity");
      if (cards[role]) {
        cards[role].scrollIntoView({
          block: "nearest",
          behavior: prefersReducedMotion() ? "auto" : "smooth"
        });
      }
    }
    el.addEventListener("click", onChar);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onChar();
      }
    });
  });

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
  clearActivity();
  updateFooterProject();
  sound.syncBtn();
  requestAnimationFrame(function () {
    layoutFlow();
  });

  // Auto-Live when served by the bridge (any localhost port)
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin)) {
    setMode("live");
  }
})();
