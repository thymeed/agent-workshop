/**
 * Claude Code live pricing in Insights (dashboard/insights.js): the per-agent ledger built
 * straight from the wire's usage rows, and the agent-based suggestion / what-if functions.
 * Insights and bill-math run in one vm sandbox (Insights reads WorkshopBillMath lazily);
 * the Bill side runs the real dashboard/bill.js addUsage, the call app.js makes per row.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const DASH = path.resolve(__dirname, "..", "..", "dashboard");
const FIXTURES = path.resolve(__dirname, "..", "fixtures");

function loadInsights(withBill) {
  const sb = { SafeHtml: { escapeHtml: (s) => String(s) } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(DASH, "insights.js"), "utf8"), sb, {
    filename: "insights.js"
  });
  if (withBill) {
    vm.runInContext(fs.readFileSync(path.join(DASH, "bill-math.js"), "utf8"), sb, {
      filename: "bill-math.js"
    });
  }
  return { analyze: sb.Insights.analyze, billMath: sb.WorkshopBillMath };
}

const { analyze: A, billMath: BM } = loadInsights(true);

/** The Bill path: real bill.js addUsage fed the way app.js feeds it, then sessionCostTotal. */
function billTotal(rows) {
  const mathSb = { window: {} };
  vm.createContext(mathSb);
  vm.runInContext(fs.readFileSync(path.join(DASH, "bill-math.js"), "utf8"), mathSb);
  const billMath = mathSb.window.WorkshopBillMath;
  const sb = { window: {} };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(DASH, "bill.js"), "utf8"), sb);
  const bill = sb.window.WorkshopBill;
  const el = () => ({ textContent: "", style: {}, className: "", id: "" });
  const billEls = new Proxy({}, { get: (o, k) => o[k] || (o[k] = el()) });
  const state = { calls: 0, subs: 0, liveSubs: {}, usage: billMath.emptyUsage() };
  bill.init({
    state,
    billEls,
    hud: { sessionCost: el(), tokens: el(), subs: el(), effort: el() },
    advisorCallsEl: el(),
    billMath,
    getMode: () => "demo",
    cards: () => null,
    tipSpark: () => {}
  });
  for (const ev of rows) {
    const role = ev.role || "parent";
    if (ev.usage) {
      bill.addUsage(
        { model: ev.usage.model, role: ev.usage.role || role, in: ev.usage.in, out: ev.usage.out },
        { skipDaily: true }
      );
    }
  }
  return { total: billMath.sessionCostTotal(state.usage), usage: state.usage };
}

/** A wire event row (lib/claude-code-wire.js eventFromRow shape, path-free). */
function row(source, role, usage, extra) {
  return Object.assign(
    {
      iso: "2026-11-01T10:00:00.000Z",
      role,
      kind: "status",
      type: "turn",
      message: "turn",
      usage: usage
        ? Object.assign({ cacheRead: 0, cacheWrite: 0, role: usage.role || role }, usage)
        : null,
      activity: null,
      source
    },
    extra || {}
  );
}

function ledgerOf(rows) {
  const l = A.createLiveLedger();
  rows.forEach((r) => l.add(r));
  return l;
}

/** vm objects come from another realm: compare their JSON form. */
const plain = (x) => JSON.parse(JSON.stringify(x));
const byId = (agents) => Object.fromEntries(agents.map((a) => [a.agentId, a]));

test("agents off their role default are priced at their real models", () => {
  const rows = [
    row("session", "parent", { model: "sonnet", in: 1000, out: 200 }),
    row("subagent:1", "worker", { model: "haiku", in: 3000, out: 400 }),
    row("subagent:2", "explorer", { model: "opus", in: 500, out: 50 })
  ];
  const agents = ledgerOf(rows).agents();
  assert.equal(agents.length, 3);
  const a = byId(agents);
  assert.deepEqual(Object.keys(a), [
    "live-session-sonnet",
    "live-subagent-1-haiku",
    "live-subagent-2-opus"
  ]);
  const lead = a["live-session-sonnet"];
  assert.equal(lead.name, "Lead");
  assert.equal(lead.parentId, null);
  assert.equal(lead.role, "parent");
  assert.equal(lead.model, "sonnet");
  assert.equal(lead.cost, BM.modelCost("sonnet", 1000, 200));
  const worker = a["live-subagent-1-haiku"];
  assert.equal(worker.name, "Worker 1");
  assert.equal(worker.parentId, "live-session");
  assert.equal(worker.model, "haiku");
  assert.equal(worker.cost, BM.modelCost("haiku", 3000, 400));
  const res = a["live-subagent-2-opus"];
  assert.equal(res.name, "Researcher 2");
  assert.equal(res.role, "explorer");
  assert.equal(res.cost, BM.modelCost("opus", 500, 50));
  const m = ledgerOf(rows).byModel();
  assert.deepEqual(
    { opus: m.opus.in, sonnet: m.sonnet.in, haiku: m.haiku.in, fable: m.fable.in },
    { opus: 500, sonnet: 1000, haiku: 3000, fable: 0 }
  );
});

test("a subagent that switches model gets one row per model at its own rate", () => {
  const agents = ledgerOf([
    row("subagent:3", "worker", { model: "sonnet", in: 100, out: 10 }),
    row("subagent:3", "worker", { model: "haiku", in: 200, out: 20 }),
    row("subagent:3", "worker", { model: "sonnet", in: 50, out: 5 })
  ]).agents();
  assert.equal(agents.length, 2);
  const a = byId(agents);
  const s = a["live-subagent-3-sonnet"];
  const h = a["live-subagent-3-haiku"];
  assert.equal(s.name, "Worker 3 · Sonnet");
  assert.equal(h.name, "Worker 3 · Haiku");
  assert.equal(s.inputTokens, 150);
  assert.equal(s.outputTokens, 15);
  assert.equal(s.cost, BM.modelCost("sonnet", 150, 15));
  assert.equal(h.cost, BM.modelCost("haiku", 200, 20));
  assert.equal(s.sourceKey, h.sourceKey);
});

test("a parent spawn row's usage stays on the parent; totals equal the Bill exactly", () => {
  const rows = [
    row("session", "parent", { model: "opus", in: 1234, out: 321 }),
    row(
      "session",
      "parent",
      { model: "opus", in: 777, out: 99 },
      { type: "spawn", kind: "delegates", childRole: "worker" }
    ),
    row("subagent:1", "worker", null, { type: "spawn", kind: "delegates" }),
    row("subagent:1", "worker", { model: "sonnet", in: 4567, out: 890 }),
    row("subagent:1", "worker", { model: "sonnet", in: 11, out: 7, cacheRead: 99999 }),
    row("session", "worker", null, { type: "done", subagentTokens: 987654 })
  ];
  const ledger = ledgerOf(rows);
  const agents = ledger.agents();
  const a = byId(agents);
  assert.equal(agents.length, 2);
  assert.equal(a["live-session-opus"].inputTokens, 1234 + 777);
  assert.equal(a["live-session-opus"].outputTokens, 321 + 99);
  assert.equal(a["live-subagent-1-sonnet"].inputTokens, 4567 + 11);
  assert.equal(a["live-subagent-1-sonnet"].outputTokens, 890 + 7);

  const bill = billTotal(rows);
  const byModel = ledger.byModel();
  for (const k of ["opus", "fable", "sonnet", "haiku"]) {
    const sumIn = agents.filter((x) => x.model === k).reduce((n, x) => n + x.inputTokens, 0);
    const sumOut = agents.filter((x) => x.model === k).reduce((n, x) => n + x.outputTokens, 0);
    assert.equal(sumIn, bill.usage[k].in, k + " in: agents sum === Bill");
    assert.equal(sumOut, bill.usage[k].out, k + " out: agents sum === Bill");
    assert.equal(byModel[k].in, bill.usage[k].in, k + " byModel in === Bill");
    assert.equal(byModel[k].out, bill.usage[k].out, k + " byModel out === Bill");
  }
  const asRun = A.bucketsCost(byModel);
  assert.ok(bill.total > 0);
  assert.equal(asRun, bill.total, "As run === Bill sessionCostTotal");
  const whatIf = A.whatIfFromAgents(agents, asRun, { allowAuto: false, billOrder: true });
  assert.equal(whatIf.find((s) => s.id === "actual").cost, bill.total);
});

test("rows without usage add nothing; done rows with subagentTokens add $0", () => {
  const ledger = ledgerOf([
    row("subagent:1", "worker", null, { type: "spawn", kind: "delegates" }),
    row("session", "worker", null, { type: "done", subagentTokens: 500000 }),
    row("session", "worker", null, { type: "error", subagentTokens: 1000 }),
    row("session", "parent", null, { kind: "message", message: "task / turn" }),
    row("session", "parent", { model: "opus", in: 0, out: 0, cacheRead: 5000, cacheWrite: 10 }),
    row("subagent:2", "worker", { model: "", in: 0, out: 0 })
  ]);
  assert.deepEqual(plain(ledger.agents()), []);
  const m = ledger.byModel();
  for (const k of Object.keys(m)) {
    assert.equal(m[k].in + m[k].out, 0, k);
    assert.equal(m[k].cost, 0, k);
  }
  assert.equal(A.bucketsCost(m), 0);
});

test("an unknown, missing or malformed source is the parent", () => {
  const bad = [undefined, null, 7, "", "subagent:abc", "subagent:1234567", "../x", "session "];
  const ledger = ledgerOf(
    bad.map((source) => row(source, "worker", { model: "haiku", in: 10, out: 1 }))
  );
  const agents = ledger.agents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentId, "live-session-haiku");
  assert.equal(agents[0].parentId, null);
  assert.equal(agents[0].name, "Lead");
  assert.equal(agents[0].inputTokens, 10 * bad.length);
  const ok = ledgerOf([row("subagent:123456", "worker", { model: "haiku", in: 1, out: 1 })]);
  assert.equal(ok.agents()[0].agentId, "live-subagent-123456-haiku");
});

test("a usage row without a model family is priced at the role default, like the Bill", () => {
  const rows = [row("subagent:1", "worker", { model: "", in: 100, out: 10 })];
  const a = ledgerOf(rows).agents();
  assert.equal(a[0].model, BM.normalizeModel("", "worker"));
  assert.equal(a[0].model, "sonnet");
  assert.equal(A.bucketsCost(ledgerOf(rows).byModel()), billTotal(rows).total);
});

test("ids and names never carry raw model strings; agents carry no paths", () => {
  const rows = [
    row(
      "subagent:4",
      "worker",
      { model: "a/../b", in: 10, out: 1 },
      {
        agentId: "child-raw-id",
        activity: { kind: "read", path: "src/proj-demo/a.js", detail: "" }
      }
    ),
    row("subagent:4", "worker", null, {
      activity: { kind: "read", path: "src/proj-demo/b.js", detail: "" }
    }),
    row("subagent:4", "worker", null, {
      activity: { kind: "read", path: "src/proj-demo/a.js", detail: "" }
    }),
    row("subagent:4", "worker", null, {
      activity: { kind: "edit", path: "__proto__", detail: "" }
    }),
    row("subagent:4", "worker", null, {
      activity: { kind: "edit", path: "__proto__", detail: "" }
    })
  ];
  const agents = ledgerOf(rows).agents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentId, "live-subagent-4-sonnet");
  assert.equal(agents[0].fileCount, 3, "distinct paths, counted once each");
  const json = JSON.stringify(agents);
  for (const bad of ["../", "a/", "proj-demo", ".js", "__proto__", "child-raw-id"]) {
    assert.ok(!json.includes(bad), "agents() must not carry " + bad);
  }
  assert.ok(!("files" in agents[0]));
});

test("the per-source file count is capped at 500 and clear() forgets everything", () => {
  const ledger = A.createLiveLedger();
  ledger.add(row("subagent:1", "worker", { model: "haiku", in: 1, out: 1 }));
  for (let i = 0; i < 499; i++) {
    ledger.add(row("subagent:1", "worker", null, { activity: { kind: "read", path: "f" + i } }));
  }
  assert.equal(ledger.agents()[0].fileCount, 499);
  ledger.add(row("subagent:1", "worker", null, { activity: { kind: "read", path: "f499" } }));
  assert.equal(ledger.agents()[0].fileCount, 500);
  ledger.add(row("subagent:1", "worker", null, { activity: { kind: "read", path: "f500" } }));
  assert.equal(ledger.agents()[0].fileCount, 500, "one past the cap");
  ledger.clear();
  assert.deepEqual(plain(ledger.agents()), []);
  assert.equal(A.bucketsCost(ledger.byModel()), 0);
});

test("no suggestions: Apply suggestions === As run === Bill over many sub-cent rows", () => {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    rows.push(row("session", "parent", { model: "sonnet", in: 37 + (i % 7), out: 900 + i }));
    rows.push(row("subagent:1", "worker", { model: "haiku", in: 13 + (i % 5), out: 3 }));
    rows.push(row("subagent:2", "researcher", { model: "sonnet", in: 3, out: 1700 }));
  }
  const ledger = ledgerOf(rows);
  const agents = ledger.agents();
  assert.deepEqual(plain(A.suggestionsFromAgents(agents, { allowAuto: false })), []);
  const asRun = A.bucketsCost(ledger.byModel());
  const bill = billTotal(rows).total;
  assert.equal(asRun, bill);
  const w = A.whatIfFromAgents(agents, asRun, { allowAuto: false, billOrder: true });
  assert.equal(w.find((s) => s.id === "suggested").cost, asRun);
  assert.equal(w.find((s) => s.id === "actual").cost, asRun);
  assert.equal(BM.formatMoney(w.find((s) => s.id === "suggested").cost), BM.formatMoney(bill));
});

test("no suggestions: Apply suggestions === As run even where the sum order changes the float", () => {
  /* Chosen so a per-agent sum and a reversed bucket order both differ from the Bill's sum. */
  const rows = [
    row("session", "parent", { model: "sonnet", in: 481, out: 913 }),
    row("subagent:1", "worker", { model: "haiku", in: 26, out: 5 }),
    row("subagent:2", "researcher", { model: "sonnet", in: 6, out: 1791 }),
    row("subagent:3", "worker", { model: "opus", in: 13013, out: 12013 })
  ];
  const ledger = ledgerOf(rows);
  const agents = ledger.agents();
  assert.deepEqual(plain(A.suggestionsFromAgents(agents, { allowAuto: false })), []);
  const bill = billTotal(rows).total;
  const perAgent = agents.reduce((t, a) => t + a.cost, 0);
  assert.notEqual(perAgent, bill, "the data must make the sum order matter");
  const asRun = A.bucketsCost(ledger.byModel());
  assert.equal(asRun, bill);
  const w = A.whatIfFromAgents(agents, asRun, { allowAuto: false, billOrder: true });
  assert.equal(w.find((s) => s.id === "suggested").cost, asRun);
});

test("each row under one cent still sums to the Bill exactly", () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    const src = i % 3 === 0 ? "session" : "subagent:" + (i % 4);
    rows.push(row(src, "worker", { model: ["opus", "haiku", "sonnet"][i % 3], in: 7, out: 3 }));
  }
  assert.ok(BM.modelCost("opus", 7, 3) < 0.01);
  assert.equal(A.bucketsCost(ledgerOf(rows).byModel()), billTotal(rows).total);
});

test("allowAuto false: no Auto suggestion and no All Auto scenario", () => {
  const rows = [
    row("session", "parent", { model: "opus", in: 2000, out: 500 }),
    row("subagent:1", "worker", { model: "opus", in: 3000, out: 900 })
  ];
  const agents = ledgerOf(rows).agents();

  const withAuto = A.suggestionsFromAgents(agents);
  assert.ok(
    withAuto.some((s) => s.suggestion === "auto"),
    "the same agents get an Auto suggestion when Auto is allowed"
  );
  const noAuto = A.suggestionsFromAgents(agents, { allowAuto: false });
  assert.ok(!noAuto.some((s) => s.suggestion === "auto"));
  assert.ok(!noAuto.some((s) => /auto/i.test(s.reason)));

  const ids = (opts) => plain(A.whatIfFromAgents(agents, 1, opts).map((s) => s.id));
  assert.deepEqual(ids(), ["actual", "all-auto", "all-haiku", "cheap-children", "suggested"]);
  assert.deepEqual(ids({ allowAuto: false }), [
    "actual",
    "all-haiku",
    "cheap-children",
    "suggested"
  ]);
  const cheap = A.whatIfFromAgents(agents, 1, { allowAuto: false }).find(
    (s) => s.id === "cheap-children"
  );
  assert.equal(cheap.label, "Lead as run (Opus) · children Haiku");
});

/* ---- "Lead as run · children Haiku": the Lead keeps its real model(s), children go Haiku ---- */

/** Bill-order sum of { model: {in, out} } computed here, not through Insights. */
function billOrderSum(buckets) {
  return ["opus", "fable", "sonnet", "haiku"].reduce(
    (s, k) => (buckets[k] ? s + BM.modelCost(k, buckets[k].in, buckets[k].out) : s),
    0
  );
}
function addTo(buckets, k, inn, out) {
  const t = buckets[k] || (buckets[k] = { in: 0, out: 0 });
  t.in += inn;
  t.out += out;
}
const cheapOf = (agents, actual) =>
  A.whatIfFromAgents(agents, actual, { allowAuto: false, billOrder: true }).find(
    (s) => s.id === "cheap-children"
  );

test("children Haiku: a Sonnet Lead stays Sonnet; scenario = As run minus the children's savings", () => {
  const lead = { in: 48213, out: 9127 };
  const kids = [
    ["subagent:1", "worker", "opus", 30711, 8123],
    ["subagent:2", "researcher", "sonnet", 12345, 6789],
    ["subagent:3", "worker", "opus", 701, 99]
  ];
  const rows = [row("session", "parent", { model: "sonnet", in: lead.in, out: lead.out })];
  kids.forEach(([src, role, model, i, o]) => rows.push(row(src, role, { model, in: i, out: o })));
  const ledger = ledgerOf(rows);
  const agents = ledger.agents();
  const asRun = A.bucketsCost(ledger.byModel());
  assert.equal(asRun, billTotal(rows).total, "As run === Bill");
  const cheap = cheapOf(agents, asRun);
  assert.equal(cheap.label, "Lead as run (Sonnet) · children Haiku");

  /* Independent: the children's as-run cost minus the same tokens at Haiku. */
  const kidsAsRun = kids.reduce((s, k) => s + BM.modelCost(k[2], k[3], k[4]), 0);
  const kidsAtHaiku = kids.reduce((s, k) => s + BM.modelCost("haiku", k[3], k[4]), 0);
  const savings = kidsAsRun - kidsAtHaiku;
  assert.ok(savings > 0);
  /* As run - savings is a different float order than the Bill-order sum of the remapped
     buckets, so it is equal to the last bits only, and equal as rendered. */
  assert.ok(Math.abs(cheap.cost - (asRun - savings)) < 1e-12);
  assert.equal(BM.formatMoney(cheap.cost), BM.formatMoney(asRun - savings));
  /* Exact, in the same order: Lead buckets + every child's tokens in Haiku, Bill order. */
  const b = {};
  addTo(b, "sonnet", lead.in, lead.out);
  kids.forEach((k) => addTo(b, "haiku", k[3], k[4]));
  assert.equal(cheap.cost, billOrderSum(b));
  assert.ok(cheap.cost < asRun);
  /* The old rule priced the Lead at Opus: the scenario would have cost more than this. */
  const old = {};
  addTo(old, "opus", lead.in, lead.out);
  kids.forEach((k) => addTo(old, "haiku", k[3], k[4]));
  assert.ok(billOrderSum(old) > cheap.cost);
});

test("children Haiku: children already on Haiku save nothing, scenario === As run", () => {
  const rows = [
    row("session", "parent", { model: "sonnet", in: 9001, out: 777 }),
    row("subagent:1", "worker", { model: "haiku", in: 31337, out: 4242 }),
    row("subagent:2", "explorer", { model: "haiku", in: 13, out: 7 })
  ];
  const ledger = ledgerOf(rows);
  const asRun = A.bucketsCost(ledger.byModel());
  const cheap = cheapOf(ledger.agents(), asRun);
  assert.equal(cheap.cost, asRun);
  assert.equal(cheap.cost, billTotal(rows).total);
  assert.equal(cheap.label, "Lead as run (Sonnet) · children Haiku");
});

test("children Haiku: a Lead with two model rows is named without a model", () => {
  const rows = [
    row("session", "parent", { model: "sonnet", in: 5000, out: 500 }),
    row("session", "parent", { model: "opus", in: 4000, out: 400 }),
    row("subagent:1", "worker", { model: "opus", in: 3000, out: 300 })
  ];
  const ledger = ledgerOf(rows);
  const agents = ledger.agents();
  assert.equal(agents.filter((a) => a.parentId === null).length, 2);
  const asRun = A.bucketsCost(ledger.byModel());
  const cheap = cheapOf(agents, asRun);
  assert.equal(cheap.label, "Lead as run · children Haiku");
  const b = {};
  addTo(b, "sonnet", 5000, 500);
  addTo(b, "opus", 4000, 400);
  addTo(b, "haiku", 3000, 300);
  assert.equal(cheap.cost, billOrderSum(b), "each Lead row keeps its own model");
});

test("children Haiku on the event path (Demo, Cursor): the Lead keeps its real model", () => {
  const ev = (agentId, parentId, model, inn, out) => ({
    ts: "2026-10-09T14:00:00.000Z",
    sessionId: "s",
    agentId,
    parentId,
    name: agentId,
    model,
    type: "turn",
    inputTokens: inn,
    outputTokens: out,
    files: []
  });
  const cheap = (events) => A.whatIfScenarios(events).find((s) => s.id === "cheap-children");
  const kid = ev("kid", "lead", "opus", 20000, 3000);

  const sonnetLead = cheap([ev("lead", null, "sonnet", 10000, 2000), kid]);
  assert.equal(sonnetLead.label, "Lead as run (Sonnet) · children Haiku");
  assert.equal(
    sonnetLead.cost,
    A.costFor("sonnet", 10000, 2000) + A.costFor("haiku", 20000, 3000),
    "Lead at Sonnet, not Opus"
  );

  const autoLead = cheap([ev("lead", null, "auto", 10000, 2000), kid]);
  assert.equal(autoLead.label, "Lead as run · children Haiku", "Auto is not one model");
  assert.equal(autoLead.cost, A.costFor("auto", 10000, 2000) + A.costFor("haiku", 20000, 3000));

  const twoLeads = cheap([
    ev("lead", null, "sonnet", 10000, 2000),
    ev("lead-2", null, "opus", 100, 20),
    kid
  ]);
  assert.equal(twoLeads.label, "Lead as run · children Haiku");

  /* A Lead with no tokens names nothing; a scenario is never hidden. */
  const idle = A.whatIfScenarios([ev("lead", null, "opus", 0, 0), kid]);
  assert.equal(idle.find((s) => s.id === "cheap-children").label, "Lead as run · children Haiku");
});

test("money renders like the Bill: three decimals below a cent, with or without bill-math", () => {
  const values = [0.0001, 0.00049, 0.0005, 0.0012, 0.00444, 0.0049999, 0.005, 0.0099, 0.00999];
  values.push(0, 0.01, 0.0123, 1.5, 123.456, -3);
  const { analyze: noBill } = loadInsights(false);
  for (const v of values) {
    assert.equal(A.formatMoney(v), BM.formatMoney(v), "with bill-math: " + v);
    assert.equal(noBill.formatMoney(v), BM.formatMoney(v), "local rule: " + v);
  }
  assert.equal(A.formatMoney(0.0012), "$0.001");
  assert.equal(noBill.formatMoney(0.0049999), "$0.005");
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(A.formatMoney(bad), "$n/a");
    assert.equal(noBill.formatMoney(bad), "$n/a");
  }
  /* Store and sum at full precision, round once: 9 rows of $0.0004 render as $0.004. */
  const sum = Array.from({ length: 9 }, () => 0.0004).reduce((s, x) => s + x, 0);
  assert.equal(A.formatMoney(sum), BM.formatMoney(sum));
  assert.equal(A.formatMoney(sum), "$0.004");
});

test("live suggestions carry the agent's wire role for the stage jump", () => {
  const rows = [
    row("subagent:2", "explorer", { model: "opus", in: 30000, out: 100 }),
    row("subagent:2", "explorer", null, { activity: { kind: "read", path: "a.js" } })
  ];
  const s = A.suggestionsFromAgents(ledgerOf(rows).agents(), { allowAuto: false });
  assert.equal(s.length, 1);
  assert.equal(s[0].role, "explorer");
  assert.equal(s[0].agentId, "live-subagent-2-opus");
});

test("allowAuto false keeps a read-heavy Opus child's Haiku suggestion without naming Auto", () => {
  const rows = [
    row("subagent:1", "worker", { model: "opus", in: 30000, out: 100 }),
    row("subagent:1", "worker", null, { activity: { kind: "read", path: "a.js" } })
  ];
  const s = A.suggestionsFromAgents(ledgerOf(rows).agents(), { allowAuto: false });
  assert.equal(s.length, 1);
  assert.equal(s[0].suggestion, "haiku");
  assert.equal(s[0].reason, "Child agent mostly reading. Haiku instead of Opus.");
});

test("Auto allowed (Cursor and Demo default) keeps the read-heavy Opus child's original reason", () => {
  const rows = [
    row("subagent:1", "worker", { model: "opus", in: 30000, out: 100 }),
    row("subagent:1", "worker", null, { activity: { kind: "read", path: "a.js" } })
  ];
  const s = A.suggestionsFromAgents(ledgerOf(rows).agents());
  assert.equal(s.length, 1);
  assert.equal(s[0].suggestion, "haiku");
  assert.equal(s[0].reason, "Child agent mostly reading. Haiku or Auto instead of Opus.");
});

test("event path output on the demo fixture is unchanged by the refactor", () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "insights-agent-baseline.json"), "utf8")
  );
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "history-demo.json"), "utf8"));
  const events = fixture.events || fixture;
  for (const [key, withBill] of [
    ["nobill", false],
    ["bill", true]
  ]) {
    const { analyze } = loadInsights(withBill);
    const now = JSON.parse(
      JSON.stringify({
        suggestions: analyze.routingSuggestions(events),
        whatIf: analyze.whatIfScenarios(events)
      })
    );
    assert.deepEqual(now, baseline[key], key);
  }
  assert.ok(baseline.bill.suggestions.length > 0, "baseline exercises suggestions");
});
