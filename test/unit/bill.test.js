/**
 * Unit tests for dashboard/bill.js. Browser IIFE run in a vm sandbox against the real
 * dashboard/bill-math.js, with stub elements and a shared state object, so the usage
 * accumulation, snapshot rules, bill painting, and the daily baseline are covered
 * without a browser.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..", "..", "dashboard");

function makeEl() {
  return { textContent: "", style: {}, className: "", id: "" };
}

function load(overrides) {
  const mathSandbox = { window: {} };
  vm.createContext(mathSandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "bill-math.js"), "utf8"), mathSandbox);
  const billMath = mathSandbox.window.WorkshopBillMath;

  const billEls = {};
  for (const key of ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"]) {
    billEls[key + "In"] = makeEl();
    billEls[key + "Out"] = makeEl();
    billEls[key + "Cost"] = makeEl();
  }
  for (const key of [
    "sessionTotal",
    "allOpus",
    "multiplier",
    "savingsNote",
    "illustrative",
    "shareOpus",
    "shareFable",
    "shareSonnet",
    "shareHaiku"
  ]) {
    billEls[key] = makeEl();
  }

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "bill.js"), "utf8"), sandbox, {
    filename: "bill.js"
  });
  const mod = sandbox.window.WorkshopBill;
  assert.ok(mod, "bill.js must expose window.WorkshopBill");

  const state = { calls: 0, subs: 0, liveSubs: {}, usage: billMath.emptyUsage() };
  const seen = { sparks: [], tokens: [], subs: [], mode: "demo", cards: null };

  const deps = Object.assign(
    {
      state,
      billEls,
      hud: {
        sessionCost: makeEl(),
        tokens: makeEl(),
        subs: makeEl(),
        effort: makeEl()
      },
      advisorCallsEl: makeEl(),
      billMath,
      getMode: () => seen.mode,
      cards: () => seen.cards,
      tipSpark: (role) => seen.sparks.push(role)
    },
    overrides || {}
  );
  mod.init(deps);
  return { mod, state, billEls, seen, billMath, deps };
}

test("render paints every model row and the hud totals", () => {
  const t = load();
  t.state.usage.opus = { in: 1000000, out: 0 };
  t.state.usage.haiku = { in: 0, out: 1000000 };
  t.mod.render();
  assert.equal(t.billEls.opusIn.textContent, "1.0M");
  assert.equal(t.billEls.opusCost.textContent, "$4.00");
  assert.equal(t.billEls.haikuOut.textContent, "1.0M");
  assert.equal(t.billEls.haikuCost.textContent, "$0.50");
  assert.equal(t.billEls.sessionTotal.textContent, "$4.50");
  assert.equal(t.deps.hud.sessionCost.textContent, "$4.50");
  assert.equal(t.deps.hud.tokens.textContent, "1.0M", "hud tokens track the haiku row");
});

test("render shows the all-Opus comparison and the multiplier", () => {
  const t = load();
  /* Everything on Haiku is much cheaper than the same tokens on Opus. */
  t.state.usage.haiku = { in: 1000000, out: 1000000 };
  t.mod.render();
  assert.equal(t.billEls.sessionTotal.textContent, "$0.60");
  assert.equal(t.billEls.allOpus.textContent, "$24.00");
  assert.match(t.billEls.multiplier.textContent, /^~\d/, "a real multiplier is shown");
  assert.match(t.billEls.savingsNote.textContent, /vs all-Opus/);
});

test("render with no usage shows n/a rather than a bogus multiplier", () => {
  const t = load();
  t.mod.render();
  assert.equal(t.billEls.sessionTotal.textContent, "$0.00");
  assert.equal(t.billEls.multiplier.textContent, "n/a");
  assert.match(t.billEls.savingsNote.textContent, /savings vs all-Opus/);
});

test("render splits the cost share across the four billed buckets", () => {
  const t = load();
  t.state.usage.opus = { in: 1000000, out: 0 }; // $4
  t.state.usage.haiku = { in: 0, out: 1000000 }; // $0.50
  t.mod.render();
  const opus = parseFloat(t.billEls.shareOpus.style.width);
  const haiku = parseFloat(t.billEls.shareHaiku.style.width);
  assert.ok(opus > 80 && opus < 90, `opus share should dominate, got ${opus}`);
  assert.ok(Math.abs(opus + haiku - 100) < 0.01, "shares should sum to 100%");
});

test("addUsage accumulates into the model bucket and sparks the station", () => {
  const t = load();
  t.mod.addUsage({ role: "worker", in: 100, out: 50 });
  assert.equal(t.state.usage.sonnet.in, 100);
  assert.equal(t.state.usage.sonnet.out, 50);
  assert.deepEqual(t.seen.sparks, ["worker"]);
});

test("addUsage attributes explorer/researcher to both the model and their own row", () => {
  const t = load();
  t.mod.addUsage({ role: "explorer", in: 10, out: 2 });
  assert.equal(t.state.usage.haiku.in, 10, "billed as Haiku");
  assert.equal(t.state.usage.explorer.in, 10, "and tracked in its own row");
  t.mod.addUsage({ role: "researcher", in: 5, out: 1 });
  assert.equal(t.state.usage.haiku.in, 15);
  assert.equal(t.state.usage.researcher.in, 5);
});

test("a roleless haiku row is attributed to explorer", () => {
  const t = load();
  t.mod.addUsage({ model: "haiku", in: 7, out: 3 });
  assert.equal(t.state.usage.haiku.in, 7);
  assert.equal(t.state.usage.explorer.in, 7, "no role means explorer");
});

test("addUsage ignores empty and zero rows", () => {
  const t = load();
  t.mod.addUsage(null);
  t.mod.addUsage({ role: "worker", in: 0, out: 0 });
  t.mod.addUsage({ role: "worker" });
  assert.equal(t.state.usage.sonnet.in, 0);
  assert.deepEqual(t.seen.sparks, [], "nothing to spark for a zero row");
});

test("sparkRoleFor maps roles and models onto the five stations", () => {
  const t = load();
  assert.equal(t.mod.sparkRoleFor("advisor", "opus"), "advisor");
  assert.equal(t.mod.sparkRoleFor("", "fable"), "advisor");
  assert.equal(t.mod.sparkRoleFor("worker", "opus"), "worker");
  assert.equal(t.mod.sparkRoleFor("", "sonnet"), "worker");
  assert.equal(t.mod.sparkRoleFor("explorer", "haiku"), "explorer");
  assert.equal(t.mod.sparkRoleFor("researcher", "haiku"), "researcher");
  assert.equal(t.mod.sparkRoleFor("parent", "opus"), "opus");
  assert.equal(t.mod.sparkRoleFor("", "unknown"), "opus");
});

test("setUsageSnapshot replaces the table and keeps the Haiku max rule", () => {
  const t = load();
  t.mod.addUsage({ role: "worker", in: 999, out: 999 });
  t.mod.setUsageSnapshot(
    {
      opus: { in: 100, out: 10 },
      explorer: { in: 40, out: 4 },
      researcher: { in: 30, out: 3 },
      haiku: { in: 5, out: 1 }
    },
    "opus"
  );
  assert.equal(t.state.usage.sonnet.in, 0, "the snapshot replaces prior usage");
  assert.equal(t.state.usage.opus.in, 100);
  assert.equal(t.state.usage.haiku.in, 70, "haiku is the max of sublines and explicit");
  assert.equal(t.state.usage.haiku.out, 7);
  assert.deepEqual(
    t.seen.sparks,
    ["worker", "opus"],
    "the snapshot sparks its explicit role (after the earlier addUsage)"
  );
});

test("a null snapshot clears the table", () => {
  const t = load();
  t.state.usage.opus = { in: 500, out: 500 };
  t.mod.setUsageSnapshot(null);
  assert.equal(t.state.usage.opus.in, 0);
});

test("setCalls and setSubs update state and their elements", () => {
  const t = load();
  t.mod.setCalls(3);
  assert.equal(t.state.calls, 3);
  assert.equal(t.deps.advisorCallsEl.textContent, "3");
  t.mod.setSubs(2);
  assert.equal(t.state.subs, 2);
  assert.equal(t.deps.hud.subs.textContent, "2");
});

test("setEffort labels the HUD and defaults to mixed", () => {
  const t = load();
  t.mod.setEffort("high");
  assert.equal(t.deps.hud.effort.textContent, "high");
  t.mod.setEffort("");
  assert.equal(t.deps.hud.effort.textContent, "mixed");
});

test("demo daily tokens accrue from the usage delta, not the absolute total", () => {
  const t = load();
  const added = [];
  t.seen.cards = {
    addTokens: (n) => added.push(n),
    syncLiveSubs: () => {}
  };
  t.mod.addUsage({ role: "worker", in: 1000, out: 0 });
  assert.deepEqual(added, [1000], "first row adds its own delta");
  t.mod.addUsage({ role: "worker", in: 500, out: 0 });
  assert.deepEqual(added, [1000, 500], "second row adds only the new tokens");
});

test("live mode routes tokens per station and syncs subs instead of the demo total", () => {
  const t = load();
  const tokens = [];
  const subs = [];
  t.seen.mode = "live";
  t.seen.cards = {
    addTokens: (n, role) => tokens.push([n, role]),
    syncLiveSubs: (n) => subs.push(n)
  };
  t.mod.addUsage({ role: "advisor", in: 10, out: 5 });
  assert.deepEqual(tokens, [[15, "advisor"]], "live tokens are role-attributed");
  t.mod.setSubs(4);
  assert.deepEqual(subs, [4], "live sub count is pushed to the cards module");
});

test("resetUsage zeroes the table and repaints", () => {
  const t = load();
  t.state.usage.opus = { in: 1000, out: 1000 };
  t.mod.resetUsage();
  assert.equal(t.state.usage.opus.in, 0);
  assert.equal(t.billEls.opusCost.textContent, "$0.00");
  assert.equal(t.billEls.sessionTotal.textContent, "$0.00");
});

test("resetDemoTotal re-baselines so the next sync reports the accumulated total", () => {
  const t = load();
  const added = [];
  t.seen.cards = { addTokens: (n) => added.push(n), syncLiveSubs: () => {} };
  t.mod.addUsage({ role: "worker", in: 1000, out: 0 });
  assert.deepEqual(added, [1000]);
  /* Re-baselining alone makes the next sync treat the whole accumulated table as the
     delta. Callers that also zero the table (setMode -> resetUsage) are unaffected. */
  t.mod.resetDemoTotal();
  t.mod.addUsage({ role: "worker", in: 250, out: 0 });
  assert.deepEqual(added, [1000, 1250], "the accumulated total becomes the next delta");
  assert.equal(t.state.usage.sonnet.in, 1250, "usage itself is untouched");
});

test("replaceUsage swaps the table and re-baselines the daily counter", () => {
  const t = load();
  const math = t.billMath;
  const next = math.emptyUsage();
  next.opus = { in: 2000, out: 0 };
  const added = [];
  t.seen.cards = { addTokens: (n) => added.push(n), syncLiveSubs: () => {} };
  t.mod.replaceUsage(next);
  assert.equal(t.state.usage.opus.in, 2000, "table swapped in");
  assert.deepEqual(added, [2000], "daily baseline re-derived from scratch");
});
