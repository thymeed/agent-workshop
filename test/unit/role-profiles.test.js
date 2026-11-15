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

test("apply switches the live tables in place and keeps the same object", () => {
  const RP = loadProfiles();
  const live = RP.tables();
  const labels = live.labels;
  assert.equal(RP.apply("claude-code"), true);
  assert.equal(RP.current().id, "claude-code");
  assert.equal(RP.tables(), live, "tables() must return the same object");
  assert.equal(live.labels, labels, "the labels object must be refilled, not replaced");
  assert.equal(labels.opus, "Lead", "a held reference sees the new name");
  assert.equal(RP.apply("cursor"), true);
  assert.equal(labels.opus, "Opus", "apply(cursor) restores the original name");
  assert.equal(live.chipTips.length, 3);
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
    assert.deepEqual(plain(RP.priceRow(slot)), ["model not set", "list price"], slot);
  }
  RP.apply("cursor");
});

test("claude-code price rows show the list price of each slot's own model", () => {
  const RP = loadProfiles();
  assert.equal(
    RP.setModels({
      opus: "claude-opus-4-5",
      advisor: "fable",
      worker: "claude-sonnet-4-5",
      explorer: "claude-haiku-4-5",
      researcher: "claude-opus-4-5"
    }),
    true
  );
  RP.apply("claude-code");
  const per = "list price per 1M in/out";
  assert.deepEqual(plain(RP.priceRow("opus")), ["$4.00 / $20.00", per]);
  assert.deepEqual(plain(RP.priceRow("advisor")), ["$10.00 / $50.00", per]);
  assert.deepEqual(plain(RP.priceRow("worker")), ["$2.00 / $10.00", per]);
  assert.deepEqual(plain(RP.priceRow("explorer")), ["$0.10 / $0.50", per]);
  assert.deepEqual(
    plain(RP.priceRow("researcher")),
    ["$4.00 / $20.00", per],
    "follows its own model"
  );
  assert.equal(RP.tables().models.worker, "claude-sonnet-4-5", "live models table is refilled");
  RP.apply("cursor");
  assert.deepEqual(
    plain(RP.priceRow("worker")),
    HEAD_PRICES.worker,
    "cursor ignores the models table"
  );
  assert.equal(RP.tables().models.worker, "Sonnet");
});

test("claude-code price row: a set model with no list price says no list price", () => {
  const RP = loadProfiles();
  RP.setModels({ worker: "gpt-5", explorer: "claude-haiku-4-5" });
  RP.apply("claude-code");
  assert.deepEqual(plain(RP.priceRow("worker")), ["no list price", "list price"]);
  assert.deepEqual(RP.priceRow("explorer")[0], "$0.10 / $0.50");
  assert.deepEqual(plain(RP.priceRow("opus")), ["model not set", "list price"]);
  RP.setModels({ worker: "" });
  assert.deepEqual(
    plain(RP.priceRow("worker")),
    ["model not set", "list price"],
    "empty clears a slot"
  );
});

test("claude-code price labels all say list price", () => {
  const RP = loadProfiles();
  RP.setModels({ opus: "claude-opus-4-5", worker: "mystery" });
  RP.apply("claude-code");
  for (const slot of SLOTS) {
    assert.match(RP.priceRow(slot)[1], /list price/, slot);
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
  assert.deepEqual(
    plain(RP.priceRow("opus")),
    ["model not set", "list price"],
    "nothing was stored"
  );
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

/** Expected list price text for a family, read from bill-math.js itself. */
function expectedPrice(family) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MATH_SRC, "utf8"), sandbox, { filename: MATH_SRC });
  const m = sandbox.window.WorkshopBillMath;
  const r = m.RATES[family];
  return m.formatMoney(r.in) + " / " + m.formatMoney(r.out);
}

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
    ["Fable-5.2", "fable"],
    ["claude-3-5-sonnet-latest", "sonnet"],
    ["claude-3-5-haiku-20241022", "haiku"],
    ["claude-opus-4-1", "opus"],
    ["claude-sonnet-4-5", "sonnet"],
    ["anthropic/claude-sonnet-4", "sonnet"],
    ["claude-opus-4-1@20250805", "opus"],
    [
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "sonnet"
    ]
  ];
  for (const [id, family] of cases) {
    assert.equal(RP.setModels({ worker: id }), true, "setModels must accept " + id);
    assert.deepEqual(
      plain(RP.priceRow("worker")),
      [expectedPrice(family), "list price per 1M in/out"],
      id
    );
  }
  for (const id of ["octopus-1", "magnum-opus-haiku", "sonnetina", "haikus-v2"]) {
    assert.equal(RP.setModels({ worker: id }), true, id);
    assert.deepEqual(plain(RP.priceRow("worker")), ["no list price", "list price"], id);
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
