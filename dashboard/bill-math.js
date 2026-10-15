/**
 * Pure bill/usage math: rate table, token and money formatting, model normalization,
 * and session-summary serialization. No DOM and no shared state, so it can be unit
 * tested directly (see test/unit/bill-math.test.js). Loaded before app.js.
 */
(function () {
  "use strict";

  var RATES = {
    opus: { in: 4.0, out: 20.0 },
    fable: { in: 10.0, out: 50.0 },
    sonnet: { in: 2.0, out: 10.0 },
    haiku: { in: 0.1, out: 0.5 }
  };

  var MODEL_KEYS = ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"];

  function emptyUsage() {
    var out = {};
    MODEL_KEYS.forEach(function (key) {
      out[key] = { in: 0, out: 0 };
    });
    return out;
  }

  /** Total input+output tokens. Explorer/researcher are Haiku sublines, not extra rows. */
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

  /** Model/role to the four billed rate buckets. Explorer and researcher bill as Haiku. */
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

  /** The rate bucket a display row bills against (explorer/researcher share Haiku). */
  function rateKeyFor(modelKey) {
    return modelKey === "explorer" || modelKey === "researcher" ? "haiku" : modelKey;
  }

  function csvCell(value) {
    var s = value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function summaryToCsv(summary) {
    var lines = ["model,inputTokens,outputTokens,estimatedCostUsd"];
    summary.models.forEach(function (row) {
      lines.push([row.model, row.inputTokens, row.outputTokens, row.estimatedCostUsd].join(","));
    });
    lines.push(
      [
        "TOTAL",
        summary.totals.inputTokens,
        summary.totals.outputTokens,
        summary.totals.estimatedCostUsd
      ].join(",")
    );
    lines.push("");
    lines.push(csvCell("note") + "," + csvCell(summary.disclaimer));
    return lines.join("\n") + "\n";
  }

  window.WorkshopBillMath = {
    RATES: RATES,
    MODEL_KEYS: MODEL_KEYS,
    emptyUsage: emptyUsage,
    usageGrandTotal: usageGrandTotal,
    formatTokens: formatTokens,
    formatMoney: formatMoney,
    normalizeModel: normalizeModel,
    modelCost: modelCost,
    rateKeyFor: rateKeyFor,
    csvCell: csvCell,
    summaryToCsv: summaryToCsv
  };
})();
