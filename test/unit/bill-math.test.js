/**
 * Direct unit tests for dashboard/bill-math.js. The module is a browser IIFE, so it is
 * loaded here in a vm sandbox with a stub `window` - no browser, no bridge, no DOM.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "bill-math.js");

function load() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  assert.ok(sandbox.window.WorkshopBillMath, "bill-math.js must expose window.WorkshopBillMath");
  return sandbox.window.WorkshopBillMath;
}

const M = load();

test("exposes the full expected surface", () => {
  for (const key of [
    "RATES",
    "MODEL_KEYS",
    "emptyUsage",
    "usageGrandTotal",
    "formatTokens",
    "formatMoney",
    "normalizeModel",
    "modelCost",
    "rateKeyFor",
    "csvCell",
    "summaryToCsv"
  ]) {
    assert.ok(key in M, `missing export: ${key}`);
  }
});

test("emptyUsage zeroes every bucket and is independent per call", () => {
  const a = M.emptyUsage();
  assert.deepEqual(Object.keys(a).sort(), [...M.MODEL_KEYS].sort());
  for (const k of M.MODEL_KEYS) {
    /* Compare primitives: the module's objects come from a vm realm, so a strict
       deep-equal against a host-realm literal fails on the prototype. */
    assert.equal(a[k].in, 0, `${k}.in must start at 0`);
    assert.equal(a[k].out, 0, `${k}.out must start at 0`);
  }
  const b = M.emptyUsage();
  a.opus.in = 5;
  assert.equal(b.opus.in, 0, "emptyUsage must not share bucket objects between calls");
});

test("usageGrandTotal sums input+output and skips Haiku sublines", () => {
  assert.equal(M.usageGrandTotal(null), 0);
  assert.equal(M.usageGrandTotal({}), 0);
  const usage = M.emptyUsage();
  usage.opus = { in: 100, out: 200 };
  usage.sonnet = { in: 10, out: 20 };
  assert.equal(M.usageGrandTotal(usage), 330);
  usage.explorer = { in: 9999, out: 9999 };
  usage.researcher = { in: 9999, out: 9999 };
  assert.equal(M.usageGrandTotal(usage), 330, "explorer/researcher must not double-count");
});

test("usageGrandTotal tolerates junk values", () => {
  assert.equal(
    M.usageGrandTotal({ opus: { in: "12", out: null }, fable: { in: undefined, out: "3" } }),
    15
  );
  assert.equal(M.usageGrandTotal({ opus: null }), 0);
});

test("formatTokens switches at 1000 and 1e6", () => {
  assert.equal(M.formatTokens(0), "0");
  assert.equal(M.formatTokens(999), "999");
  assert.equal(M.formatTokens(1000), "1K");
  assert.equal(M.formatTokens(1500), "2K");
  assert.equal(M.formatTokens(999999), "1000K");
  assert.equal(M.formatTokens(1000000), "1.0M");
  assert.equal(M.formatTokens(1500000), "1.5M");
  assert.equal(M.formatTokens(-5), "0", "negatives clamp to 0");
  assert.equal(M.formatTokens(undefined), "0");
});

test("formatMoney uses three decimals under a cent and clamps junk", () => {
  assert.equal(M.formatMoney(0), "$0.00");
  assert.equal(M.formatMoney(1.5), "$1.50");
  assert.equal(M.formatMoney(0.005), "$0.005");
  assert.equal(M.formatMoney(0.01), "$0.01");
  assert.equal(M.formatMoney(-3), "$0.00");
  assert.equal(M.formatMoney(NaN), "$0.00");
  assert.equal(M.formatMoney(Infinity), "$0.00");
});

test("normalizeModel prefers an explicit model over the role", () => {
  assert.equal(M.normalizeModel("opus", "worker"), "opus", "explicit model wins");
  assert.equal(M.normalizeModel("HAIKU"), "haiku", "case-insensitive");
  assert.equal(M.normalizeModel("", "parent"), "opus");
  assert.equal(M.normalizeModel("", "advisor"), "fable");
  assert.equal(M.normalizeModel("", "worker"), "sonnet");
  assert.equal(M.normalizeModel("", "explorer"), "haiku");
  assert.equal(M.normalizeModel("", "researcher"), "haiku");
  assert.equal(M.normalizeModel("", "mystery"), "opus", "unknown role falls back to opus");
  assert.equal(M.normalizeModel(null, null), "opus");
});

test("modelCost applies published per-million rates", () => {
  assert.equal(M.modelCost("opus", 1000000, 0), 4);
  assert.equal(M.modelCost("opus", 0, 1000000), 20);
  assert.equal(M.modelCost("haiku", 1000000, 1000000), 0.1 + 0.5);
  assert.equal(M.modelCost("fable", 1000000, 0), 10);
  assert.equal(M.modelCost("unknown-model", 1000000, 0), 4, "unknown model bills as opus");
  const half = M.modelCost("sonnet", 500000, 500000);
  assert.ok(Math.abs(half - (1 + 5)) < 1e-9, `expected 6, got ${half}`);
});

test("rateKeyFor maps the Haiku sublines onto the Haiku rate", () => {
  assert.equal(M.rateKeyFor("opus"), "opus");
  assert.equal(M.rateKeyFor("explorer"), "haiku");
  assert.equal(M.rateKeyFor("researcher"), "haiku");
});

test("csvCell quotes only when needed and doubles inner quotes", () => {
  assert.equal(M.csvCell("plain"), "plain");
  assert.equal(M.csvCell(42), "42");
  assert.equal(M.csvCell(null), "");
  assert.equal(M.csvCell(undefined), "");
  assert.equal(M.csvCell("a,b"), '"a,b"');
  assert.equal(M.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(M.csvCell("line\nbreak"), '"line\nbreak"');
});

test("summaryToCsv emits a stable header, one row per model, a TOTAL, and the note", () => {
  const summary = {
    disclaimer: "Estimates · not official invoices",
    models: [
      { model: "opus", inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.00044 },
      { model: "haiku", inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.0000011 }
    ],
    totals: { inputTokens: 11, outputTokens: 22, estimatedCostUsd: 0.0004411 }
  };
  const lines = M.summaryToCsv(summary).trim().split("\n");
  assert.equal(lines[0], "model,inputTokens,outputTokens,estimatedCostUsd");
  assert.equal(lines[1], "opus,10,20,0.00044");
  assert.equal(lines[2], "haiku,1,2,0.0000011");
  assert.equal(lines[3], "TOTAL,11,22,0.0004411");
  assert.ok(
    lines.some((l) => l.startsWith("note,")),
    "note row must be present"
  );
  assert.ok(
    M.summaryToCsv(summary).endsWith("\n"),
    "CSV must be newline-terminated for spreadsheets"
  );
});
