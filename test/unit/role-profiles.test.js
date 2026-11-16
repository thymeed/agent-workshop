/**
 * Direct unit tests for dashboard/role-profiles.js and the profile-aware parts of
 * dashboard/cards.js (roleFromAgentHint). Both are browser scripts, so they are loaded
 * here in vm sandboxes with a stub `window` - no browser, no DOM. The page-level check
 * (names on the real cards, apply round trip) lives in test/dashboard-units.test.js.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..", "..");
const PROFILES_SRC = path.join(ROOT, "dashboard", "role-profiles.js");
const MATH_SRC = path.join(ROOT, "dashboard", "bill-math.js");
const CARDS_SRC = path.join(ROOT, "dashboard", "cards.js");
const { PARSER_ROLE_TO_SLOT } = require(path.join(ROOT, "lib", "claude-code-slots.js"));

const SLOTS = ["opus", "advisor", "worker", "explorer", "researcher"];

// ---- Literal copies of the Cursor look at master 2840d93 (cards.js ROLE_CARD_TIPS and
// CHIP_TIPS; static strings in model-routing-dashboard.html). Do not edit to match code.
const HEAD_CARD_TIPS = {
  opus: {
    name: "Opus",
    nameDetail: "Main session lead (Cursor Agents parent)",
    role: "Main session",
    roleDetail: "Parent agent that routes work and delegates to subagents",
    effort: "Effort · high",
    effortDetail: "Opus usually runs a high-effort band",
    price: "Opus rates",
    priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
  },
  advisor: {
    name: "Fable",
    nameDetail: "Advisor subagent (Fable)",
    role: "Advisor",
    roleDetail: "Review at plan, repeated errors, and before done",
    effort: "Effort · high",
    effortDetail: "Advisor reviews run a high-effort band",
    price: "Fable rates",
    priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
    calls: "Advisor calls",
    callsDetail: "How many times Fable has been asked this session",
    last: "Last advice",
    lastDetail: "Most recent tip from Fable"
  },
  worker: {
    name: "Worker",
    nameDetail: "Worker subagent (Sonnet)",
    role: "Sonnet · edits",
    roleDetail: "Edits, tests, and fixes in the repo",
    effort: "Effort · medium",
    effortDetail: "Worker usually runs a medium-effort band",
    price: "Sonnet rates",
    priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
  },
  explorer: {
    name: "Explorer",
    nameDetail: "Explorer subagent (Haiku)",
    role: "Haiku · search",
    roleDetail: "Read-only search and repo mapping",
    effort: "Effort · low",
    effortDetail: "Explorer keeps it light and fast",
    price: "Haiku rates",
    priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
    scout: "Scout mode",
    scoutDetail: "Read-only explore. No edits from this station."
  },
  researcher: {
    name: "Researcher",
    nameDetail: "Researcher subagent (Haiku)",
    role: "Haiku · docs",
    roleDetail: "Read-only research and doc lookup",
    effort: "Effort · low",
    effortDetail: "Researcher keeps it light and fast",
    price: "Haiku rates",
    priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
    scout: "Scout mode",
    scoutDetail: "Read-only research. No edits from this station."
  }
};
const HEAD_CHIP_TIPS = [
  {
    tip: "Before plan",
    detail: "Fable reviews the approach before the big plan"
  },
  {
    tip: "Same error ×2",
    detail: "Fable jumps in when the same failure loops"
  },
  {
    tip: "Before done",
    detail: "Fable does a final pass before ship"
  }
];
const HEAD_STATIONS = {
  opus: "Parent agent: plans, reviews, and ships work",
  advisor: "Warm advisor · peeks before plan, same-error ×2, and before done",
  worker: "Build buddy · edits, tests, and crate drops to merge",
  explorer: "Tiny scout · read-only search across the shelves",
  researcher: "Library buddy · read-only docs and references"
};
const HEAD_PILLS = {
  opus: {
    text: "opus plans",
    tip: "Opus plans",
    detail: "Main session · plans, reviews, and ships"
  },
  sonnet: {
    text: "sonnet edits",
    tip: "Sonnet edits",
    detail: "Worker lane · code changes and tests"
  },
  haiku: {
    text: "haiku reads",
    tip: "Haiku reads",
    detail: "Explorer + researcher · fast read-only scouts"
  },
  advisor: {
    text: "advisor reviews",
    tip: "Advisor reviews",
    detail: "Fable · checks before plan, same-error ×2, and before done"
  }
};
const HEAD_FLOWS = {
  asks: "Opus pings Fable for a second look before big moves",
  delegates: "Work flows to Sonnet / Haiku, then into the merge portal"
};
const HEAD_PRICES = {
  opus: ["$4.00 / $20.00", "per 1M in/out"],
  advisor: ["$10.00 / $50.00", "per 1M in/out"],
  worker: ["$2.00 / $10.00", "per 1M in/out"],
  explorer: ["$0.10 / $0.50", "per 1M in/out"],
  researcher: ["$0.10 / $0.50", "per 1M in/out"]
};

/** Copy out of the vm realm so deepStrictEqual does not trip on foreign prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadProfiles() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MATH_SRC, "utf8"), sandbox, { filename: MATH_SRC });
  vm.runInContext(fs.readFileSync(PROFILES_SRC, "utf8"), sandbox, { filename: PROFILES_SRC });
  assert.ok(sandbox.window.RoleProfiles, "role-profiles.js must expose window.RoleProfiles");
  return sandbox.window.RoleProfiles;
}

/** cards.js with a stub SafeHtml and the RoleProfiles instance it reads at call time. */
function loadCards(RP) {
  const sandbox = {
    window: { SafeHtml: { escapeHtml: (s) => String(s) }, RoleProfiles: RP }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CARDS_SRC, "utf8"), sandbox, { filename: CARDS_SRC });
  assert.ok(sandbox.window.AgentCards, "cards.js must expose window.AgentCards");
  return sandbox.window.AgentCards;
}

test("exposes get, apply, current and tables", () => {
  const RP = loadProfiles();
  for (const key of ["get", "apply", "current", "tables"]) {
    assert.equal(typeof RP[key], "function", `missing export: ${key}`);
  }
});

test("cursor is the default and the label table is pinned", () => {
  const RP = loadProfiles();
  assert.equal(RP.current().id, "cursor");
  assert.deepEqual(
    { ...RP.tables().labels },
    {
      opus: "Opus",
      advisor: "Fable",
      worker: "Sonnet",
      explorer: "Explore",
      researcher: "Research"
    }
  );
});

test("claude-code label table is pinned (owner slot map)", () => {
  const RP = loadProfiles();
  assert.ok(RP.apply("claude-code"));
  assert.deepEqual(
    { ...RP.tables().labels },
    {
      opus: "Lead",
      advisor: "Planner",
      worker: "Worker",
      explorer: "Researcher",
      researcher: "Reviewer"
    }
  );
  RP.apply("cursor");
});

test("model table: cursor pins the model names, claude-code shows no fixed model", () => {
  const RP = loadProfiles();
  assert.deepEqual(
    { ...RP.tables().models },
    {
      opus: "Opus",
      advisor: "Fable",
      worker: "Sonnet",
      explorer: "Haiku",
      researcher: "Haiku"
    }
  );
  RP.apply("claude-code");
  for (const slot of SLOTS) {
    assert.equal(RP.tables().models[slot], "", `claude-code model text for ${slot} must be empty`);
  }
  RP.apply("cursor");
});

test("card names and roles are pinned per profile", () => {
  const RP = loadProfiles();
  const pick = (p) => SLOTS.map((s) => [p.cardTips[s].name, p.cardTips[s].role]);
  assert.deepEqual(pick(RP.get("cursor")), [
    ["Opus", "Main session"],
    ["Fable", "Advisor"],
    ["Worker", "Sonnet · edits"],
    ["Explorer", "Haiku · search"],
    ["Researcher", "Haiku · docs"]
  ]);
  assert.deepEqual(pick(RP.get("claude-code")), [
    ["Lead", "Main session"],
    ["Planner", "Plan review"],
    ["Worker", "Edits"],
    ["Researcher", "Search"],
    ["Reviewer", "Reviewer"]
  ]);
});

test("every profile covers all five slots in every per-slot table", () => {
  const RP = loadProfiles();
  for (const id of ["cursor", "claude-code"]) {
    const p = RP.get(id);
    assert.ok(p, `profile ${id} must exist`);
    for (const table of ["labels", "models", "cardTips", "stations"]) {
      assert.deepEqual(Object.keys(p[table]).sort(), [...SLOTS].sort(), `${id}.${table} keys`);
    }
    assert.equal(p.chipTips.length, 3, `${id} keeps three advisor trigger chips`);
    assert.deepEqual(Object.keys(p.pills).sort(), ["advisor", "haiku", "opus", "sonnet"]);
  }
});

test("claude-code carries no cursor model or slot name in its display text", () => {
  const RP = loadProfiles();
  const p = RP.get("claude-code");
  const texts = [];
  for (const slot of SLOTS) {
    texts.push(p.labels[slot], p.stations[slot]);
    for (const k of Object.keys(p.cardTips[slot])) texts.push(p.cardTips[slot][k]);
  }
  for (const cls of Object.keys(p.pills))
    texts.push(p.pills[cls].text, p.pills[cls].tip, p.pills[cls].detail);
  texts.push(p.flows.asks, p.flows.delegates, ...p.chipTips.map((c) => c.detail));
  const banned = /Opus|Fable|Sonnet|Haiku|Advisor|Explorer/;
  for (const t of texts) {
    assert.ok(!banned.test(t), `claude-code text must not use a cursor name: ${t}`);
  }
});

test("parser role -> slot map covers all five parser roles", () => {
  assert.deepEqual(
    { ...PARSER_ROLE_TO_SLOT },
    {
      parent: "opus",
      planner: "advisor",
      worker: "worker",
      researcher: "explorer",
      reviewer: "researcher"
    }
  );
  assert.ok(Object.isFrozen(PARSER_ROLE_TO_SLOT), "the map must be frozen");
  for (const v of Object.values(PARSER_ROLE_TO_SLOT)) {
    assert.ok(SLOTS.includes(v), `${v} must be a real slot key`);
  }
});

test("roleFromAgentHint under cursor is unchanged (researcher stays researcher)", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  assert.equal(AC.roleFromAgentHint("researcher"), "researcher");
  assert.equal(AC.roleFromAgentHint("explore"), "explorer");
  assert.equal(AC.roleFromAgentHint("Advisor"), "advisor");
  assert.equal(AC.roleFromAgentHint({ model: "fable" }), "advisor");
  assert.equal(AC.roleFromAgentHint("parent"), "opus");
  assert.equal(AC.roleFromAgentHint("reviewer"), "", "cursor has no reviewer mapping");
  assert.equal(AC.roleFromAgentHint("planner"), "", "cursor has no planner mapping");
  assert.equal(AC.roleFromAgentHint(""), "");
  assert.equal(AC.roleFromAgentHint(null), "");
});

test("roleFromAgentHint under claude-code follows the owner map", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  assert.equal(
    AC.roleFromAgentHint("researcher"),
    "explorer",
    "parser researcher -> explorer slot"
  );
  assert.equal(
    AC.roleFromAgentHint("reviewer"),
    "researcher",
    "parser reviewer -> researcher slot"
  );
  assert.equal(AC.roleFromAgentHint("planner"), "advisor");
  assert.equal(AC.roleFromAgentHint("lead"), "opus");
  assert.equal(AC.roleFromAgentHint("parent"), "opus");
  assert.equal(AC.roleFromAgentHint("worker"), "worker", "worker is a claude-code word");
  assert.equal(
    AC.roleFromAgentHint({ name: "x", agentId: "reviewer-7" }),
    "researcher",
    "agentId counts"
  );
  assert.equal(AC.roleFromAgentHint("something-else"), "", "unmapped hint stays empty");
  RP.apply("cursor");
});

test("claude-code hint mapping agrees with the bridge parser map for all five roles", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  for (const [parserRole, slot] of Object.entries(PARSER_ROLE_TO_SLOT)) {
    assert.equal(
      AC.roleFromAgentHint(parserRole),
      slot,
      `parser role "${parserRole}" must resolve to slot "${slot}" under claude-code`
    );
  }
  RP.apply("cursor");
});

test("apply switches what get/tables/label return; earlier copies stay as they were", () => {
  const RP = loadProfiles();
  const before = RP.tables();
  assert.equal(RP.apply("claude-code"), true);
  assert.equal(RP.current().id, "claude-code");
  assert.equal(before.labels.opus, "Opus", "a copy taken earlier is a snapshot, not a view");
  assert.equal(RP.tables().labels.opus, "Lead", "tables() again sees the new name");
  assert.equal(RP.label("opus"), "Lead", "label() follows apply()");
  assert.equal(RP.label("nope"), undefined);
  assert.equal(RP.label("constructor"), undefined);
  assert.equal(RP.apply("cursor"), true);
  assert.equal(RP.label("opus"), "Opus", "apply(cursor) restores the original name");
  assert.equal(RP.tables().chipTips.length, 3);
});

test("boundaries: unknown and prototype-like sources are refused and change nothing", () => {
  const RP = loadProfiles();
  for (const bad of [
    "",
    "nope",
    "Claude-Code",
    "constructor",
    "__proto__",
    "toString",
    undefined,
    null
  ]) {
    assert.equal(RP.apply(bad), false, `apply(${String(bad)}) must return false`);
    assert.equal(RP.get(bad), null, `get(${String(bad)}) must return null`);
  }
  assert.equal(RP.current().id, "cursor", "a refused apply must leave the source alone");
  assert.equal(RP.tables().labels.opus, "Opus");
});

test("get returns the profile object for a known source", () => {
  const RP = loadProfiles();
  assert.equal(RP.get("claude-code").id, "claude-code");
  assert.equal(RP.get("cursor").id, "cursor");
});

test("cursor card tips and chip tips equal the strings cards.js had at master", () => {
  const cursor = loadProfiles().get("cursor");
  assert.deepEqual(plain(cursor.cardTips), HEAD_CARD_TIPS);
  assert.deepEqual(plain(cursor.chipTips), HEAD_CHIP_TIPS);
});

test("cursor stations, pills, flows and prices equal the static HTML at master", () => {
  const cursor = loadProfiles().get("cursor");
  assert.deepEqual(plain(cursor.stations), HEAD_STATIONS);
  assert.deepEqual(plain(cursor.pills), HEAD_PILLS);
  assert.deepEqual(plain(cursor.flows), HEAD_FLOWS);
  assert.deepEqual(plain(cursor.prices), HEAD_PRICES);
  const RP = loadProfiles();
  for (const slot of SLOTS) {
    assert.deepEqual(plain(RP.priceRow(slot)), HEAD_PRICES[slot], `cursor price row ${slot}`);
  }
});

test("claude-code price rows: model not set while the models table is empty", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  for (const slot of SLOTS) {
    assert.deepEqual(plain(RP.priceRow(slot)), ["", "model not set"], slot);
  }
  RP.apply("cursor");
});

const PRICE_ROWS = {
  opus: ["list price (Opus 5.5):", "$4 / $20"],
  fable: ["list price (Fable 5.2):", "$8 / $40"],
  sonnet: ["list price (Sonnet 5.5):", "$2 / $10"],
  haiku: ["list price (Haiku 5.5):", "$0.10 / $0.50"]
};

test("claude-code price rows show the current model's list price and name it", () => {
  const RP = loadProfiles();
  assert.equal(
    RP.setModels({
      opus: "claude-opus-4-5",
      advisor: "claude-fable-5-2",
      worker: "claude-sonnet-4-5",
      explorer: "claude-haiku-4-5",
      researcher: "claude-opus-4-5"
    }),
    true
  );
  RP.apply("claude-code");
  assert.deepEqual(plain(RP.priceRow("opus")), PRICE_ROWS.opus);
  assert.deepEqual(plain(RP.priceRow("advisor")), PRICE_ROWS.fable, "Fable 5.2 is $8 / $40");
  assert.deepEqual(plain(RP.priceRow("worker")), PRICE_ROWS.sonnet);
  assert.deepEqual(plain(RP.priceRow("explorer")), PRICE_ROWS.haiku);
  assert.deepEqual(plain(RP.priceRow("researcher")), PRICE_ROWS.opus, "follows its own model");
  assert.equal(RP.tables().models.worker, "claude-sonnet-4-5", "models table follows setModels");
  RP.apply("cursor");
  assert.deepEqual(
    plain(RP.priceRow("worker")),
    HEAD_PRICES.worker,
    "cursor ignores the models table"
  );
  assert.equal(RP.tables().models.worker, "Sonnet");
});

test("every family's row names its current model, whatever the id's own version", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const ids = [
    ["claude-opus-4-1", "Opus 5.5"],
    ["claude-3-5-sonnet-latest", "Sonnet 5.5"],
    ["claude-3-5-haiku-20241022", "Haiku 5.5"],
    ["claude-fable-5-1", "Fable 5.2"]
  ];
  for (const [id, name] of ids) {
    RP.setModels({ worker: id });
    const row = RP.priceRow("worker");
    assert.ok(row[0].includes("(" + name + ")"), id + " row must name " + name + ": " + row[0]);
    assert.ok(
      RP.current().cardTips.worker.priceDetail.includes("List price of " + name + ","),
      id + " tip must name " + name
    );
  }
  assert.deepEqual(plain(RP.priceRow("worker")), PRICE_ROWS.fable);
  RP.apply("cursor");
});

test("price number format: whole dollars without cents, fractions with two decimals", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  RP.setModels({ worker: "claude-haiku-4-5" });
  assert.equal(RP.priceRow("worker")[1], "$0.10 / $0.50");
  RP.setModels({ worker: "claude-opus-4-5" });
  assert.equal(RP.priceRow("worker")[1], "$4 / $20");
  RP.apply("cursor");
});

test("Haiku price tip carries the over-100k note; other families do not", () => {
  const RP = loadProfiles();
  RP.setModels({
    opus: "claude-opus-4-5",
    advisor: "claude-fable-5-2",
    worker: "claude-sonnet-4-5",
    explorer: "claude-haiku-4-5",
    researcher: "mystery"
  });
  RP.apply("claude-code");
  const tips = RP.current().cardTips;
  assert.ok(
    tips.explorer.priceDetail.includes("$0.50 / $2.50 over 100k"),
    tips.explorer.priceDetail
  );
  assert.ok(tips.explorer.priceDetail.includes("up to 100k tokens"));
  assert.equal(
    tips.opus.priceDetail,
    "List price of Opus 5.5, $ per 1M tokens in/out · not a bill"
  );
  assert.ok(tips.advisor.priceDetail.startsWith("List price of Fable 5.2, "));
  assert.ok(tips.worker.priceDetail.startsWith("List price of Sonnet 5.5, "));
  for (const slot of ["opus", "advisor", "worker"]) {
    assert.ok(!/over 100k/.test(tips[slot].priceDetail), slot);
  }
  assert.ok(/not a bill/.test(tips.researcher.priceDetail), "unpriced slot keeps the generic tip");
  RP.apply("cursor");
});

test("price list is its own table: bill-math rates do not feed the row", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MATH_SRC, "utf8"), sandbox, { filename: MATH_SRC });
  const stub = {
    RATES: { opus: { in: 1, out: 2 }, fable: { in: 3, out: 4 } },
    formatMoney: () => "X"
  };
  sandbox.window.WorkshopBillMath = stub;
  vm.runInContext(fs.readFileSync(PROFILES_SRC, "utf8"), sandbox, { filename: PROFILES_SRC });
  const RP = sandbox.window.RoleProfiles;
  RP.setModels({ opus: "claude-opus-4-5", advisor: "claude-fable-5-2" });
  RP.apply("claude-code");
  assert.deepEqual(plain(RP.priceRow("opus")), PRICE_ROWS.opus);
  assert.deepEqual(plain(RP.priceRow("advisor")), PRICE_ROWS.fable);
});

test("claude-code price row: a set model with no list price says no list price", () => {
  const RP = loadProfiles();
  RP.setModels({ worker: "gpt-5", explorer: "claude-haiku-4-5" });
  RP.apply("claude-code");
  assert.deepEqual(plain(RP.priceRow("worker")), ["no", "list price"]);
  assert.deepEqual(plain(RP.priceRow("explorer")), PRICE_ROWS.haiku);
  assert.deepEqual(plain(RP.priceRow("opus")), ["", "model not set"]);
  RP.setModels({ worker: "" });
  assert.deepEqual(plain(RP.priceRow("worker")), ["", "model not set"], "empty clears a slot");
});

test("claude-code price rows mention list price unless the slot is unset, and the tip says List price", () => {
  const RP = loadProfiles();
  RP.setModels({ opus: "claude-opus-4-5", worker: "mystery" });
  RP.apply("claude-code");
  for (const slot of SLOTS) {
    const row = RP.priceRow(slot).join(" ").trim();
    if (slot === "opus" || slot === "worker") assert.match(row, /list price/, slot);
    else assert.equal(row, "model not set", slot);
    assert.match(RP.current().cardTips[slot].priceDetail, /List price/, slot);
  }
});

test("setModels validates: bad slots, non-strings and odd ids are refused whole", () => {
  const RP = loadProfiles();
  const bad = [
    null,
    undefined,
    "opus",
    [],
    { nope: "claude-opus-4-5" },
    { __proto__x: "a", opus: "claude-opus-4-5" },
    { opus: 5 },
    { opus: null },
    { opus: "<img src=x onerror=alert(1)>" },
    { opus: "a b" },
    { opus: "a<b" },
    { opus: "a>b" },
    { opus: "a'b" },
    { opus: 'a"b' },
    { opus: "../etc" },
    { opus: "-leading" },
    { opus: "@leading" },
    { opus: "/leading" },
    { opus: ":leading" },
    { opus: "x".repeat(129) },
    { opus: "claude-opus-4-5", worker: "bad id" }
  ];
  for (const b of bad) {
    assert.equal(RP.setModels(b), false, JSON.stringify(b));
  }
  RP.apply("claude-code");
  assert.deepEqual(plain(RP.priceRow("opus")), ["", "model not set"], "nothing was stored");
  assert.equal(RP.setModels({ opus: "x".repeat(128) }), true, "128 chars is the limit");
  assert.equal(RP.setModels({}), true, "empty map is a no-op");
  assert.equal(RP.setModels({ opus: "claude-opus-4-5" }), true);
  RP.apply("cursor");
});

test("roleFromAgentHint under claude-code matches whole words, not substrings", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  assert.notEqual(AC.roleFromAgentHint("misleading"), "opus", "misleading is not lead");
  assert.notEqual(AC.roleFromAgentHint("pleading-agent"), "opus");
  assert.notEqual(AC.roleFromAgentHint({ name: "x", agentId: "misleading-7" }), "opus");
  assert.notEqual(AC.roleFromAgentHint("unplanned"), "advisor");
  assert.equal(AC.roleFromAgentHint("research"), "", "bare research is not a parser role");
  assert.equal(AC.roleFromAgentHint("research-bot"), "", "no cursor substring fall-through");
  assert.equal(AC.roleFromAgentHint("misleading"), "");
  assert.equal(AC.roleFromAgentHint("Lead"), "opus", "case-insensitive");
  assert.equal(AC.roleFromAgentHint("agent-lead"), "opus", "segment split on a dash");
  assert.equal(AC.roleFromAgentHint("sub_planner_2"), "advisor", "underscore and digits split");
  assert.equal(AC.roleFromAgentHint({ name: "x", agentId: "reviewer-7" }), "researcher");
  assert.equal(AC.roleFromAgentHint("researcher"), "explorer");
  assert.equal(AC.roleFromAgentHint("parent"), "opus");
  RP.apply("cursor");
  assert.equal(AC.roleFromAgentHint("misleading"), "", "cursor is untouched");
  assert.equal(AC.roleFromAgentHint("leader-parent-x"), "opus", "cursor keeps substring parent");
});

test("list price matches whole family tokens, once, never substrings", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const cases = [
    ["claude-opus-5-5", "opus"],
    ["claude-sonnet-5-5", "sonnet"],
    ["claude-haiku-5-5", "haiku"],
    ["Claude-OPUS-4-5-20251101", "opus"],
    ["anthropic.claude-haiku-4-5-v1:0", "haiku"],
    ["claude-fable-5-2", "fable"],
    ["claude-3-5-sonnet-latest", "sonnet"],
    ["claude-3-5-haiku-20241022", "haiku"],
    ["claude-opus-4-1", "opus"],
    ["claude-sonnet-4-5", "sonnet"],
    ["anthropic/claude-sonnet-4", "sonnet"],
    ["claude-opus-4-1@20250805", "opus"],
    ["anthropic-fable", "fable"],
    [
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "sonnet"
    ]
  ];
  for (const [id, family] of cases) {
    assert.equal(RP.setModels({ worker: id }), true, "setModels must accept " + id);
    assert.deepEqual(plain(RP.priceRow("worker")), PRICE_ROWS[family], id);
  }
  for (const id of [
    "octopus-1",
    "claude-octopus-1",
    "claude-magnum-opus-haiku",
    "claude-sonnetina",
    "claude-haikus-v2"
  ]) {
    assert.equal(RP.setModels({ worker: id }), true, id);
    assert.deepEqual(plain(RP.priceRow("worker")), ["no", "list price"], id);
  }
  RP.apply("cursor");
});

test("a price needs a claude or anthropic token: bare family names have no list price", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  for (const id of [
    "fable",
    "Fable-5.2",
    "opus",
    "opus-4-5",
    "sonnet",
    "haiku-4-5",
    "gpt-opus",
    "claudette-opus",
    "anthropics-opus"
  ]) {
    assert.equal(RP.setModels({ worker: id }), true, id);
    assert.deepEqual(plain(RP.priceRow("worker")), ["no", "list price"], id);
    assert.ok(RP.current().cardTips.worker.priceDetail.includes("of the model this role runs"), id);
  }
  for (const id of ["claude-opus", "anthropic-opus", "ANTHROPIC.Opus", "claude_haiku"]) {
    RP.setModels({ worker: id });
    assert.notEqual(RP.priceRow("worker")[0], "no", id);
  }
  RP.apply("cursor");
});

test("setModels while cursor is active stores for claude-code and leaves cursor alone", () => {
  const RP = loadProfiles();
  assert.equal(RP.setModels({ worker: "claude-sonnet-4-5" }), true);
  assert.equal(RP.current().id, "cursor");
  assert.equal(RP.tables().models.worker, "Sonnet");
  assert.deepEqual(plain(RP.priceRow("worker")), HEAD_PRICES.worker);
  RP.apply("claude-code");
  assert.equal(RP.tables().models.worker, "claude-sonnet-4-5");
});

test("claude-code hint rule: camelCase and word forms, no cursor substring fall-through", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  const cases = [
    ["ResearcherAgent", "explorer"],
    ["researcher-bot", "explorer"],
    ["researchers", "explorer"],
    ["Reviewer_2", "researcher"],
    ["reviewers", "researcher"],
    ["PlannerAgent", "advisor"],
    ["WorkerBot", "worker"],
    ["LeadAgent", "opus"],
    ["misleading", ""],
    ["pleading", ""],
    ["research-bot", ""],
    ["apparently", ""],
    ["explorer", ""],
    ["advisor", ""],
    ["something-else", ""]
  ];
  for (const [hint, want] of cases) {
    assert.equal(AC.roleFromAgentHint(hint), want, hint);
  }
  assert.equal(AC.roleFromAgentHint({ model: "fable" }), "", "model alone does not pick a slot");
  RP.apply("cursor");
  assert.equal(AC.roleFromAgentHint("apparently"), "opus", "cursor substring logic is untouched");
});

function deepFrozen(o) {
  if (o === null || typeof o !== "object") return true;
  if (!Object.isFrozen(o)) return false;
  return Object.keys(o).every((k) => deepFrozen(o[k]));
}

test("get, current and tables return deeply frozen copies of the profile", () => {
  const RP = loadProfiles();
  for (const id of ["cursor", "claude-code"]) {
    assert.ok(deepFrozen(RP.get(id)), "get(" + id + ") must be deeply frozen");
  }
  assert.ok(deepFrozen(RP.current()));
  assert.ok(deepFrozen(RP.tables()));
  assert.notStrictEqual(RP.priceRow("opus"), RP.priceRow("opus"));
  RP.apply("claude-code");
  RP.setModels({ worker: "claude-sonnet-4-5" });
  assert.ok(deepFrozen(RP.get("claude-code")), "frozen after setModels too");
  assert.ok(deepFrozen(RP.tables()));
});

test("writing to a returned object, nested or not, changes nothing (strict and sloppy)", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  RP.setModels({ worker: "claude-sonnet-4-5" });
  const snap = JSON.stringify([RP.get("cursor"), RP.get("claude-code"), RP.tables()]);
  const targets = () => [
    RP.get("claude-code"),
    RP.get("cursor"),
    RP.current(),
    RP.tables(),
    RP.tables().labels,
    RP.tables().models,
    RP.tables().cardTips.opus,
    RP.tables().chipTips,
    RP.tables().hintRoles,
    RP.tables().hintRoles[0],
    RP.get("cursor").prices.opus,
    RP.get("claude-code").pills.opus
  ];
  // Sloppy attempts (a Function body is sloppy): silently ignored, nothing throws.
  const sloppy = new Function(
    "t",
    "t.opus = 'x'; t.id = 'x'; t.models = {}; t.name = 'x'; t[0] = 'x'; t.length = 0; delete t.opus; delete t.labels; return 1;"
  );
  for (const t of targets()) assert.equal(sloppy(t), 1);
  // Strict attempts: each one must throw.
  const strictAdd = new Function("t", "'use strict'; t.__added__ = 'x';");
  const strictPush = new Function("t", "'use strict'; t.push('x');");
  for (const t of targets()) {
    assert.throws(() => strictAdd(t), { name: "TypeError" });
    if (Array.isArray(t)) assert.throws(() => strictPush(t), { name: "TypeError" });
  }
  assert.throws(
    () => {
      "use strict";
      RP.tables().labels.opus = "x";
    },
    { name: "TypeError" }
  );
  assert.throws(
    () => {
      "use strict";
      RP.get("claude-code").models.worker = "x";
    },
    { name: "TypeError" }
  );
  assert.equal(
    JSON.stringify([RP.get("cursor"), RP.get("claude-code"), RP.tables()]),
    snap,
    "no profile or table changed"
  );
  assert.equal(RP.label("opus"), "Lead");
  assert.equal(RP.tables().models.worker, "claude-sonnet-4-5");
  assert.equal(AC.roleFromAgentHint("lead"), "opus", "hint rules unharmed");
  RP.apply("cursor");
  assert.equal(RP.label("opus"), "Opus");
});

test("returned copies are not the live data: setModels cannot reach through an old copy", () => {
  const RP = loadProfiles();
  const first = RP.get("claude-code");
  assert.notEqual(first, RP.get("cursor"));
  RP.setModels({ worker: "claude-sonnet-4-5" });
  assert.equal(first.models.worker, "", "an old copy keeps its old table");
  assert.equal(RP.get("claude-code").models.worker, "claude-sonnet-4-5");
});

test("price row DOM is one text node plus one strong, built without parsing markup", () => {
  const created = [];
  const mk = (type, text) => ({
    nodeType: type,
    text: text || "",
    children: [],
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
    },
    set textContent(v) {
      this.children = [];
      this.text = String(v);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    innerHTMLWrites: 0,
    set innerHTML(v) {
      this.innerHTMLWrites++;
      throw new Error("innerHTML must not be used");
    }
  });
  const priceEls = {};
  const doc = {
    createTextNode: (t) => {
      const n = mk(3, t);
      created.push(n);
      return n;
    },
    createElement: (tag) => {
      const n = mk(1);
      n.tag = tag;
      created.push(n);
      return n;
    },
    getElementById: (id) => {
      const m = /^card-(.+)$/.exec(id);
      if (!m) return null;
      priceEls[m[1]] = priceEls[m[1]] || mk(1);
      return { querySelector: (sel) => (sel === ".price" ? priceEls[m[1]] : null) };
    },
    querySelector: () => null
  };
  const sandbox = { window: { document: doc } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PROFILES_SRC, "utf8"), sandbox, { filename: PROFILES_SRC });
  const RP = sandbox.window.RoleProfiles;
  const vertexId = "claude-opus-4-1@20250805";
  RP.setModels({ opus: vertexId, worker: "claude-haiku-4-5", explorer: "mystery" });
  RP.apply("claude-code");
  for (const slot of SLOTS) {
    const el = priceEls[slot];
    assert.equal(el.children.length, 2, slot + ": exactly two children");
    assert.equal(el.children[0].nodeType, 3, slot + ": first child is a text node");
    assert.equal(el.children[1].nodeType, 1, slot + ": second child is an element");
    assert.equal(el.children[1].tag, "strong", slot + ": and it is a strong");
    assert.equal(el.children[1].children.length, 0, slot + ": strong holds text only");
    assert.equal(el.innerHTMLWrites, 0);
  }
  assert.equal(priceEls.opus.textContent, "list price (Opus 5.5): $4 / $20");
  assert.equal(priceEls.worker.textContent, "list price (Haiku 5.5): $0.10 / $0.50");
  assert.equal(priceEls.explorer.textContent, "no list price");
  assert.equal(priceEls.advisor.textContent, "model not set");
  assert.ok(
    created.every((n) => n.nodeType === 3 || n.tag === "strong"),
    "no element other than strong was ever created"
  );
});

test("hint keyword order: the first hintRoles entry found wins, not the first word typed", () => {
  const RP = loadProfiles();
  const AC = loadCards(RP);
  RP.apply("claude-code");
  // reviewer is listed before researcher, so it wins in both word orders.
  assert.equal(AC.roleFromAgentHint("reviewer-researcher"), "researcher");
  assert.equal(AC.roleFromAgentHint("researcher-reviewer"), "researcher");
  assert.equal(AC.roleFromAgentHint({ name: "researcher", agentId: "reviewer-1" }), "researcher");
  // researcher alone is the explorer slot, so the two words resolve to different slots alone.
  assert.equal(AC.roleFromAgentHint("researcher"), "explorer");
  assert.equal(AC.roleFromAgentHint("reviewer"), "researcher");
  // planner before worker before lead.
  assert.equal(AC.roleFromAgentHint("lead-worker"), "worker");
  assert.equal(AC.roleFromAgentHint("worker-lead"), "worker");
  assert.equal(AC.roleFromAgentHint("worker-planner"), "advisor");
  RP.apply("cursor");
});

test("claude-code price rows read exactly: no list price, and model not set", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const text = (slot) => {
    const row = RP.priceRow(slot);
    return (row[0] ? row[0] + " " : "") + row[1];
  };
  assert.equal(text("opus"), "model not set");
  RP.setModels({ opus: "opus", worker: "gpt-5" });
  assert.equal(text("opus"), "no list price", "a bare alias has no list price");
  assert.equal(text("worker"), "no list price", "a non-Claude id has no list price");
  assert.ok(!/list price list price/.test(text("opus") + text("worker")));
  RP.apply("cursor");
});

test("claude-code price rows never carry a stray or doubled list price label", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const SLOT_NAMES = ["opus", "advisor", "worker", "explorer", "researcher"];
  const text = (slot) => {
    const row = RP.priceRow(slot);
    return (row[0] ? row[0] + " " : "") + row[1];
  };
  const states = [
    {},
    { opus: "claude-opus-5-5", advisor: "claude-fable-5-2", worker: "claude-sonnet-5-5" },
    { opus: "opus", advisor: "gpt-5", worker: "claude-haiku-5-5", explorer: "mystery" }
  ];
  for (const models of states) {
    RP.setModels({ opus: "", advisor: "", worker: "", explorer: "", researcher: "" });
    RP.setModels(models);
    for (const slot of SLOT_NAMES) {
      const t = text(slot);
      assert.ok(!/list price list price/.test(t), slot + ": " + t);
      if (t === "model not set") continue;
      if (t === "no list price") continue;
      assert.ok(/^list price \(\w+ [\d.]+\): \$[\d.]+ \/ \$[\d.]+$/.test(t), slot + ": " + t);
    }
    assert.ok(
      !text("researcher").includes("list price") || models.researcher,
      "unset row is plain"
    );
  }
  RP.apply("cursor");
});
