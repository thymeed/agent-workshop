/**
 * Pins the Insights price table (dashboard/insights.js). Insights is a browser IIFE, so it is
 * loaded in a vm sandbox with the one global it reads at load time.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "insights.js");
const sandbox = { SafeHtml: { escapeHtml: (s) => String(s) } };
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
const { CONFIG, analyze } = sandbox.Insights;

test("Insights prices Fable at $8 in / $40 out per 1M tokens", () => {
  assert.equal(CONFIG.prices.fable.in, 8);
  assert.equal(CONFIG.prices.fable.out, 40);
  assert.equal(analyze.costFor("fable", 1e6, 0), 8);
  assert.equal(analyze.costFor("fable", 0, 1e6), 40);
});

test("the other Insights rates are unchanged", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CONFIG.prices)), {
    opus: { in: 4, out: 20 },
    fable: { in: 8, out: 40 },
    sonnet: { in: 2, out: 10 },
    haiku: { in: 0.1, out: 0.5 },
    auto: { in: 1, out: 5 }
  });
});

test("every Insights rate matches the Bill's rate table", () => {
  const BILL = path.resolve(__dirname, "..", "..", "dashboard", "bill-math.js");
  const bill = { window: {} };
  vm.runInNewContext(fs.readFileSync(BILL, "utf8"), bill, { filename: BILL });
  const rates = bill.window.WorkshopBillMath.RATES;
  for (const m of ["opus", "fable", "sonnet", "haiku"]) {
    assert.equal(CONFIG.prices[m].in, rates[m].in, m + " in");
    assert.equal(CONFIG.prices[m].out, rates[m].out, m + " out");
  }
});
