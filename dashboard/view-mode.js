/**
 * Header view switching (Stage | Insights | History) and the Panels toggle. Owns the
 * current view mode and the drawer-sheet focus policy. Loaded before app.js; exposes
 * window.WorkshopViewMode. DOM and session dependencies arrive through init(deps).
 */
(function () {
  "use strict";

  var d = null;
  var viewMode = "stage";
  var historyAllowed = true;
  var focusWasInDrawer = false;
  var VIEW_MODE_KEY = "cursorAgents.viewMode";

  function init(deps) {
    d = deps || {};
    if (d.drawerHistory) {
      d.drawerHistory.addEventListener("toggle", function () {
        if (d.drawerHistory.open) {
          if (viewMode === "history") {
            mountHistoryReplay();
            return;
          }
          // The summary can open the drawer straight from Stage or Insights: list sessions
          // and, where a session can be replayed, mount the transport (no scroll: the user just
          // opened this drawer).
          // Listing sessions can repaint the transport (dropping a replay), so note which control
          // has focus first and hand it back after the mount.
          var keep = focusInsideTransport();
          if (typeof d.onHistoryOpen === "function") d.onHistoryOpen();
          if (drawerReplayAvailable()) mountHistoryReplay({ noScroll: true, keep: keep });
          updateHistoryHint(false);
        } else if (viewMode !== "history") {
          // Closing the drawer outside the History view hands the stage back, like leaving History.
          // The toggle event arrives after the drawer is already closed, so focus may be on the
          // body by now: rescue it when it was inside the drawer (see trackDrawerFocus).
          rescueDrawerFocus();
          if (typeof d.onHistoryLeave === "function") d.onHistoryLeave();
          updateHistoryHint(false);
        }
      });
      trackDrawerFocus();
    }
    var stored = null;
    try {
      stored = sessionStorage.getItem(VIEW_MODE_KEY);
    } catch (_e) {
      /* storage unavailable */
    }
    setViewMode(stored || "stage", { skipPersist: true });
  }

  /**
   * Remembers whether focus last sat inside the History drawer, because a closed drawer hides
   * its content and the browser drops focus to the body before the toggle event runs. A focusout
   * to nowhere only clears the flag while the drawer is still open (a click on blank page); once
   * the drawer is closed that blur is the close itself and the flag is kept.
   */
  function trackDrawerFocus() {
    if (typeof document.addEventListener !== "function") return;
    document.addEventListener(
      "focusin",
      function (e) {
        focusWasInDrawer = !!e.target && d.drawerHistory.contains(e.target);
      },
      true
    );
    document.addEventListener(
      "focusout",
      function (e) {
        if (!e.relatedTarget && d.drawerHistory.open) focusWasInDrawer = false;
      },
      true
    );
  }

  /** The drawer just closed: if focus was inside it, hand it to the drawer's summary. */
  function rescueDrawerFocus() {
    var active = document.activeElement;
    var gone = !active || active === document.body;
    var inside = (!gone && d.drawerHistory.contains(active)) || (gone && focusWasInDrawer);
    focusWasInDrawer = false;
    if (!inside) return;
    var summary = d.drawerHistory.querySelector("summary");
    if (!summary || summary === active || typeof summary.focus !== "function") return;
    try {
      summary.focus({ preventScroll: true });
    } catch (_e) {
      /* ignore */
    }
  }

  function normalizeViewMode(mode) {
    var m = String(mode || "").toLowerCase();
    if (m === "insights" || m === "history") return m;
    return "stage";
  }

  function getMode() {
    return viewMode;
  }

  function syncViewModeButtons(mode) {
    [
      { el: d.viewStageBtn, mode: "stage" },
      { el: d.viewInsightsBtn, mode: "insights" },
      { el: d.viewHistoryBtn, mode: "history" }
    ].forEach(function (b) {
      if (!b.el) return;
      var on = b.mode === mode;
      b.el.classList.toggle("on", on);
      b.el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function bindViewModeButton(btn, mode) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      setViewMode(mode);
    });
  }

  /** True while the History drawer can play a session from Stage or Insights (Live on Claude Code). */
  function drawerReplayAvailable() {
    return !!d && typeof d.drawerReplayAvailable === "function" && !!d.drawerReplayAvailable();
  }

  /** The History view, or the History drawer opened from Stage or Insights. */
  function isHistoryOpen() {
    return viewMode === "history" || !!(d && d.drawerHistory && d.drawerHistory.open);
  }

  function updateHistoryHint(driving) {
    if (!d.historyHint) return;
    var text;
    if (driving) text = "Replay driving stage";
    else if (viewMode === "history") text = "Play or scrub to drive the workshop stage.";
    else if (drawerReplayAvailable())
      text = "Pick a session, then Play or scrub to drive the stage until you close this drawer.";
    else text = "Open the History tab to replay sessions.";
    // A live region: only touch it when the words change.
    if (d.historyHint.textContent !== text) d.historyHint.textContent = text;
  }

  /** Stable markers of the transport controls, in the order they are tried. */
  var TRANSPORT_KEYS = ["data-replay-play", "data-replay-pause", "data-scrubber", "data-speed"];

  /**
   * Before the transport is moved: a selector for the focused control when focus is inside it
   * (the host from an earlier mount, or the transport still painted elsewhere), else null.
   * The repaint replaces the element, so the control is found again by its data attribute.
   */
  function focusInsideTransport() {
    var host = document.getElementById("historyReplayHost");
    var active = document.activeElement;
    if (!host || !active || active === document.body) return null;
    var inside =
      host.contains(active) ||
      (typeof active.closest === "function" && !!active.closest(".insights-replay"));
    if (!inside) return null;
    for (var i = 0; i < TRANSPORT_KEYS.length; i++) {
      var v = active.getAttribute(TRANSPORT_KEYS[i]);
      if (v !== null)
        return {
          selector: v ? "[" + TRANSPORT_KEYS[i] + '="' + v + '"]' : "[" + TRANSPORT_KEYS[i] + "]"
        };
    }
    return { selector: null };
  }

  /** After the move: the same control, else the drawer's summary. */
  function restoreTransportFocus(host, keep) {
    var target = keep.selector ? host.querySelector(keep.selector) : null;
    if (!target && d.drawerHistory) target = d.drawerHistory.querySelector("summary");
    if (!target || typeof target.focus !== "function") return;
    try {
      target.focus({ preventScroll: true });
    } catch (_e) {
      /* ignore */
    }
  }

  function mountHistoryReplay(opts) {
    var host = document.getElementById("historyReplayHost");
    var panel = d.getInsightsPanel();
    if (!host || !panel || typeof panel.mountReplay !== "function") return;
    var keep = (opts && opts.keep) || focusInsideTransport();
    panel.mountReplay(host);
    if (keep) restoreTransportFocus(host, keep);
    if (opts && opts.noScroll) return;
    try {
      var playBtn = host.querySelector(".insights-transport-btn");
      (playBtn || host).scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_e) {
      /* scroll is best effort */
    }
  }

  function remountHistoryReplayIfNeeded() {
    if (viewMode === "history") mountHistoryReplay();
    else if (d && d.drawerHistory && d.drawerHistory.open && drawerReplayAvailable())
      mountHistoryReplay({ noScroll: true });
  }

  /** The mode or source changed: an open drawer outside the History view follows what it can replay. */
  function refreshDrawerReplay() {
    if (!d || !d.drawerHistory || !d.drawerHistory.open || viewMode === "history") return;
    if (drawerReplayAvailable()) mountHistoryReplay({ noScroll: true });
    updateHistoryHint(false);
  }

  /**
   * Focus ownership for the drawer sheets. These are non-modal panels revealed by
   * aria-pressed toggle buttons, so opening one must NOT steal focus - the toggle stays
   * focused and keyboard users Tab onward. The real hazard is the reverse: if focus sits
   * inside a sheet and a view change hides that sheet, focus is destroyed and the next
   * Tab restarts from the top of the document. This moves it back to the view control.
   */
  function focusIsInsideHiddenSheet(nextDrawer) {
    var active = document.activeElement;
    if (!active || active === document.body) return false;
    var sheets = [
      d.drawerActivity,
      d.drawerBill,
      d.drawerLog,
      d.drawerStations,
      d.drawerInsights,
      d.drawerHistory
    ];
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (!sheet || sheet === nextDrawer) continue;
      if (sheet.contains(active)) return true;
    }
    return false;
  }

  /** Return focus to the active view control after its sheet took focus away. */
  function restoreViewFocus() {
    var el =
      viewMode === "insights"
        ? d.viewInsightsBtn
        : viewMode === "history"
          ? d.viewHistoryBtn
          : d.viewStageBtn;
    if (!el || typeof el.focus !== "function") return;
    try {
      el.focus({ preventScroll: true });
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Primary nav: Stage | Insights | History.
   * Sets `data-view-mode` on #app, syncs header buttons, persists to sessionStorage
   * (unless opts.skipPersist). Each mode opens the matching lower drawer and closes
   * others: stage -> Activity; insights -> Insights (forecast tab); history -> History
   * (replay tab, remounts the transport, scrolls into view; never auto-plays).
   */
  function setViewMode(mode, opts) {
    opts = opts || {};
    viewMode = normalizeViewMode(mode);
    // While History is switched off (setHistoryAllowed(false)) every way in lands on Stage.
    if (viewMode === "history" && !historyAllowed) viewMode = "stage";
    var panel = d.getInsightsPanel();
    var reclaimFocus = focusIsInsideHiddenSheet(
      viewMode === "insights"
        ? d.drawerInsights
        : viewMode === "history"
          ? d.drawerHistory
          : viewMode === "stage"
            ? d.drawerActivity
            : null
    );

    if (d.appEl) d.appEl.setAttribute("data-view-mode", viewMode);
    syncViewModeButtons(viewMode);
    if (!opts.skipPersist) {
      try {
        sessionStorage.setItem(VIEW_MODE_KEY, viewMode);
      } catch (_e) {
        /* storage unavailable */
      }
    }

    if (viewMode === "stage") {
      if (d.drawerInsights) d.drawerInsights.open = false;
      if (d.drawerHistory) d.drawerHistory.open = false;
      if (d.drawerActivity) d.drawerActivity.open = true;
      if (typeof d.endReplaySession === "function") d.endReplaySession();
    } else if (viewMode === "insights") {
      if (d.drawerHistory) d.drawerHistory.open = false;
      if (d.drawerActivity) d.drawerActivity.open = false;
      if (d.drawerInsights) d.drawerInsights.open = true;
      if (panel && typeof panel.showTab === "function") panel.showTab("forecast");
      if (panel && typeof panel.pause === "function") panel.pause();
    } else if (viewMode === "history") {
      if (d.drawerInsights) d.drawerInsights.open = false;
      if (d.drawerActivity) d.drawerActivity.open = false;
      if (d.drawerStations) d.drawerStations.open = false;
      if (d.drawerBill) d.drawerBill.open = false;
      if (d.drawerLog) d.drawerLog.open = false;
      if (d.drawerHistory) {
        d.drawerHistory.open = true;
        try {
          d.drawerHistory.scrollIntoView({ block: "start", behavior: "smooth" });
          d.drawerHistory.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch (_e) {
          /* scroll is best effort */
        }
      }
      updateHistoryHint(false);
      if (panel) {
        if (typeof panel.showTab === "function") panel.showTab("replay");
        mountHistoryReplay();
        /* Do not auto-play. The user hits Play in the History transport. */
        if (typeof panel.pause === "function") panel.pause();
      }
      if (typeof d.onHistoryOpen === "function") d.onHistoryOpen();
    }

    if (reclaimFocus) restoreViewFocus();

    if (viewMode !== "history" && panel && typeof panel.pause === "function") panel.pause();
    if (viewMode !== "history" && typeof d.onHistoryLeave === "function") d.onHistoryLeave();
    if (viewMode !== "history") updateHistoryHint(false);
  }

  /** The data source the page shows; Claude Code (the default) when the switch script is absent. */
  function currentSource() {
    return window.WorkshopSource ? window.WorkshopSource.getSource() : "claude-code";
  }

  /**
   * History is available in Demo and in Live on either source (Cursor reads the event log,
   * Claude Code lists its older sessions). `mode` is kept for the call sites.
   */
  function syncHistoryAllowed(_mode) {
    setHistoryAllowed(true);
    refreshDrawerReplay();
  }

  /**
   * After a project pick: Cursor opens History (its picker reloads Insights onto the latest
   * session); Claude Code stays where it is, History only opens from its header button.
   * Returns true when History was requested.
   */
  function navigateAfterProjectPick() {
    if (currentSource() === "claude-code") return false;
    setViewMode("history");
    return true;
  }

  /** Show or hide History. Turning it off while History is open returns to Stage. */
  function setHistoryAllowed(allowed) {
    historyAllowed = !!allowed;
    var hadFocus =
      !!d && !!d.viewHistoryBtn && !historyAllowed && document.activeElement === d.viewHistoryBtn;
    if (d && d.viewHistoryBtn) d.viewHistoryBtn.hidden = !historyAllowed;
    if (d && !historyAllowed && viewMode === "history") setViewMode("stage");
    // A hidden button cannot keep focus: hand it to the Stage button, not the page top.
    if (hadFocus && d.viewStageBtn && typeof d.viewStageBtn.focus === "function") {
      try {
        d.viewStageBtn.focus({ preventScroll: true });
      } catch (_e) {
        /* ignore */
      }
    }
  }

  function openPanels() {
    if (d.drawerBill) d.drawerBill.open = true;
    if (d.drawerLog) d.drawerLog.open = true;
    if (d.drawerInsights) d.drawerInsights.open = true;
    if (d.drawersEl) d.drawersEl.classList.add("panels-open");
    if (d.panelsBtn) {
      d.panelsBtn.classList.add("on");
      d.panelsBtn.setAttribute("aria-pressed", "true");
      d.panelsBtn.setAttribute("title", "Open panels");
      d.panelsBtn.setAttribute("aria-label", "Open panels");
    }
  }

  function togglePanels() {
    var anyOpen =
      (d.drawerBill && d.drawerBill.open) ||
      (d.drawerLog && d.drawerLog.open) ||
      (d.drawerInsights && d.drawerInsights.open && viewMode === "stage");
    if (anyOpen) {
      if (d.drawerBill) d.drawerBill.open = false;
      if (d.drawerLog) d.drawerLog.open = false;
      if (viewMode === "stage" && d.drawerInsights) d.drawerInsights.open = false;
      if (d.drawersEl) d.drawersEl.classList.remove("panels-open");
      if (d.panelsBtn) {
        d.panelsBtn.classList.remove("on");
        d.panelsBtn.setAttribute("aria-pressed", "false");
      }
    } else {
      openPanels();
    }
    if (d.sound) d.sound.play("click");
  }

  window.WorkshopViewMode = {
    init: init,
    setViewMode: setViewMode,
    setHistoryAllowed: setHistoryAllowed,
    currentSource: currentSource,
    syncHistoryAllowed: syncHistoryAllowed,
    navigateAfterProjectPick: navigateAfterProjectPick,
    getMode: getMode,
    isHistoryOpen: isHistoryOpen,
    normalizeViewMode: normalizeViewMode,
    syncViewModeButtons: syncViewModeButtons,
    bindViewModeButton: bindViewModeButton,
    openPanels: openPanels,
    togglePanels: togglePanels,
    updateHistoryHint: updateHistoryHint,
    mountHistoryReplay: mountHistoryReplay,
    remountHistoryReplayIfNeeded: remountHistoryReplayIfNeeded
  };
})();
