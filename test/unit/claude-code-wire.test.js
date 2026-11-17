/**
 * Tests for lib/claude-code-wire.js (rows -> events, alerts, model slots) and the parser/ingest
 * model memory it reads. Pure: lines are built in memory, the one ingest test uses a folder
 * under the gitignored .scratch/.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test, after } = require("node:test");

const W = require("../../lib/claude-code-wire");
const P = require("../../lib/claude-code-parse");
const I = require("../../lib/claude-code-ingest");
const L = require("../helpers/claude-lines");
const { buildForbidden } = require("../helpers/privacy-patterns");

const REPO = path.join(__dirname, "..", "..");
const ROOT = path.join(REPO, ".scratch", "wire-test-" + process.pid);
const BS = String.fromCharCode(92);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function parseAll(lines, state) {
  const st = state || P.createState();
  const rows = [];
  for (const l of lines) rows.push(...P.parseLine(P.parseJsonLine(l), st, { source: "session" }));
  return { rows, state: st };
}

test("a finished notification keeps type, ids, status, tokens, tool uses and duration", () => {
  const { rows } = parseAll([
    L.assistant([L.agentCall("toolu_1", "worker", "sonnet")]),
    L.agentResult("toolu_1", "agent1"),
    L.notification("toolu_1", "agent1", "completed")
  ]);
  const done = rows.find((r) => r.type === "done");
  const ev = W.eventFromRow(done);
  assert.equal(ev.type, "done");
  assert.equal(ev.agentId, "agent1");
  assert.equal(ev.toolUseId, "toolu_1");
  assert.equal(ev.statusKnown, true);
  assert.equal(ev.subagentTokens, 1234);
  assert.equal(ev.toolUses, 7);
  assert.equal(ev.durationMs, 4500);
  assert.equal(ev.role, "worker");
  assert.deepEqual(ev.active, ["worker"]);
  assert.equal(ev.iso, done.ts, "the transcript time is kept as iso");
  assert.match(ev.ts, /^\d\d:\d\d:\d\d$/);
});

test("an unknown notification status keeps statusKnown false and never alerts", () => {
  const { rows } = parseAll([
    L.assistant([L.agentCall("toolu_1", "worker", "sonnet")]),
    L.notification("toolu_1", "agent1", "weird")
  ]);
  const row = rows.find((r) => r.statusKnown === false);
  assert.ok(row, "a row with an unknown status");
  assert.equal(W.eventFromRow(row).statusKnown, false);
  assert.equal(W.alertFromRow(row), null);
});

test("delegation rows keep childRole and map roles to the dashboard slots", () => {
  const { rows } = parseAll([
    L.assistant([L.agentCall("toolu_p", "planner", "opus")]),
    L.assistant([L.agentCall("toolu_r", "researcher", "haiku")]),
    L.assistant([L.agentCall("toolu_v", "reviewer", "opus")])
  ]);
  const evs = rows.filter((r) => r.kind === "delegates").map(W.eventFromRow);
  assert.deepEqual(
    evs.map((e) => [e.childRole, e.routeTo, e.active[0]]),
    [
      ["advisor", "advisor", "advisor"],
      ["explorer", "explorer", "explorer"],
      ["researcher", "researcher", "researcher"]
    ]
  );
  assert.equal(evs[0].role, "parent", "the Lead card is role parent");
  assert.equal(evs[0].toolUseId, "toolu_p");
});

test("a child spawn row keeps parentToolUseId and the child's own role slot", () => {
  const state = P.createState();
  parseAll([L.assistant([L.agentCall("toolu_1", "reviewer", "opus")])], state);
  const child = P.parseLine(
    P.parseJsonLine(
      L.line({
        type: "user",
        isSidechain: true,
        agentId: "agent9",
        sessionId: L.SESSION,
        timestamp: "2026-01-02T03:04:05.000Z",
        message: { role: "user", content: "SECRET-PROMPT" }
      })
    ),
    state,
    { source: "subagent:1", meta: { agentType: "reviewer", toolUseId: "toolu_1", model: "opus" } }
  );
  const spawn = child.find((r) => r.type === "spawn");
  assert.ok(spawn, "a spawn row");
  const ev = W.eventFromRow(spawn);
  assert.equal(ev.parentToolUseId, "toolu_1");
  assert.equal(ev.role, "researcher", "parser reviewer is the researcher slot");
  assert.equal(ev.source, "subagent:1");
  assert.ok(!JSON.stringify(ev).includes("SECRET-PROMPT"));
});

test("usage passes through with tokens and the role as a slot", () => {
  const { rows } = parseAll([
    L.assistant([{ type: "text", text: "x" }], {
      usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 }
    })
  ]);
  const ev = W.eventFromRow(rows[0]);
  assert.deepEqual(ev.usage, {
    model: "opus",
    role: "parent",
    in: 11,
    out: 22,
    cacheRead: 33,
    cacheWrite: 0
  });
});

test("absolute tool paths are cut to a file name; relative paths and hosts stay", () => {
  const cases = [
    ["C:" + BS + "Users" + BS + "bob" + BS + "proj" + BS + "a.js", "a.js"],
    ["/home/bob/proj/a.js", "a.js"],
    [BS + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + "bob" + BS + "a.js", "a.js"],
    ["~/proj/a.js", "a.js"],
    ["../../bob/a.js", "a.js"],
    ["src/lib/a.js", "src/lib/a.js"],
    ["a.js", "a.js"],
    ["https://example.com/docs", "https://example.com/docs"],
    ["/", ""]
  ];
  for (const [input, want] of cases) assert.equal(W.safePathText(input), want, input);
  const { rows } = parseAll([
    L.assistant([L.toolUse("t1", "Read", { file_path: "/home/bob/proj/secret-name.js" })])
  ]);
  const ev = W.eventFromRow(rows[0]);
  assert.equal(ev.activity.path, "secret-name.js");
  assert.equal(ev.message, "read · secret-name.js");
  assert.ok(!buildForbidden(["bob"]).test(JSON.stringify(ev)));
});

test("a relative tool path keeps its message untouched", () => {
  const { rows } = parseAll([L.assistant([L.toolUse("t1", "Read", { file_path: "src/a.js" })])]);
  const ev = W.eventFromRow(rows[0]);
  assert.equal(ev.message, rows[0].message);
  assert.equal(ev.activity.path, "src/a.js");
});

test("ids that are not plain tokens are dropped, and a path in a label is hidden", () => {
  const ev = W.eventFromRow({
    ts: "2026-01-02T03:04:05.000Z",
    role: "worker",
    kind: "status",
    type: "turn",
    message: "delegates · C:/Users/bob/x",
    agentId: "C:/Users/bob",
    toolUseId: "has space",
    parentToolUseId: "/home/bob",
    source: "C:/Users/bob/s.jsonl",
    modelLabel: "C:" + BS + "Users" + BS + "bob"
  });
  assert.equal(ev.agentId, "");
  assert.equal(ev.toolUseId, "");
  assert.equal(ev.parentToolUseId, undefined);
  assert.equal(ev.source, "session");
  assert.ok(!/Users|bob/.test(JSON.stringify(ev)), JSON.stringify(ev));
});

test("Cursor events stay as they were: pushEvent does not carry the Claude Code fields", () => {
  const bridge = fs.readFileSync(path.join(REPO, "live-bridge.js"), "utf8");
  const start = bridge.indexOf("function pushEvent(partial)");
  const body = bridge.slice(start, bridge.indexOf("\n}\n", start));
  assert.ok(body.length > 100, "found pushEvent");
  for (const k of ["agentId", "toolUseId", "statusKnown", "subagentTokens", "childRole"]) {
    assert.ok(!body.includes(k), "pushEvent must not carry " + k);
  }
});

// ---- alerts ----

test("alerts: done is finished, error is error, a plain turn is none", () => {
  const { rows } = parseAll([
    L.assistant([L.agentCall("toolu_1", "worker", "sonnet"), L.agentCall("toolu_2", "planner")]),
    L.notification("toolu_1", "agent1", "completed"),
    L.notification("toolu_2", "agent2", "failed"),
    L.userTurn("hello")
  ]);
  const alerts = rows.map(W.alertFromRow).filter(Boolean);
  assert.deepEqual(alerts, [
    { name: "Worker", status: "finished", agentId: "agent1" },
    { name: "Planner", status: "error", agentId: "agent2" }
  ]);
  assert.equal(W.alertFromRow(rows[0]), null);
  assert.equal(W.alertFromRow(null), null);
});

test("alerts: a type outside the five roles is named by its resolved model", () => {
  const cases = [
    ["Explore", "haiku", "Researcher"],
    ["general-purpose", "opus", "Planner"],
    ["Plan", "sonnet", "Worker"],
    ["custom-thing", "", "Worker"]
  ];
  for (const [type, model, want] of cases) {
    const { rows } = parseAll([
      L.assistant([L.agentCall("toolu_1", type, model)]),
      L.notification("toolu_1", "agent1", "completed")
    ]);
    const a = rows.map(W.alertFromRow).find(Boolean);
    assert.equal(a.name, want, type + "/" + model);
  }
});

test("alert names are found by roleFromAgentHint under the claude-code profile", () => {
  const run = (sandbox, file) =>
    vm.runInContext(fs.readFileSync(path.join(REPO, "dashboard", file), "utf8"), sandbox);
  const profiles = { window: {} };
  vm.createContext(profiles);
  run(profiles, "bill-math.js");
  run(profiles, "role-profiles.js");
  const cards = {
    window: {
      SafeHtml: { escapeHtml: (t) => String(t) },
      RoleProfiles: profiles.window.RoleProfiles
    }
  };
  vm.createContext(cards);
  run(cards, "cards.js");
  const win = { RoleProfiles: profiles.window.RoleProfiles, AgentCards: cards.window.AgentCards };
  win.RoleProfiles.apply("claude-code");
  const want = {
    Lead: "opus",
    Planner: "advisor",
    Researcher: "explorer",
    Worker: "worker",
    Reviewer: "researcher"
  };
  for (const [name, slot] of Object.entries(want)) {
    assert.equal(win.AgentCards.roleFromAgentHint({ name, agentId: "agent1" }), slot, name);
  }
});

// ---- models ----

test("resolveSlotModels: each alias becomes the latest full id", () => {
  const m = W.resolveSlotModels({
    own: {},
    declared: { planner: "opus", worker: "sonnet", researcher: "haiku" }
  });
  assert.equal(m.advisor, "claude-opus-5-5");
  assert.equal(m.worker, "claude-sonnet-5-5");
  assert.equal(m.explorer, "claude-haiku-5-5");
  assert.equal(m.opus, "");
  assert.equal(m.researcher, "");
  assert.deepEqual(Object.keys(m), ["opus", "advisor", "worker", "explorer", "researcher"]);
});

test("resolveSlotModels: inherit takes the Lead's own model, and is unset without one", () => {
  const withParent = W.resolveSlotModels({
    own: { parent: "claude-opus-4-1" },
    declared: { worker: "inherit" }
  });
  assert.equal(withParent.opus, "claude-opus-4-1");
  assert.equal(withParent.worker, "claude-opus-4-1");
  const without = W.resolveSlotModels({ own: {}, declared: { worker: "inherit" } });
  assert.equal(without.worker, "");
  const badParent = W.resolveSlotModels({
    own: { parent: "a/../b" },
    declared: { worker: "inherit" }
  });
  assert.equal(badParent.worker, "", "an unsafe parent id is never inherited");
  assert.equal(badParent.opus, "");
});

test("resolveSlotModels: an unknown alias stays unset, an observed model beats a declared one", () => {
  const m = W.resolveSlotModels({
    own: { worker: "claude-sonnet-4-5" },
    declared: { worker: "haiku", planner: "mystery", reviewer: "OPUS[1m]" }
  });
  assert.equal(m.worker, "claude-sonnet-4-5");
  assert.equal(m.advisor, "");
  assert.equal(m.researcher, "claude-opus-5-5", "case and the [1m] suffix are ignored");
});

test("resolveSlotModels: ids with .. or a backslash are refused (ids only reach text)", () => {
  for (const bad of [
    "a/../b",
    "claude-opus/../x",
    "anthropic/../claude-opus-5-5",
    "claude" + BS + "opus",
    "/claude-opus",
    "claude-opus-5-5/"
  ]) {
    const m = W.resolveSlotModels({ own: { worker: bad }, declared: {} });
    assert.equal(m.worker, "", bad);
  }
  const proto = W.resolveSlotModels(
    JSON.parse('{"own":{"__proto__":"claude-opus-5-5"},"declared":{}}')
  );
  assert.equal(proto.worker, "");
  assert.equal(W.resolveSlotModels(null).opus, "");
});

test("the parser remembers own and declared models per role, and the ingest hands them out", () => {
  const dir = path.join(ROOT, "proj-demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, L.SESSION + ".jsonl"),
    [
      L.assistant([{ type: "text", text: "x" }], { model: "claude-opus-4-1" }),
      L.assistant([L.agentCall("toolu_1", "worker", "sonnet")], { model: "claude-opus-4-1" })
    ].join("\n") + "\n"
  );
  const empty = I.createClaudeCodeIngest({ projectDir: path.join(ROOT, "nothing-here") });
  assert.deepEqual(empty.models(), { own: {}, declared: {} });
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  const m = ing.models();
  assert.equal(m.own.parent, "claude-opus-4-1");
  assert.equal(m.declared.worker, "sonnet");
  const slots = W.resolveSlotModels(m);
  assert.equal(slots.opus, "claude-opus-4-1");
  assert.equal(slots.worker, "claude-sonnet-5-5");
});

test("a synthetic model line does not become the Lead's model", () => {
  const { state } = parseAll([
    L.assistant([{ type: "text", text: "x" }], { model: "<synthetic>" })
  ]);
  assert.deepEqual(state.roleModels.own, {});
});

test("wire, ingest and parser never load the event log", () => {
  for (const f of ["claude-code-wire.js", "claude-code-ingest.js", "claude-code-parse.js"]) {
    const src = fs.readFileSync(path.join(REPO, "lib", f), "utf8");
    assert.ok(!/require\([^)]*event-log/.test(src), f + " must not require event-log");
  }
});

/** Event of a tool call run through the parser and the wire. */
function toolEvent(name, input) {
  const { rows } = parseAll([L.assistant([L.toolUse("toolu_x", name, input)])]);
  const row = rows.find((r) => r.activity);
  assert.ok(row, name + " produced an activity row");
  return W.eventFromRow(row);
}

test("a URL activity keeps its scheme (the drive rule must not match the s:/ of https://)", () => {
  const ev = toolEvent("WebFetch", { url: "https://docs.example.com/guide" });
  assert.equal(ev.message, "read · https://docs.example.com/guide");
  assert.equal(ev.activity.path, "https://docs.example.com/guide");
  const local = toolEvent("WebFetch", { url: "http://localhost:3000/" });
  assert.equal(local.activity.path, "http://localhost:3000");
  // a real drive path in free text is still cut, also right after a letter-free start
  assert.equal(
    W.eventFromRow({ kind: "status", role: "parent", message: "see C:" + BS + "x" + BS + "y.js" })
      .message,
    "see [path]"
  );
});

test("an absolute path behind leading quotes or brackets is cut to the file name", () => {
  const cases = [
    '"/home/bob/proj/a.js"',
    "'/home/bob/a.js",
    "(/home/bob/a.js)",
    "[/Users/bob/a.js]",
    "x/home/bob/a.js",
    "~/a.js",
    '"/srv/bob/a.js"',
    "(/var/bob/a.js)"
  ];
  for (const file_path of cases) {
    const ev = toolEvent("Read", { file_path });
    assert.equal(ev.activity.path, "a.js", file_path);
    assert.equal(ev.message, "read · a.js", file_path);
    assert.ok(!/bob|home|Users/.test(JSON.stringify(ev)), file_path);
  }
  assert.equal(toolEvent("Read", { file_path: "src/a.js" }).activity.path, "src/a.js");
});

test("posix paths in free text and home-style model ids never reach an event or the model map", () => {
  const ev = W.eventFromRow({
    kind: "delegates",
    role: "parent",
    message: "delegates · /home/bob/x",
    modelRaw: "anthropic/home/bob",
    modelLabel: "/Users/bob/m",
    usage: { model: "anthropic/home/bob", role: "worker", in: 1, out: 1 }
  });
  assert.equal(ev.message, "delegates · [path]");
  assert.equal(ev.modelRaw, null);
  assert.equal(ev.modelLabel, null);
  assert.equal(ev.usage.model, "");
  assert.ok(!/bob/.test(JSON.stringify(ev)));
  const slots = W.resolveSlotModels({ own: { worker: "anthropic/home/bob" }, declared: {} });
  assert.equal(slots.worker, "");
  // a plain provider-prefixed id is still kept
  const ok = W.resolveSlotModels({ own: { worker: "anthropic/claude-sonnet-4" }, declared: {} });
  assert.equal(ok.worker, "anthropic/claude-sonnet-4");
});

test("a path that ends at a home folder shows ~, never the user name (both separators, trailing slash)", () => {
  const cases = [
    "/Users/alice",
    "/Users/alice/",
    "/home/alice",
    "/home/alice/",
    "/home/alice//",
    "C:" + BS + "Users" + BS + "alice",
    "C:" + BS + "Users" + BS + "alice" + BS,
    "C:/Users/alice",
    "/mnt/c/Users/alice",
    "/mnt/c/Users/alice/",
    "C:" + BS + "Documents and Settings" + BS + "alice",
    "/root",
    "/home",
    "/Users",
    "~"
  ];
  for (const file_path of cases) {
    const ev = toolEvent("Read", { file_path });
    assert.equal(ev.activity.path, "~", file_path);
    assert.equal(ev.message, "read · ~", file_path);
    assert.ok(!/alice/.test(JSON.stringify(ev)), file_path);
  }
  // a file in the home folder, or deeper, still shows its file name
  assert.equal(W.safePathText("/Users/alice/a.js"), "a.js");
  assert.equal(W.safePathText("/root/a.js"), "a.js");
  assert.equal(W.safePathText("/mnt/c/Users/alice/proj/a.js"), "a.js");
  // owner decision: a RELATIVE path with a home-style folder keeps cutting to the file name
  assert.equal(W.safePathText("src/home/page.js"), "page.js");
  assert.equal(W.safePathText("src/users/alice"), "alice");
});

test("percent-encoded paths are cut like their decoded forms", () => {
  assert.equal(W.safePathText("C%3A%5CUsers%5Calice%5Ca.js"), "a.js");
  assert.equal(W.safePathText("C%3A%5CUsers%5Calice"), "~");
  assert.equal(W.safePathText("%2Fhome%2Falice%2Fproj%2Fa.js"), "a.js");
  assert.equal(W.safePathText("%2Fhome%2Falice"), "~");
  assert.equal(W.safePathText("%252Fhome%252Falice"), "~", "double-encoded");
  assert.equal(W.safePathText("%2Fopt%2Falice%2Fa.js"), "a.js");
  // a bad escape or a relative encoded name stays as it is
  assert.equal(W.safePathText("100%25.js"), "100%25.js");
  assert.equal(W.safePathText("%E0%A4"), "%E0%A4");
  const ev = toolEvent("Read", { file_path: "C%3A%5CUsers%5Calice%5Ca.js" });
  assert.equal(ev.activity.path, "a.js");
  assert.ok(!/alice|Users/.test(JSON.stringify(ev)));
});

test("percent-encoded paths: a bad escape elsewhere, triple encoding and ~name cannot show a user name", () => {
  assert.equal(W.safePathText("%2FUsers%2Falice%2F100%25%.txt"), "100%%.txt");
  assert.equal(W.safePathText("C%3A%5CUsers%5Calice%5Cx%zz"), "x%zz");
  assert.equal(W.safePathText("C%25253A%25255CUsers%25255Calice%25255Ca.js"), "a.js");
  assert.equal(W.safePathText("%2FUsers%2Falice"), "~");
  assert.equal(W.safePathText("~alice"), "~");
  assert.equal(W.safePathText("~alice/"), "~");
  assert.equal(W.safePathText("~alice/proj/a.js"), "a.js");
  // an undecodable run next to a slash escape: the escape must still act as a separator
  assert.equal(W.safePathText("/home%2Falice%2F%ff.txt"), "%ff.txt");
  assert.ok(!/alice/.test(W.safePathText("/home%2Falice%2F%ff.txt")));
  for (const p of [
    "%2FUsers%2Falice%2F100%25%.txt",
    "C%3A%5CUsers%5Calice%5Cx%zz",
    "~alice",
    "/home%2Falice%2F%ff.txt"
  ]) {
    const ev = toolEvent("Read", { file_path: p });
    assert.ok(!/alice|Users/.test(JSON.stringify(ev)), p);
  }
});

/** A tool row as the parser would hand it over, built directly so every path form reaches the wire. */
const pathEvent = (p) =>
  W.eventFromRow({
    kind: "message",
    role: "parent",
    message: "read · " + p,
    activity: { kind: "read", path: p, detail: "" }
  });

const HOME_PATHS = [
  "/home/./alice",
  "/home/foo/../alice",
  "foo/../../Users/alice",
  "file:///C:/Users/alice",
  "file:///home/alice",
  "FILE:///C:/Users/alice",
  "file://localhost/C:/Users/alice",
  "file:/C:/Users/alice",
  "file:///C%3A/Users/alice",
  "C:\\DOCUME~1\\ALICE~1",
  "..\\..\\DOCUME~1\\ALICE~1",
  "C:Users/alice"
];

test("home paths are normalized before the user-name check: dots, file: URIs, 8.3 names, drive-relative", () => {
  for (const p of HOME_PATHS) {
    assert.equal(W.safePathText(p), "~", JSON.stringify(p));
    const ev = pathEvent(p);
    assert.equal(ev.activity.path, "~", "activity.path of " + JSON.stringify(p));
    assert.equal(ev.message, "read · ~", "message of " + JSON.stringify(p));
    assert.ok(!/alice/i.test(JSON.stringify(ev)), "whole event of " + JSON.stringify(p));
  }
  // existing behaviour is kept
  assert.equal(W.safePathText("/Users/alice"), "~");
  assert.equal(W.safePathText("C:\\Users\\alice"), "~");
  assert.equal(W.safePathText("/Users/alice/a.js"), "a.js");
  assert.equal(W.safePathText("file:///home/alice/a.js"), "a.js");
  assert.equal(W.safePathText("src/lib/a.js"), "src/lib/a.js");
  assert.equal(W.safePathText("/.."), "");
  assert.equal(W.safePathText("/a/../../.."), "");
});

test("http(s) URLs are never judged as file paths: a home-looking URL stays whole", () => {
  assert.equal(W.safePathText("https://example.com/docs"), "https://example.com/docs");
  assert.equal(W.safePathText("https://example.com/home/alice"), "https://example.com/home/alice");
  assert.equal(W.safePathText("HTTP://example.com/Users/alice"), "HTTP://example.com/Users/alice");
  const ev = pathEvent("https://example.com/home/alice");
  assert.equal(ev.activity.path, "https://example.com/home/alice");
  assert.equal(ev.message, "read · https://example.com/home/alice");
});

test("free text hides ~/, forward-slash UNC and any rooted folder path", () => {
  const text = (message) => W.eventFromRow({ kind: "status", role: "parent", message }).message;
  assert.equal(text("see ~/alice now"), "see [path] now");
  assert.equal(text("//srv/s/Users/alice x"), "[path] x");
  assert.equal(text("in /opt/alice/x"), "in [path]");
  assert.equal(text("/opt/alice/x"), "[path]");
  // what must stay: URLs, relative paths, plain slashes
  assert.equal(text("fetch https://example.com/a/b ok"), "fetch https://example.com/a/b ok");
  assert.equal(text("src/lib/a.js and/or 1/2"), "src/lib/a.js and/or 1/2");
  assert.equal(text("a / b"), "a / b");
  const ev = W.eventFromRow({
    kind: "delegates",
    role: "parent",
    message: "delegates · ~/alice/x"
  });
  assert.equal(ev.message, "delegates · [path]");
});
