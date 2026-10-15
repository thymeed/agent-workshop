/**
 * Header view switching (Stage | Insights | History) and the Panels toggle. Owns the
 * current view mode and the drawer-sheet focus policy. Loaded before app.js; exposes
 * window.WorkshopViewMode. DOM and session dependencies arrive through init(deps).
 */
(function () {
  "use strict";

  var d = null;
  var viewMode = "stage";
  var VIEW_MODE_KEY = "cursorAgents.viewMode";

  function init(deps) {
    d = deps || {};
    if (d.drawerHistory) {
      d.drawerHistory.addEventListener("toggle", function () {
        if (d.drawerHistory.open && viewMode === "history") mountHistoryReplay();
      });
    }
    var stored = null;
    try {
      stored = sessionStorage.getItem(VIEW_MODE_KEY);
    } catch (_e) {
      /* storage unavailable */
    }
    setViewMode(stored || "stage", { skipPersist: true });
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

  function updateHistoryHint(driving) {
    if (!d.historyHint) return;
    d.historyHint.textContent = driving
      ? "Replay driving stage"
      : "Play or scrub to drive the workshop stage.";
  }

  function mountHistoryReplay() {
    var host = document.getElementById("historyReplayHost");
    var panel = d.getInsightsPanel();
    if (!host || !panel || typeof panel.mountReplay !== "function") return;
    panel.mountReplay(host);
    try {
      var playBtn = host.querySelector(".insights-transport-btn");
      (playBtn || host).scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_e) {
      /* scroll is best effort */
    }
  }

  function remountHistoryReplayIfNeeded() {
    if (viewMode !== "history") return;
    mountHistoryReplay();
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
    }

    if (reclaimFocus) restoreViewFocus();

    if (viewMode !== "history" && panel && typeof panel.pause === "function") panel.pause();
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
    getMode: getMode,
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
