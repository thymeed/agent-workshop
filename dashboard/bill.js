/**
 * Session Bill: the usage counters and their DOM. Owns the demo usage baseline and does
 * all bill math through dashboard/bill-math.js. Exposed as window.WorkshopBill. The
 * shared session state object is passed in by reference, so the rest of the dashboard
 * keeps reading `state.usage` / `state.calls` / `state.subs` unchanged.
 */
(function () {
  "use strict";

  var d = null;
  var lastDemoUsageTotal = 0;

  function init(deps) {
    d = deps || {};
  }

  function usage() {
    return d.state.usage;
  }

  function syncDailyStats() {
    if (!d.cards()) return;
    if (d.getMode() === "live") {
      if (typeof d.cards().syncLiveSubs === "function") d.cards().syncLiveSubs(d.state.subs);
      return;
    }
    var total = d.billMath.usageGrandTotal(d.state.usage);
    var delta = total - lastDemoUsageTotal;
    if (delta > 0 && typeof d.cards().addTokens === "function") d.cards().addTokens(delta);
    lastDemoUsageTotal = total;
  }

  /** Paint the bill grid, the session total, and the savings comparison. */
  function render() {
    var u = usage();
    var m = d.billMath;
    var els = d.billEls;
    var costs = {
      opus: m.modelCost("opus", u.opus.in, u.opus.out),
      fable: m.modelCost("fable", u.fable.in, u.fable.out),
      sonnet: m.modelCost("sonnet", u.sonnet.in, u.sonnet.out),
      haiku: m.modelCost("haiku", u.haiku.in, u.haiku.out),
      explorer: m.modelCost("haiku", u.explorer.in, u.explorer.out),
      researcher: m.modelCost("haiku", u.researcher.in, u.researcher.out)
    };

    ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"].forEach(function (key) {
      els[key + "In"].textContent = m.formatTokens(u[key].in);
      els[key + "Out"].textContent = m.formatTokens(u[key].out);
      els[key + "Cost"].textContent = m.formatMoney(costs[key]);
    });

    var sessionTotal = costs.opus + costs.fable + costs.sonnet + costs.haiku;
    var totalIn = u.opus.in + u.fable.in + u.sonnet.in + u.haiku.in;
    var totalOut = u.opus.out + u.fable.out + u.sonnet.out + u.haiku.out;
    var allOpus = m.modelCost("opus", totalIn, totalOut);

    els.sessionTotal.textContent = m.formatMoney(sessionTotal);
    els.allOpus.textContent = m.formatMoney(allOpus);
    if (d.hud.sessionCost) d.hud.sessionCost.textContent = m.formatMoney(sessionTotal);
    if (d.hud.tokens) d.hud.tokens.textContent = m.formatTokens(u.haiku.in + u.haiku.out);

    if (sessionTotal > 0 && allOpus > sessionTotal) {
      var mult = allOpus / Math.max(sessionTotal, 0.0001);
      els.multiplier.textContent = "~" + (mult >= 10 ? Math.round(mult) : mult.toFixed(1)) + "×";
      els.savingsNote.textContent =
        m.formatMoney(allOpus) + " → " + m.formatMoney(sessionTotal) + " · vs all-Opus";
    } else if (sessionTotal > 0) {
      els.multiplier.textContent = "~1×";
      els.savingsNote.textContent = "routed cost near all-Opus";
    } else {
      els.multiplier.textContent = "n/a";
      els.savingsNote.textContent = "savings vs all-Opus";
    }

    var shareTotal = sessionTotal || 0;
    function setShare(el, cost) {
      el.style.width = (shareTotal > 0 ? (cost / shareTotal) * 100 : 0) + "%";
    }
    setShare(els.shareOpus, costs.opus);
    setShare(els.shareFable, costs.fable);
    setShare(els.shareSonnet, costs.sonnet);
    setShare(els.shareHaiku, costs.haiku);
  }

  /** Which station's spark an incoming usage row belongs to. */
  function sparkRoleFor(role, model) {
    if (role === "advisor" || role === "fable") return "advisor";
    if (role === "worker" || role === "sonnet") return "worker";
    if (role === "explorer") return "explorer";
    if (role === "researcher") return "researcher";
    if (model === "fable") return "advisor";
    if (model === "sonnet") return "worker";
    if (model === "haiku") return "explorer";
    return "opus";
  }

  /** Add one usage row to the session totals. opts.skipDaily skips the daily counter. */
  function addUsage(usageRow, opts) {
    opts = opts || {};
    if (!usageRow) return;
    var m = d.billMath;
    var role = String(usageRow.role || "").toLowerCase();
    var model = m.normalizeModel(usageRow.model, role);
    var inn = Math.max(0, Number(usageRow.in) || 0);
    var out = Math.max(0, Number(usageRow.out) || 0);
    if (!inn && !out) return;

    var u = usage();
    u[model].in += inn;
    u[model].out += out;
    if (role === "explorer" || role === "researcher") {
      u[role].in += inn;
      u[role].out += out;
    } else if (model === "haiku") {
      /* Live may send model=haiku without a role. Attribute to explorer by default. */
      u.explorer.in += inn;
      u.explorer.out += out;
    }
    render();

    var spark = sparkRoleFor(role, model);
    d.tipSpark(spark);
    if (opts.skipDaily) return;
    if (d.getMode() === "live" && d.cards() && typeof d.cards().addTokens === "function") {
      d.cards().addTokens(inn + out, spark);
    } else {
      syncDailyStats();
    }
  }

  /** Replace the whole usage snapshot (demo beats, replay seek). */
  function setUsageSnapshot(snap, sparkRole) {
    var m = d.billMath;
    d.state.usage = m.emptyUsage();
    var u = d.state.usage;
    if (!snap) {
      render();
      return;
    }
    m.MODEL_KEYS.forEach(function (key) {
      if (!snap[key]) return;
      u[key].in = Math.max(0, Number(snap[key].in) || 0);
      u[key].out = Math.max(0, Number(snap[key].out) || 0);
    });
    /* The Haiku row is the max of its explorer/researcher sublines and any explicit haiku. */
    var subIn = u.explorer.in + u.researcher.in;
    var subOut = u.explorer.out + u.researcher.out;
    if (subIn > u.haiku.in) u.haiku.in = subIn;
    if (subOut > u.haiku.out) u.haiku.out = subOut;
    render();
    if (sparkRole) d.tipSpark(sparkRole);
    syncDailyStats();
  }

  /** Swap in a prebuilt usage object and re-baseline the demo daily counter. */
  function replaceUsage(next) {
    d.state.usage = next || d.billMath.emptyUsage();
    lastDemoUsageTotal = 0;
    syncDailyStats();
  }

  /** Zero the session usage and the demo baseline, then repaint. */
  function resetUsage() {
    d.state.usage = d.billMath.emptyUsage();
    lastDemoUsageTotal = 0;
    render();
  }

  /** Re-baseline the demo daily counter without touching the usage table. */
  function resetDemoTotal() {
    lastDemoUsageTotal = 0;
  }

  function setCalls(n) {
    d.state.calls = n;
    d.advisorCallsEl.textContent = String(n);
  }

  function setSubs(n) {
    d.state.subs = n;
    if (d.hud.subs) d.hud.subs.textContent = String(n);
    syncDailyStats();
  }

  function setEffort(label) {
    if (d.hud.effort) d.hud.effort.textContent = label || "mixed";
  }

  window.WorkshopBill = {
    init: init,
    render: render,
    addUsage: addUsage,
    setUsageSnapshot: setUsageSnapshot,
    replaceUsage: replaceUsage,
    resetUsage: resetUsage,
    resetDemoTotal: resetDemoTotal,
    syncDailyStats: syncDailyStats,
    setCalls: setCalls,
    setSubs: setSubs,
    setEffort: setEffort,
    sparkRoleFor: sparkRoleFor
  };
})();
