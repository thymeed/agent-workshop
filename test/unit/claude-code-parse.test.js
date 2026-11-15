/**
 * Tests for lib/claude-code-parse.js. Fixture tests use the sanitized real-shape sessions
 * (all text is "S1", cost-state numbers are zeroed). Per-model token tests use small
 * hand-built lines, labelled SYNTHETIC. Nothing here touches disk except reading fixtures.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const P = require("../../lib/claude-code-parse");

const WIN = path.join(__dirname, "..", "fixtures", "claude-code", "real", "C--proj-demo");
const WSL = path.join(__dirname, "..", "fixtures", "claude-code", "real", "-home-user-demo");
const SUB = path.join(WIN, "s1", "subagents");

const lines = (file) =>
  fs.readFileSync(file, "utf8").split("\n").map(P.parseJsonLine).filter(Boolean);
const readMeta = (n) => JSON.parse(fs.readFileSync(path.join(SUB, n), "utf8"));

function parseSession() {
  const state = P.createState();
  const rows = [];
  const feed = (file, opts) => {
    for (const o of lines(file)) rows.push(...P.parseLine(o, state, opts));
  };
  feed(path.join(WIN, "s1.jsonl"), { source: "s1.jsonl" });
  for (const a of ["a1", "a2"]) {
    feed(path.join(SUB, `agent-${a}.jsonl`), {
      source: `agent-${a}.jsonl`,
      meta: readMeta(`agent-${a}.meta.json`)
    });
  }
  return { state, rows };
}

/* SYNTHETIC builders */
const asst = (id, model, usage, blocks, extra) => ({
  type: "assistant",
  isSidechain: false,
  timestamp: "2026-01-01T00:00:00.000Z",
  sessionId: "sess",
  uuid: "u-" + Math.random(),
  message: { id, model, role: "assistant", content: blocks, usage },
  ...extra
});
const u = (inn, out, cr, cw) => ({
  input_tokens: inn,
  output_tokens: out,
  cache_read_input_tokens: cr || 0,
  cache_creation_input_tokens: cw || 0
});
const text = [{ type: "text", text: "SECRET-REPLY" }];

test("fixtures: Agent calls become spawn rows with the right role and model", () => {
  const { rows } = parseSession();
  const spawns = rows.filter((r) => r.type === "spawn" && r.kind === "delegates" && !r.agentId);
  const byTool = Object.fromEntries(spawns.map((r) => [r.toolUseId, r]));
  assert.equal(spawns.length, 2);
  const planner = byTool[readMeta("agent-a1.meta.json").toolUseId];
  const worker = byTool[readMeta("agent-a2.meta.json").toolUseId];
  assert.equal(planner.childRole, "planner");
  assert.equal(planner.routeTo, "planner");
  assert.equal(worker.childRole, "worker");
  assert.equal(worker.modelRaw, "sonnet");
  assert.equal(worker.modelLabel, "Sonnet"); // alias gets its family label
  assert.equal(planner.modelRaw, null); // no model on the call
});

test("fixtures: child files link to their spawn row through meta.toolUseId", () => {
  const { rows } = parseSession();
  for (const a of ["a1", "a2"]) {
    const meta = readMeta(`agent-${a}.meta.json`);
    const child = rows.filter((r) => r.agentId === a && r.type === "spawn");
    assert.equal(child.length, 1, a);
    assert.equal(child[0].toolUseId, meta.toolUseId);
    assert.equal(child[0].role, meta.agentType);
    // every row of that child file carries the same link and role
    for (const r of rows.filter((x) => x.agentId === a)) {
      assert.equal(r.toolUseId, meta.toolUseId);
      assert.equal(r.role, meta.agentType);
    }
  }
  // the planner child ran on the model the parent's Agent result resolved
  const a1 = rows.find((r) => r.agentId === "a1" && r.type === "spawn");
  assert.equal(a1.modelRaw, "claude-opus-5-5");
  assert.equal(a1.modelLabel, "Opus");
});

test("fixtures: each task-notification is emitted once despite enqueue, remove and attachment", () => {
  const { rows } = parseSession();
  const done = rows.filter((r) => r.type === "done");
  assert.equal(done.length, 2);
  assert.deepEqual(done.map((r) => r.agentId).sort(), ["a1", "a2"]);
  const a1 = done.find((r) => r.agentId === "a1");
  assert.equal(a1.subagentTokens, 65901);
  assert.equal(a1.toolUses, 15);
  assert.equal(a1.durationMs, 242239);
  assert.equal(a1.role, "planner");
  assert.equal(a1.statusKnown, true);
});

test("fixtures: rows carry real timestamps and never any transcript text", () => {
  const { rows } = parseSession();
  assert.ok(rows.length > 20);
  for (const r of rows) {
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
    assert.ok(r.ts.startsWith("2026-01-01"), "real timestamp, not now()");
    // every free-text field in the fixtures is "S1": only a tool path may carry it
    const probe = r.activity ? { ...r, message: "", activity: null } : r;
    assert.ok(!JSON.stringify(probe).includes("S1"), JSON.stringify(r));
  }
});

test("fixtures: whole WSL file, including the cut-off tail, parses without throwing", () => {
  const raw = fs.readFileSync(path.join(WSL, "s1.jsonl"), "utf8").split("\n");
  const state = P.createState();
  let parsed = 0;
  let cut = 0;
  for (const l of raw) {
    const o = P.parseJsonLine(l);
    if (!o) {
      if (l.trim()) cut++;
      continue;
    }
    parsed++;
    assert.ok(Array.isArray(P.parseLine(o, state)));
  }
  assert.equal(cut, 1, "exactly the cut-off line is skipped");
  assert.ok(parsed > 3);
});

test("fixtures: the oversize (>8192) line does not throw and makes only a plain turn row", () => {
  const big = fs
    .readFileSync(path.join(WIN, "s1.jsonl"), "utf8")
    .split("\n")
    .find((l) => l.length > 8192);
  const rows = P.parseLine(P.parseJsonLine(big), P.createState());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, "task / turn");
  assert.ok(JSON.stringify(rows).length < 1000);
});

test("SYNTHETIC: usage counts once per message.id at the final (last) value", () => {
  const state = P.createState();
  const rows = [];
  // same id on three block lines; usage grows 3 -> 3 -> 2381 output tokens
  for (const out of [3, 3, 2381]) {
    rows.push(
      ...P.parseLine(asst("m1", "claude-opus-5-5", u(2, out, 100, 50), text), state, {
        source: "p.jsonl"
      })
    );
  }
  const total = rows.reduce((n, r) => n + (r.usage ? r.usage.out : 0), 0);
  assert.equal(total, 2381);
  assert.deepEqual(P.usageTotals(state), {
    opus: { in: 2, out: 2381, cacheRead: 100, cacheWrite: 50 }
  });
  // a replay of the final line adds nothing
  const again = P.parseLine(asst("m1", "claude-opus-5-5", u(2, 2381, 100, 50), text), state);
  assert.equal(again[0].usage, null);
  assert.equal(P.usageTotals(state).opus.out, 2381);
});

test("SYNTHETIC: per-model totals split by message.model; partial usage never shrinks or throws", () => {
  const state = P.createState();
  P.parseLine(asst("a", "claude-opus-5-5", u(10, 20), text), state);
  P.parseLine(asst("b", "claude-sonnet-5-5", u(1, 2, 3, 4), text), state);
  P.parseLine(asst("c", "claude-haiku-5-5", u(5, 6), text), state);
  // partial-usage line: only output_tokens, then a line with fewer tokens than before
  P.parseLine(asst("a", "claude-opus-5-5", { output_tokens: 5 }, text), state);
  P.parseLine(asst("d", "claude-haiku-5-5", { output_tokens: 7 }, text), state);
  const t = P.usageTotals(state);
  assert.deepEqual(t.opus, { in: 10, out: 20, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(t.sonnet, { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(t.haiku, { in: 5, out: 13, cacheRead: 0, cacheWrite: 0 });
});

test("SYNTHETIC: usage rides the first row of a line only; usage-only line gets a working row", () => {
  const state = P.createState();
  const two = asst("m", "claude-opus-5-5", u(1, 9), [
    { type: "thinking", thinking: "SECRET-THINK" },
    { type: "text", text: "SECRET-REPLY" }
  ]);
  const rows = P.parseLine(two, state);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usage.out, 9);
  assert.equal(rows[1].usage, null);
  const bare = P.parseLine(asst("n", "claude-opus-5-5", u(1, 4), []), state);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].message, "working");
  assert.equal(bare[0].usage.model, "opus");
  assert.ok(!JSON.stringify([rows, bare]).includes("SECRET"));
});

test("SYNTHETIC: tool rows keep kind and path, drop commands, patterns and prompts", () => {
  const state = P.createState();
  const tools = [
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "curl SECRET-CMD" } },
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a/b.js" } },
    { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "SECRET-PATTERN" } },
    { type: "tool_use", id: "t4", name: "mcp__x__thing", input: { q: "SECRET-Q" } }
  ];
  const rows = P.parseLine(asst("m", "claude-opus-5-5", u(1, 1), tools), state);
  assert.deepEqual(
    rows.map((r) => r.message),
    ["run · Bash", "read · /a/b.js", "search · Grep", "tool · mcp__x__thing"]
  );
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
});

test("SYNTHETIC: roles outside the five map by resolved model", () => {
  assert.equal(P.resolveRole("planner"), "planner");
  assert.equal(P.resolveRole("Reviewer"), "reviewer");
  assert.equal(P.resolveRole("Explore", "claude-haiku-5-5"), "researcher");
  assert.equal(P.resolveRole("general-purpose", "sonnet"), "worker");
  assert.equal(P.resolveRole("custom", "claude-opus-5-5"), "planner");
  assert.equal(P.resolveRole("custom", ""), "worker");
  assert.equal(P.resolveRole("custom", "inherit"), "worker");
  assert.equal(P.resolveRole("lead"), "parent");
});

test("SYNTHETIC: Agent call with an unrecognized type and placeholder model", () => {
  const call = {
    type: "tool_use",
    id: "tX",
    name: "Agent",
    input: {
      subagent_type: "Explore",
      model: "inherit",
      prompt: "SECRET-PROMPT",
      description: "SECRET-D"
    }
  };
  const rows = P.parseLine(asst("m", "claude-opus-5-5", u(1, 1), [call]), P.createState());
  assert.equal(rows[0].childRole, "worker");
  assert.equal(rows[0].modelRaw, null);
  assert.equal(rows[0].message, "delegates · Explore");
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
});

test("SYNTHETIC: notification dedupe is per tool-use id; unknown status is flagged; failures are errors", () => {
  const state = P.createState();
  const note = (id, status) => ({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-01-01T00:00:00.000Z",
    content: `<task-notification><task-id>x</task-id><tool-use-id>${id}</tool-use-id><status>${status}</status><result>SECRET-RESULT</result></task-notification>`
  });
  assert.equal(P.parseLine(note("t1", "completed"), state)[0].type, "done");
  assert.deepEqual(P.parseLine(note("t1", "completed"), state), []);
  assert.equal(P.parseLine(note("t2", "failed"), state)[0].type, "error");
  const weird = P.parseLine(note("t3", "exploded"), state)[0];
  assert.equal(weird.type, "turn");
  assert.equal(weird.statusKnown, false);
  assert.ok(!JSON.stringify(weird).includes("SECRET"));
  // a notification with no tool-use id is ignored, not guessed at
  assert.deepEqual(
    P.parseLine(
      { type: "queue-operation", content: "<task-notification></task-notification>" },
      state
    ),
    []
  );
});

test("bad, empty and unknown input never throws", () => {
  const state = P.createState();
  const inputs = [
    null,
    undefined,
    0,
    "str",
    [],
    {},
    { type: "assistant" },
    { type: "assistant", message: "x" },
    { type: "assistant", message: { content: "x", usage: "bad" } },
    { type: "assistant", message: { content: [null, 1, {}, { type: "tool_use" }] } },
    { type: "user", message: { content: [null] } },
    { type: "queue-operation", content: 5 },
    { type: "totally-new-line-type", x: 1 },
    { type: "cost-state", modelUsage: {} }
  ];
  for (const i of inputs) assert.ok(Array.isArray(P.parseLine(i, state)), JSON.stringify(i));
  assert.deepEqual(P.parseLine({ type: "assistant", message: { content: [] } }, null), []);
  assert.deepEqual(P.parseLine({ type: "mode" }, state), []);
  assert.deepEqual(P.parseLine({ type: "cost-state" }, state), []);
  assert.equal(P.parseJsonLine(""), null);
  assert.equal(P.parseJsonLine('{"type":"cost-state","k":'), null);
  assert.equal(P.parseJsonLine("[1]"), null);
  assert.equal(P.parseMeta("x"), null);
  assert.equal(P.parseMeta(null), null);
});

test("child spawn row: first user line only, once, prompt not copied; meta alone is enough", () => {
  const state = P.createState();
  // a1-like: pickedEffortModel is sonnet but the child ran opus; it must not label the spawn
  const meta = { agentType: "reviewer", toolUseId: "tR", pickedEffortModel: "claude-sonnet-5-5" };
  const first = {
    type: "user",
    isSidechain: true,
    agentId: "ag",
    parentUuid: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "SECRET-PROMPT" }
  };
  const rows = P.parseLine(first, state, { meta });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "reviewer");
  assert.equal(rows[0].toolUseId, "tR");
  assert.equal(rows[0].modelLabel, null, "no known model: null, never the effort pick");
  assert.ok(!JSON.stringify(rows).includes("Sonnet"));
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
  assert.deepEqual(P.parseLine(first, state, { meta }), [], "second sight emits nothing");
});

test("fixtures: a1 child parsed before the parent never claims Sonnet; its own model picks the role", () => {
  const meta = readMeta("agent-a1.meta.json");
  assert.equal(meta.pickedEffortModel, "claude-sonnet-5-5");
  const state = P.createState();
  const rows = [];
  for (const o of lines(path.join(SUB, "agent-a1.jsonl"))) {
    rows.push(...P.parseLine(o, state, { source: "agent-a1.jsonl", meta }));
  }
  const spawn = rows.find((r) => r.type === "spawn");
  assert.ok(spawn);
  assert.ok(!/sonnet/i.test(String(spawn.modelLabel) + String(spawn.modelRaw)));
  // unknown agent type: the line's own model (opus) decides the role, not meta
  const odd = { ...meta, agentType: "Explore", model: "claude-haiku-5-5" };
  const row = P.parseLine(
    {
      type: "assistant",
      isSidechain: true,
      agentId: "zz",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { id: "mz", model: "claude-opus-5-5", content: text, usage: u(1, 1) }
    },
    P.createState(),
    { meta: odd }
  );
  assert.equal(row[0].role, "planner");
});

test("SYNTHETIC: usage that drops then recovers for one message.id is not double counted", () => {
  const state = P.createState();
  const rows = [];
  for (const usage of [u(0, 20), { output_tokens: 5 }, u(0, 20)]) {
    rows.push(...P.parseLine(asst("m1", "claude-opus-5-5", usage, text), state));
  }
  assert.equal(P.usageTotals(state).opus.out, 20);
  assert.equal(
    rows.reduce((n, r) => n + (r.usage ? r.usage.out : 0), 0),
    20
  );
});

const noteWith = (inner) => ({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: "2026-01-01T00:00:00.000Z",
  content: `<task-notification>${inner}</task-notification>`
});

test("SYNTHETIC: notification fields are read from the header and the last usage block only", () => {
  // (i) a result quoting usage tags cannot win over the real usage block
  const a = P.parseTaskNotification(
    noteWith(
      "<tool-use-id>t1</tool-use-id><status>completed</status><result><subagent_tokens>999999</subagent_tokens></result><usage><subagent_tokens>5</subagent_tokens></usage>"
    ).content
  );
  assert.equal(a.subagentTokens, 5);
  // (ii) a missing header status/id is not taken from the result text
  const state = P.createState();
  const rows = P.parseLine(
    noteWith("<tool-use-id>t1</tool-use-id><result>x <status>SECRET RESULT</status></result>"),
    state
  );
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].message.toLowerCase().includes("secret"));
  assert.equal(rows[0].message, "Worker finished · unknown");
  assert.equal(
    P.parseTaskNotification(noteWith("<result><tool-use-id>t9</tool-use-id></result>").content),
    null
  );
  // (iii) an unknown status shows as "unknown" and is length-capped
  const odd = P.parseLine(
    noteWith(`<tool-use-id>t2</tool-use-id><status>${"x".repeat(500)}</status>`),
    state
  )[0];
  assert.equal(odd.statusKnown, false);
  assert.equal(odd.message, "Worker finished · unknown");
  assert.ok(
    P.parseTaskNotification(
      noteWith(`<tool-use-id>t</tool-use-id><status>${"x".repeat(500)}</status>`).content
    ).status.length <= 40
  );
});

test("SYNTHETIC: notification dedupe key is id|status|numbers", () => {
  const state = P.createState();
  const body = (status, tokens) =>
    `<tool-use-id>t1</tool-use-id><status>${status}</status><usage><subagent_tokens>${tokens}</subagent_tokens></usage>`;
  assert.equal(P.parseLine(noteWith(body("completed", 7)), state).length, 1);
  // enqueue, remove and queued_command copies are byte-identical: no new row
  assert.deepEqual(P.parseLine(noteWith(body("completed", 7)), state), []);
  assert.deepEqual(
    P.parseLine(
      {
        type: "queue-operation",
        operation: "remove",
        content: noteWith(body("completed", 7)).content
      },
      state
    ),
    []
  );
  assert.deepEqual(
    P.parseLine(
      {
        type: "attachment",
        attachment: { type: "queued_command", prompt: noteWith(body("completed", 7)).content }
      },
      state
    ),
    []
  );
  // a real second notice with a different status or numbers emits
  assert.equal(P.parseLine(noteWith(body("failed", 7)), state).length, 1);
  assert.equal(P.parseLine(noteWith(body("completed", 8)), state).length, 1);
});

test("SYNTHETIC: WebFetch keeps host and path only; query, fragment and userinfo never reach a row", () => {
  const fetchRows = (url) =>
    P.parseLine(
      asst("mw", "claude-opus-5-5", u(1, 1), [
        { type: "tool_use", id: "w", name: "WebFetch", input: { url, prompt: "SECRET-P" } }
      ]),
      P.createState()
    );
  const rows = fetchRows("https://user:pw@x.test/a?token=SECRET#frag");
  const json = JSON.stringify(rows);
  assert.ok(!json.includes("SECRET") && !json.includes("pw@") && !json.includes("frag"));
  assert.ok(rows[0].message.includes("https://x.test/a"));
  assert.equal(rows[0].activity.path, "https://x.test/a");
  const bad = fetchRows("not a url?token=SECRET");
  assert.ok(!JSON.stringify(bad).includes("SECRET"));
  assert.equal(bad[0].message, "read · WebFetch");
});

test("SYNTHETIC: secrets in url paths (Slack webhook, Telegram bot token) never reach a row", () => {
  const slack = "https://hooks.slack.com/services/T0SECRETA/B0SECRETB/xSECRETCx";
  const tele = "https://api.telegram.org/bot123456789:AAHSECRETTOKEN/sendMessage";
  for (const [url, shown] of [
    [slack, "https://hooks.slack.com/services"],
    [tele, "https://api.telegram.org"]
  ]) {
    for (const name of ["WebFetch", "Read"]) {
      const rows = toolRows(name, { url });
      const json = JSON.stringify(rows);
      assert.ok(!json.includes("SECRET") && !json.includes("123456789"), url);
      assert.ok(!json.includes("B0") && !json.includes("AAH"), url);
      assert.equal(rows[0].activity.path, shown, url);
    }
  }
  // a normal url still shows host and first segment; deeper segments are dropped
  assert.equal(
    toolRows("WebFetch", { url: "https://docs.x.test/guide/intro/part" })[0].activity.path,
    "https://docs.x.test/guide"
  );
  // a segment that is not a plain word (digits, or over 20 characters) is host only
  assert.equal(
    toolRows("WebFetch", { url: "https://x.test/v2/a" })[0].activity.path,
    "https://x.test"
  );
  assert.equal(
    toolRows("WebFetch", { url: "https://x.test/" + "a".repeat(21) + "/b" })[0].activity.path,
    "https://x.test"
  );
  assert.equal(
    toolRows("WebFetch", { url: "https://x.test/" + "a".repeat(20) })[0].activity.path,
    "https://x.test/" + "a".repeat(20)
  );
});

/* ---- round 3: allowlist urls, one-pass notice parsing, remembered child family ---- */

const toolRows = (name, input) =>
  P.parseLine(
    asst("mt", "claude-opus-5-5", u(1, 1), [{ type: "tool_use", id: "x", name, input }]),
    P.createState()
  );

test("SYNTHETIC: only http(s) urls survive; every other scheme gives a bare tool name", () => {
  for (const url of [
    "data:text/plain,SECRETBLOB",
    "data:text/html;base64,U0VDUkVU",
    "javascript:alert('SECRET')",
    "mailto:SECRETUSER@x.test?subject=SECRET",
    "blob:https://x.test/SECRET",
    "about:blank#SECRET",
    "file:///home/SECRET/x",
    "//SECRET"
  ]) {
    const rows = toolRows("WebFetch", { url });
    assert.equal(rows[0].message, "read · WebFetch", url);
    assert.ok(!JSON.stringify(rows).includes("SECRET"), url);
  }
  const ok = toolRows("WebFetch", { url: "http://x.test:8080/a/b?q=SECRET" });
  assert.equal(ok[0].activity.path, "http://x.test:8080/a"); // first path segment only
  const long = toolRows("WebFetch", { url: "https://x.test/" + "a".repeat(500) });
  assert.ok(long[0].activity.path.length <= 120);
});

test("SYNTHETIC: a url key on any tool, any name case, is sanitized before it reaches a row", () => {
  const url = "https://x.test/a?SECRET";
  for (const name of ["webfetch", "WebSearch", "Read", "Grep", "mcp__x__y"]) {
    for (const input of [{ url }, { arguments: { url } }, { file_path: url }, { path: url }]) {
      const rows = toolRows(name, input);
      assert.ok(!JSON.stringify(rows).includes("SECRET"), name + JSON.stringify(input));
    }
  }
  assert.equal(toolRows("WebSearch", { url })[0].activity.path, "https://x.test/a");
  assert.equal(toolRows("Read", { url })[0].activity.path, "https://x.test/a");
  assert.equal(toolRows("webfetch", { url })[0].message, "read · https://x.test/a");
  assert.equal(toolRows("Read", { file_path: "C:\\a\\b.js" })[0].activity.path, "C:\\a\\b.js");
});

const nt = (inner) => P.parseTaskNotification(`<task-notification>${inner}</task-notification>`);

test("SYNTHETIC: usage quoted inside a result is never read, even with no real usage block", () => {
  const a = nt(
    "<tool-use-id>t</tool-use-id><status>completed</status><result><usage><subagent_tokens>999</subagent_tokens></usage></result>"
  );
  assert.equal(a.subagentTokens, 0);
  assert.equal(a.status, "completed");
});

test("SYNTHETIC: quoted usage inside a result loses to the real top-level usage after it", () => {
  const a = nt(
    "<tool-use-id>t</tool-use-id><result>x <usage><subagent_tokens>999</subagent_tokens><tool_uses>9</tool_uses></usage></result><usage><subagent_tokens>5</subagent_tokens><duration_ms>7</duration_ms></usage>"
  );
  assert.equal(a.subagentTokens, 5);
  assert.equal(a.toolUses, 0, "the quoted block does not leak into the real one");
  assert.equal(a.durationMs, 7);
  // two top-level usage blocks: the last wins
  const b = nt(
    "<tool-use-id>t</tool-use-id><usage><subagent_tokens>1</subagent_tokens></usage><usage><subagent_tokens>2</subagent_tokens></usage>"
  );
  assert.equal(b.subagentTokens, 2);
});

test("SYNTHETIC: a result quoting usage AFTER the real usage block cannot replace it", () => {
  const a = nt(
    "<tool-use-id>t</tool-use-id><usage><subagent_tokens>5</subagent_tokens></usage><result><usage><subagent_tokens>999</subagent_tokens></usage></result>"
  );
  assert.equal(a.subagentTokens, 5);
});

test("SYNTHETIC: ids and status inside summary, note or result are ignored", () => {
  for (const block of ["summary", "note", "result"]) {
    const quoted = `<${block}><task-id>FAKE</task-id><tool-use-id>FAKE</tool-use-id><status>completed</status></${block}>`;
    assert.equal(nt(quoted), null, block + " alone gives no id");
    const n = nt(`${quoted}<tool-use-id>real</tool-use-id>`);
    assert.equal(n.toolUseId, "real", block);
    assert.equal(n.taskId, "", block);
    assert.equal(n.status, "", block);
  }
});

test("SYNTHETIC: an unclosed result swallows the rest of the notice", () => {
  const n = nt(
    "<tool-use-id>t</tool-use-id><result>oops <status>completed</status><usage><subagent_tokens>9</subagent_tokens></usage>"
  );
  assert.equal(n.toolUseId, "t");
  assert.equal(n.status, "");
  assert.equal(n.subagentTokens, 0);
  // an unclosed result before the id means there is no id at all
  assert.equal(nt("<result>x<tool-use-id>t</tool-use-id>"), null);
});

test("SYNTHETIC: odd case and reordered top-level tags still read sensibly", () => {
  const n = nt(
    "<USAGE><Subagent_Tokens>4</Subagent_Tokens></USAGE><STATUS> Completed </STATUS><Tool-Use-Id>t9</Tool-Use-Id><task-id>k</task-id><RESULT>q</RESULT>"
  );
  assert.deepEqual(
    [n.toolUseId, n.taskId, n.status, n.subagentTokens],
    ["t9", "k", "completed", 4]
  );
  // a mismatched or malformed tag is not read
  assert.equal(nt("<tool-use-id>t<status>completed</status>"), null);
});

test("SYNTHETIC: a 5 MB notice is parsed in linear time", () => {
  const MB5 = 5 * 1024 * 1024;
  const head = "<tool-use-id>t</tool-use-id><status>completed</status>";
  const shapes = {
    lt: "<".repeat(MB5),
    openStatus: "<status>".repeat(MB5 / 8),
    unclosedResult: head + "<result>" + "<usage>".repeat(MB5 / 7),
    manyUsage: head + "<usage></usage>".repeat(MB5 / 15),
    longValue: "<status>" + "a".repeat(MB5),
    manyResults: "<result>x</result>".repeat(Math.floor(MB5 / 18)) + head,
    halfTags: "<status".repeat(Math.floor(MB5 / 7))
  };
  for (const [name, inner] of Object.entries(shapes)) {
    const t0 = process.hrtime.bigint();
    nt(inner);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // a quadratic walk over 5 MB takes minutes; the slack covers slow CI runners
    assert.ok(ms < 2000, `${name} took ${ms}ms`);
  }
  assert.equal(nt(shapes.manyResults).toolUseId, "t");
});

test("SYNTHETIC: dedupe key cannot be forged by a delimiter inside the id or status", () => {
  const state = P.createState();
  const body = (id, status) => `<tool-use-id>${id}</tool-use-id><status>${status}</status>`;
  // ids are limited to [A-Za-z0-9_-], so a delimiter can only ride in the status
  assert.equal(P.parseLine(noteWith(body("a", "b|c")), state).length, 1);
  assert.equal(P.parseLine(noteWith(body("a-b", "c")), state).length, 1, "no collision");
  assert.equal(P.parseLine(noteWith(body("a", "b")), state).length, 1, "no collision");
  assert.deepEqual(P.parseLine(noteWith(body("a", "b|c")), state), []);
});

test("SYNTHETIC: a notice differing only in durationMs emits a second row", () => {
  const state = P.createState();
  const body = (ms) =>
    `<tool-use-id>t1</tool-use-id><status>completed</status><usage><duration_ms>${ms}</duration_ms></usage>`;
  assert.equal(P.parseLine(noteWith(body(10)), state).length, 1);
  assert.deepEqual(P.parseLine(noteWith(body(10)), state), []);
  assert.equal(P.parseLine(noteWith(body(11)), state).length, 1);
});

/* child family memory */
const child = (agentId, model, id) => ({
  type: "assistant",
  isSidechain: true,
  agentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { id, model, role: "assistant", content: text, usage: u(1, 1) }
});
const agentCall = (id, input) =>
  asst("mp" + id, "claude-opus-5-5", u(1, 1), [
    { type: "tool_use", id, name: "Agent", input: { subagent_type: "Explore", ...input } }
  ]);
const agentResult = (id, agentId, resolvedModel) => ({
  type: "user",
  timestamp: "2026-01-01T00:00:00.000Z",
  toolUseResult: { agentId, ...(resolvedModel ? { resolvedModel } : {}) },
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] }
});
const doneNote = (id) => noteWith(`<tool-use-id>${id}</tool-use-id><status>completed</status>`);

test("SYNTHETIC: Explore child's assistant rows (parsed before its parent) and its notice all say researcher; no spawn line is fed", () => {
  const state = P.createState();
  const meta = { agentType: "Explore", toolUseId: "tE" }; // no model on meta or call
  const rows = [
    ...P.parseLine(child("ag", "claude-haiku-5-5", "m1"), state, { meta }),
    // later rows name no usable model: they use the remembered family (haiku)
    ...P.parseLine(child("ag", "<synthetic>", "m2"), state, { meta }),
    ...P.parseLine(child("ag", undefined, "m3"), state, { meta })
  ];
  P.parseLine(agentCall("tE", {}), state);
  P.parseLine(agentResult("tE", "ag"), state);
  rows.push(...P.parseLine(doneNote("tE"), state));
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.role),
    ["researcher", "researcher", "researcher", "researcher"]
  );
  assert.equal(rows[3].type, "done");
});

test("SYNTHETIC: without a remembered family the same child falls back to worker (what the memory prevents)", () => {
  const state = P.createState();
  const rows = P.parseLine(child("ag", undefined, "m3"), state, {
    meta: { agentType: "Explore", toolUseId: "tE" }
  });
  assert.equal(rows[0].role, "worker");
});

test("SYNTHETIC: the child's own remembered model beats a later resolvedModel; resolvedModel replaces meta and call", () => {
  const state = P.createState();
  const meta = { agentType: "Explore", toolUseId: "tR" };
  P.parseLine(child("ag", "claude-haiku-5-5", "m1"), state, { meta });
  P.parseLine(agentCall("tR", {}), state);
  P.parseLine(agentResult("tR", "ag", "claude-opus-5-5"), state);
  const later = P.parseLine(child("ag", undefined, "m2"), state, { meta });
  assert.equal(later[0].role, "researcher", "own model (haiku) outranks resolvedModel (opus)");
  assert.equal(P.parseLine(doneNote("tR"), state)[0].role, "researcher");
  // no own model yet: resolvedModel replaces the remembered meta model
  const s2 = P.createState();
  const meta2 = { agentType: "Explore", toolUseId: "tQ", model: "claude-haiku-5-5" };
  assert.equal(P.parseLine(childUser("ag2"), s2, { meta: meta2 })[0].role, "researcher");
  P.parseLine(agentCall("tQ", { model: "sonnet" }), s2);
  P.parseLine(agentResult("tQ", "ag2", "claude-opus-5-5"), s2);
  assert.equal(P.parseLine(child("ag2", undefined, "m1"), s2, { meta: meta2 })[0].role, "planner");
  assert.equal(P.parseLine(doneNote("tQ"), s2)[0].role, "planner");
});

test("SYNTHETIC: resolvedModel beats the call's input.model", () => {
  const state = P.createState();
  P.parseLine(agentCall("tM", { model: "haiku" }), state);
  P.parseLine(agentResult("tM", "ag2", "claude-opus-5-5"), state);
  const rows = P.parseLine(child("ag2", undefined, "m1"), state, {
    meta: { agentType: "Explore", toolUseId: "tM" }
  });
  assert.equal(rows[0].role, "planner");
  assert.equal(P.parseLine(doneNote("tM"), state)[0].role, "planner");
  // and with no resolvedModel the call's model is what counts
  const s2 = P.createState();
  P.parseLine(agentCall("tN", { model: "haiku" }), s2);
  assert.equal(P.parseLine(doneNote("tN"), s2)[0].role, "researcher");
});

const childUser = (agentId) => ({
  type: "user",
  isSidechain: true,
  agentId,
  parentUuid: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: "SECRET-PROMPT" }
});

test("SYNTHETIC: spawn row falls back to worker when no model is named; later rows and the notice follow the child's own model", () => {
  const state = P.createState();
  const meta = { agentType: "Explore", toolUseId: "tS" }; // no model on call or meta
  P.parseLine(agentCall("tS", {}), state);
  P.parseLine(agentResult("tS", "ag"), state);
  const rows = [
    ...P.parseLine(childUser("ag"), state, { meta }),
    ...P.parseLine(child("ag", "claude-haiku-5-5", "m1"), state, { meta }),
    ...P.parseLine(child("ag", undefined, "m2"), state, { meta }),
    ...P.parseLine(doneNote("tS"), state)
  ];
  assert.deepEqual(
    rows.map((r) => [r.type, r.role]),
    [
      ["spawn", "worker"],
      ["turn", "researcher"],
      ["turn", "researcher"],
      ["done", "researcher"]
    ]
  );
});

test("SYNTHETIC: a child's own model outranks meta, call and resolvedModel on every row kind", () => {
  const state = P.createState();
  const meta = { agentType: "Explore", toolUseId: "tO", model: "claude-haiku-5-5" };
  // spawn line first: only meta (haiku) is known, so it is remembered at the lowest rank
  const spawn = P.parseLine(childUser("ag"), state, { meta });
  assert.equal(spawn[0].role, "researcher");
  const rows = [
    ...P.parseLine(child("ag", "claude-opus-5-5", "m1"), state, { meta }),
    ...P.parseLine(child("ag", undefined, "m2"), state, { meta }),
    ...P.parseLine(child("ag", "claude-haiku-5-5", "m3"), state, { meta }) // first own sticks
  ];
  P.parseLine(agentCall("tO", { model: "haiku" }), state);
  P.parseLine(agentResult("tO", "ag", "claude-sonnet-5-5"), state);
  rows.push(...P.parseLine(doneNote("tO"), state));
  rows.push(...P.parseLine(child("ag", undefined, "m4"), state, { meta }));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.role),
    // m3 names its own model (haiku) so that one line says researcher; the done notice and
    // the unnamed lines keep the first own model (opus) over meta, call and resolvedModel
    ["planner", "planner", "researcher", "planner", "planner"]
  );
});

test("SYNTHETIC: a placeholder resolvedModel is no value", () => {
  const state = P.createState();
  P.parseLine(agentCall("tI", { model: "haiku" }), state);
  P.parseLine(agentResult("tI", "ag", "inherit"), state);
  assert.equal(state.calls.get("tI").resolvedModel, "");
  assert.equal(P.parseLine(doneNote("tI"), state)[0].role, "researcher");
});

const hidden = (rows) => {
  const j = JSON.stringify(rows);
  assert.ok(!j.includes("SECRET"), j);
};
const JUNK = [" ", "\t", "\u00a0", "\ufeff", "\u0000", '"'];

test("SYNTHETIC: leading junk before a data: or https: value never leaks, on every path key", () => {
  const shapes = [
    ["Read", "file_path"],
    ["Edit", "path"],
    ["WebFetch", "path"],
    ["Bash", "working_directory"]
  ];
  for (const [name, key] of shapes) {
    for (const j of JUNK) {
      const tag = `${name}.${key} ${JSON.stringify(j)}`;
      for (const value of [
        j + "data:text/plain;base64,SECRETBLOB",
        j + "javascript:SECRET",
        j + "data:,SECRETBLOB"
      ]) {
        const rows = toolRows(name, { [key]: value });
        hidden(rows);
        assert.ok(!rows[0].message.includes("data:"), tag);
      }
      const rows = toolRows(name, { [key]: j + "https://x/a?SECRET" });
      hidden(rows);
      assert.equal(rows[0].activity.path, "https://x/a", tag);
      assert.ok(rows[0].message.includes("https://x/a"), tag);
    }
  }
  // other forms: tag-like prefix, embedded scheme after text, arguments wrapper
  hidden(toolRows("Read", { file_path: "<b>data:,SECRET" }));
  hidden(toolRows("Read", { file_path: "see https://x/a?SECRET" }));
  hidden(toolRows("Read", { arguments: { file_path: "\u00a0data:,SECRET" } }));
  hidden(toolRows("Read", { file_path: '"\u0000 \tdata:,SECRET' }));
});

test("SYNTHETIC: ordinary paths still show as paths", () => {
  for (const p of [
    "C:\\x",
    "c:/x/y.js",
    "file.ts:42",
    "src/app.ts:10",
    "src/app.ts:10:5",
    "README.md",
    "\\\\wsl$\\Ubuntu\\home\\x\\a.ts",
    "/home/x/a.ts",
    "./a b.ts"
  ]) {
    const rows = toolRows("Read", { file_path: p });
    assert.equal(rows[0].activity.path, p, p);
    assert.equal(rows[0].message, "read · " + p, p);
  }
  // an odd "word:text", or a colon behind inner junk, is hidden rather than risk a leak
  for (const odd of ["name:SECRET", "x\u0000data:,SECRET", "jav\tascript:SECRET", "wsl$:SECRET"]) {
    const rows = toolRows("Read", { file_path: odd });
    assert.equal(rows[0].message, "read · Read", odd);
    hidden(rows);
  }
});

test("SYNTHETIC: a ?query or #fragment on a colon-free path is cut off", () => {
  for (const [raw, shown] of [
    ["/a/b.js?token=SECRET", "/a/b.js"],
    ["a/b.js#SECRET", "a/b.js"],
    ["a/b?x=1#SECRET", "a/b"]
  ]) {
    const rows = toolRows("Read", { file_path: raw });
    assert.equal(rows[0].activity.path, shown, raw);
    hidden(rows);
  }
});

test("SYNTHETIC: the path check runs on the text the display shows, not the raw value", () => {
  // Tags and edge whitespace are dropped by the display. If the check saw the raw value
  // instead, these would be hidden (":42<b></b>" is no line suffix) and the first two would
  // lose their path.
  for (const [raw, shown] of [
    ["file.ts:42<b></b>", "file.ts:42"],
    ["file.ts:42\u00a0", "file.ts:42"],
    ["<i></i>src/app.ts:10", "src/app.ts:10"]
  ]) {
    const rows = toolRows("Read", { file_path: raw });
    assert.equal(rows[0].activity.path, shown, JSON.stringify(raw));
    assert.equal(rows[0].message, "read · " + shown, JSON.stringify(raw));
  }
  const url = toolRows("WebFetch", { url: "<b></b>https://x/a?SECRET" });
  hidden(url);
  assert.equal(url[0].activity.path, "https://x/a");
});

test("SYNTHETIC: control and bidi characters never reach a label", () => {
  const BAD = [
    "\u0000",
    "\u0007",
    "\u001b",
    "\u007f",
    "\u0085",
    "\u00ad",
    "\u200b",
    "\u200e",
    "\u202a",
    "\u202e",
    "\u2066",
    "\u2069",
    "\u2060",
    "\ufeff"
  ];
  BAD.push(String.fromCharCode(0x180e)); // Mongolian vowel separator
  const clean = (s) => {
    for (const c of BAD) assert.ok(!s.includes(c), JSON.stringify(s));
  };
  for (const c of BAD) {
    const rows = toolRows("Read", { file_path: "src/a" + c + "b.ts" });
    assert.equal(rows[0].activity.path, "src/ab.ts", JSON.stringify(c));
    assert.equal(rows[0].message, "read · src/ab.ts", JSON.stringify(c));
    clean(JSON.stringify(rows).replace(/\\u[0-9a-f]{4}/g, (m) => JSON.parse('"' + m + '"')));
    // an unknown tool name and a subagent type are labels too
    const t = toolRows("Weird" + c + "Tool", { x: 1 });
    assert.equal(t[0].message, "tool · WeirdTool", JSON.stringify(c));
    const spawn = P.parseLine(
      asst("mb", "claude-opus-5-5", u(1, 1), [
        { type: "tool_use", id: "tb", name: "Agent", input: { subagent_type: "wor" + c + "ker" } }
      ]),
      P.createState()
    )[0];
    assert.ok(spawn.message.includes("worker") && !spawn.message.includes(c), JSON.stringify(c));
  }
  // an invisible character cannot split a scheme and sneak past the check
  hidden(toolRows("Read", { file_path: "jav\u200ba\u202escript:SECRET" }));
  hidden(toolRows("Read", { file_path: "da\u0000ta:,SECRET" }));
  // ordinary whitespace controls still fold to a space
  assert.equal(toolRows("Read", { file_path: "a\tb.ts" })[0].activity.path, "a b.ts");
});

test("SYNTHETIC: every code point in each stripped range is removed from a label", () => {
  const RANGES = [
    [0x0, 0x8],
    [0xe, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x206f]
  ];
  let checked = 0;
  for (const [lo, hi] of RANGES) {
    for (let code = lo; code <= hi; code++) {
      const c = String.fromCharCode(code);
      const rows = toolRows("Read", { file_path: "src/a" + c + "b.ts" });
      assert.equal(rows[0].activity.path, "src/ab.ts", code.toString(16));
      assert.equal(rows[0].message, "read · src/ab.ts", code.toString(16));
      checked++;
    }
  }
  assert.equal(checked, 9 + 18 + 33 + 5 + 5 + 16);
});

test("SYNTHETIC: model strings, ids, session and source are sanitized on every row", () => {
  const CODES = [
    0x0, 0x7, 0x1b, 0x7f, 0x85, 0xad, 0x180e, 0x200b, 0x200e, 0x202a, 0x202e, 0x2060, 0x2066,
    0x2069, 0xfeff
  ];
  const bad = new Set(CODES.map((c) => String.fromCharCode(c)));
  const strings = (v, out = []) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
    return out;
  };
  for (const code of CODES) {
    const c = String.fromCharCode(code);
    const tag = code.toString(16);
    const state = P.createState();
    const rows = [
      // an Agent call whose model, id, session and source carry the character
      ...P.parseLine(
        {
          ...agentCall("t" + c + "1", { subagent_type: "worker", model: "x" + c + "evil" }),
          sessionId: "se" + c + "ss"
        },
        state,
        { source: "so" + c + "urce" }
      ),
      // a model that names a family: modelRaw keeps the slug
      ...P.parseLine(agentCall("t2", { model: "my" + c + "opus" }), state)
    ];
    // its result names an agent id and a resolved model; the child's meta names another model
    P.parseLine(agentResult("t2", "ag" + c + "1", "re" + c + "sonnet"), state);
    const meta = { agentType: "Explore", toolUseId: "t2", model: "zz" + c + "haiku" };
    rows.push(...P.parseLine(childUser("ag" + c + "1"), state, { meta }));
    rows.push(...P.parseLine(doneNote("t2"), state));
    assert.equal(rows.length, 4, tag);
    for (const row of rows) {
      for (const s of strings(row)) {
        assert.ok(![...s].some((ch) => bad.has(ch)), tag + " " + JSON.stringify(s));
      }
    }
    // the values stay usable, just without the character
    assert.equal(rows[0].message, "delegates · worker · xevil", tag);
    assert.equal(rows[0].modelLabel, "xevil", tag);
    assert.equal(rows[0].toolUseId, "t1", tag);
    assert.equal(rows[0].sessionId, "sess", tag);
    assert.equal(rows[0].source, "source", tag);
    assert.equal(rows[1].modelRaw, "myopus", tag);
    assert.equal(rows[1].modelLabel, "Opus", tag);
    assert.equal(rows[2].agentId, "ag1", tag);
    assert.equal(rows[2].modelRaw, "resonnet", tag);
    assert.equal(rows[3].agentId, "ag1", tag);
  }
});

test("SYNTHETIC: notice header is first-wins: a later tool-use-id or status cannot replace it", () => {
  const n = nt(
    "<tool-use-id>t</tool-use-id><status>completed</status><result>see </result><tool-use-id>SECRET</tool-use-id><status>failed</status></result>"
  );
  assert.equal(n.toolUseId, "t");
  assert.equal(n.status, "completed");
  const rows = P.parseLine(
    noteWith(
      "<tool-use-id>t</tool-use-id><status>completed</status><result>see </result><tool-use-id>SECRET</tool-use-id><status>failed</status></result>"
    ),
    P.createState()
  );
  hidden(rows);
});

test("SYNTHETIC: notice ids must look like ids; subagent_type is capped; modelRaw needs a known family", () => {
  assert.equal(nt("<tool-use-id>has space</tool-use-id>"), null);
  assert.equal(nt(`<tool-use-id>${"a".repeat(65)}</tool-use-id>`), null);
  assert.equal(nt(`<tool-use-id>${"a".repeat(64)}</tool-use-id>`).toolUseId.length, 64);
  const n = nt("<tool-use-id>toolu_01-A</tool-use-id><task-id>bad id!</task-id>");
  assert.equal(n.toolUseId, "toolu_01-A");
  assert.equal(n.taskId, "");
  const call = (input) =>
    P.parseLine(
      asst("mc", "claude-opus-5-5", u(1, 1), [
        { type: "tool_use", id: "tc", name: "Agent", input }
      ]),
      P.createState()
    )[0];
  const long = call({ subagent_type: "x".repeat(300) });
  assert.ok(long.message.length < 80 && !long.message.includes("x".repeat(60)));
  assert.equal(call({ subagent_type: "Explore", model: "gpt-9-SECRET" }).modelRaw, null);
  assert.equal(call({ subagent_type: "Explore", model: "sonnet" }).modelRaw, "sonnet");
});
