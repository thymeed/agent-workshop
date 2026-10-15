/**
 * Direct unit tests for lib/transcript-parse.js: roles, usage estimates, terminal tags, tool activity.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const parse = require("../../lib/transcript-parse");

const TRANSCRIPTS = path.join(__dirname, "..", "fixtures", "transcripts");
const STAMP = "2026-10-09T14:00:09.000Z";
const UUID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function fixtureRaw(name) {
  return fs.readFileSync(path.join(TRANSCRIPTS, name), "utf8");
}

function fixtureObjects(name) {
  return fixtureRaw(name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function textSignal(text, role = "assistant") {
  return parse.terminalTypeFromTranscript({
    role,
    message: { content: [{ type: "text", text }] }
  });
}

test("nowIso returns a parseable instant close to now", () => {
  const before = Date.now();
  const iso = parse.nowIso();
  const at = Date.parse(iso);
  assert.equal(typeof iso, "string");
  assert.ok(!Number.isNaN(at));
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, iso);
});

test("transcriptTimestamp reads every supported field", () => {
  const shapes = [
    { timestamp: STAMP },
    { ts: STAMP },
    { createdAt: STAMP },
    { created_at: STAMP },
    { message: { timestamp: STAMP } }
  ];
  for (const shape of shapes) {
    assert.equal(parse.transcriptTimestamp(shape), STAMP, JSON.stringify(shape));
  }
  assert.equal(parse.transcriptTimestamp(fixtureObjects("parent-turn.jsonl")[1]), STAMP);
});

test("transcriptTimestamp prefers the first parseable candidate", () => {
  const later = "2027-01-01T00:00:00.000Z";
  assert.equal(
    parse.transcriptTimestamp({
      timestamp: STAMP,
      ts: later,
      createdAt: later,
      message: { timestamp: later }
    }),
    STAMP
  );
  assert.equal(parse.transcriptTimestamp({ ts: later, createdAt: STAMP }), later);
  assert.equal(
    parse.transcriptTimestamp({ createdAt: STAMP, message: { timestamp: later } }),
    STAMP
  );
  assert.equal(parse.transcriptTimestamp({ message: { timestamp: later } }), later);
});

test("transcriptTimestamp skips junk and falls back to now", () => {
  assert.equal(parse.transcriptTimestamp({ timestamp: "not-a-date", createdAt: STAMP }), STAMP);
  assert.equal(parse.transcriptTimestamp({ timestamp: null, ts: "", createdAt: STAMP }), STAMP);
  for (const empty of [{}, null, undefined, STAMP, 42]) {
    const iso = parse.transcriptTimestamp(empty);
    assert.ok(Math.abs(Date.now() - Date.parse(iso)) < 1000, JSON.stringify(empty));
  }
});

test("mapSubagentType maps every known Task type", () => {
  const known = {
    advisor: "advisor",
    ADVISOR: "advisor",
    explore: "explorer",
    explorer: "explorer",
    researcher: "researcher",
    worker: "worker",
    shell: "worker",
    bugbot: "worker",
    "security-review": "worker",
    "ci-investigator": "worker",
    generalPurpose: "worker",
    "general-purpose": "worker",
    agents: "worker",
    "best-of-n-runner": "worker"
  };
  for (const [input, expected] of Object.entries(known)) {
    assert.equal(parse.mapSubagentType(input), expected, input);
  }
  assert.equal(parse.mapSubagentType("  Worker  "), "worker");
});

test("mapSubagentType sends missing types to parent and unknown types to worker", () => {
  for (const missing of ["", "   ", null, undefined]) {
    assert.equal(parse.mapSubagentType(missing), "parent", JSON.stringify(missing));
  }
  assert.equal(parse.mapSubagentType("mystery-agent"), "worker");
  assert.equal(parse.mapSubagentType("Research"), "worker");
});

test("display name, card and model for every role plus parent", () => {
  const rows = [
    ["advisor", "Advisor", "advisor", "fable"],
    ["worker", "Worker", "worker", "sonnet"],
    ["explorer", "Explorer", "explorer", "haiku"],
    ["researcher", "Researcher", "researcher", "haiku"],
    ["parent", "Parent", "opus", "opus"],
    ["mystery", "Parent", "opus", "opus"],
    [undefined, "Parent", "opus", "opus"]
  ];
  for (const [role, name, card, model] of rows) {
    assert.equal(parse.roleDisplayName(role), name, String(role));
    assert.equal(parse.roleToCard(role), card, String(role));
    assert.equal(parse.roleToModel(role), model, String(role));
  }
});

test("inferRoleFromSubagentText reads the structured markers", () => {
  const markers = [
    ['operating as the "advisor" custom subagent', "advisor"],
    ['subagent_type: "explore"', "explorer"],
    ['Task description to exactly "researcher"', "researcher"],
    ['operating as the "mystery-agent" custom subagent', "worker"]
  ];
  for (const [text, role] of markers) {
    assert.equal(parse.inferRoleFromSubagentText(text), role, text);
  }
});

test("inferRoleFromSubagentText reads prompt cues", () => {
  const cues = [
    ["You are the Advisor for this change.", "advisor"],
    ["You are an Implementation worker.", "worker"],
    ["You are a file search specialist.", "explorer"],
    ["Thoroughness: very thorough", "explorer"],
    ["Check the docs and external sources.", "researcher"],
    ["<user_query>Research node:test flags</user_query>", "researcher"],
    ["<user_query>Explore the repo layout</user_query>", "explorer"],
    ["<user_query>Advisor: which route?</user_query>", "advisor"]
  ];
  for (const [text, role] of cues) {
    assert.equal(parse.inferRoleFromSubagentText(text), role, text);
  }
});

test("inferRoleFromSubagentText never falls through to parent", () => {
  for (const blank of ["", null, undefined, "unrecognised preamble"]) {
    assert.equal(parse.inferRoleFromSubagentText(blank), "worker", String(blank));
  }
});

test("each subagent fixture infers its own role", () => {
  const expected = {
    "subagents/advisor.jsonl": "advisor",
    "subagents/worker.jsonl": "worker",
    "subagents/explorer.jsonl": "explorer",
    "subagents/researcher.jsonl": "researcher",
    "subagents/unknown-role.jsonl": "worker"
  };
  for (const [name, role] of Object.entries(expected)) {
    const text = parse.extractText(fixtureObjects(name)[0]);
    assert.ok(text.includes("<user_query>"), name);
    assert.equal(parse.inferRoleFromSubagentText(text), role, name);
  }
});

test("parent turn fixture drives text, usage and tool activity", () => {
  const [user, assistant] = fixtureObjects("parent-turn.jsonl");
  const query = "<user_query>wire the npm script for the new unit tests</user_query>";
  assert.equal(parse.extractText(user), query);

  const tools = parse.extractToolUses(assistant);
  assert.equal(tools.length, 1);
  assert.deepEqual(parse.estimateUsage("parent", assistant, { inText: "a".repeat(9000) }), {
    model: "opus",
    role: "parent",
    in: 18000,
    out: 4200
  });
  assert.deepEqual(parse.toolActivity(tools[0]), {
    kind: "read",
    path: "lib/transcript-parse.js",
    detail: "@1 +80"
  });
});

test("clampTokens clamps at zero and 120000", () => {
  const cases = [
    [0, 0],
    [1, 1],
    [1.4, 1],
    [1.5, 2],
    [119999, 119999],
    [120000, 120000],
    [120001, 120000],
    [1e9, 120000],
    [Number.MAX_VALUE, 120000],
    [-1, 0],
    [-1e9, 0],
    ["abc", 0],
    ["42", 42],
    [null, 0],
    [undefined, 0],
    [NaN, 0],
    [Infinity, 0]
  ];
  for (const [input, expected] of cases) {
    assert.equal(parse.clampTokens(input), expected, String(input));
  }
});

test("charsToTokens rounds length/4 and clamps", () => {
  assert.equal(parse.charsToTokens(""), 0);
  assert.equal(parse.charsToTokens("a"), 0);
  assert.equal(parse.charsToTokens("ab"), 1);
  assert.equal(parse.charsToTokens("abcd"), 1);
  assert.equal(parse.charsToTokens("abcde"), 1);
  assert.equal(parse.charsToTokens("a".repeat(480000)), 120000);
  assert.equal(parse.charsToTokens("a".repeat(500000)), 120000);
  assert.equal(parse.charsToTokens(null), 0);
});

test("estimateUsage prefers transcript usage over the char fallback", () => {
  const spellings = [
    { input_tokens: 5, output_tokens: 7 },
    { inputTokens: 5, outputTokens: 7 },
    { in: 5, out: 7 },
    { prompt_tokens: 5, completion_tokens: 7 }
  ];
  const opts = { inText: "a".repeat(4000), outText: "b".repeat(4000) };
  for (const usage of spellings) {
    const nested = parse.estimateUsage("worker", { message: { usage } }, opts);
    assert.deepEqual(nested, { model: "sonnet", role: "worker", in: 5, out: 7 });
    const flat = parse.estimateUsage("worker", { usage }, opts);
    assert.deepEqual(flat, { model: "sonnet", role: "worker", in: 5, out: 7 });
  }
});

test("estimateUsage falls back to chars/4 when usage is missing or zero", () => {
  const zeroed = { message: { usage: { input_tokens: 0, output_tokens: 0 } } };
  assert.deepEqual(parse.estimateUsage("parent", zeroed, { inChars: 400, outChars: 80 }), {
    model: "opus",
    role: "parent",
    in: 100,
    out: 20
  });
  assert.deepEqual(parse.estimateUsage("parent", {}, { inChars: 400, inText: "a".repeat(4000) }), {
    model: "opus",
    role: "parent",
    in: 100,
    out: 0
  });
  assert.deepEqual(
    parse.estimateUsage("parent", {}, { inText: "a".repeat(400), outText: "b".repeat(40) }),
    { model: "opus", role: "parent", in: 100, out: 10 }
  );
  assert.deepEqual(parse.estimateUsage("parent", { usage: null }, { inChars: 400 }), {
    model: "opus",
    role: "parent",
    in: 100,
    out: 0
  });
  assert.deepEqual(parse.estimateUsage("parent", null), {
    model: "opus",
    role: "parent",
    in: 0,
    out: 0
  });
  assert.deepEqual(parse.estimateUsage(undefined, {}), {
    model: "opus",
    role: "parent",
    in: 0,
    out: 0
  });
});

test("estimateUsage clamps the fallback and reports model/role", () => {
  const big = parse.estimateUsage("explorer", {}, { inChars: 1e7, outChars: 1e7 });
  assert.deepEqual(big, { model: "haiku", role: "explorer", in: 120000, out: 120000 });
  assert.deepEqual(Object.keys(parse.estimateUsage("researcher", {})), [
    "model",
    "role",
    "in",
    "out"
  ]);
});

test("terminalTypeFromTranscript keys off structured tags", () => {
  const [done, errored, prose] = fixtureObjects("terminal-signals.jsonl");
  assert.equal(parse.terminalTypeFromTranscript(done), "done");
  assert.equal(parse.terminalTypeFromTranscript(errored), "error");
  assert.equal(parse.terminalTypeFromTranscript(prose), null);
});

test("terminalTypeFromTranscript ignores loose error/done words", () => {
  assert.equal(textSignal("the test failed with an error, but we are done"), null);
  assert.equal(textSignal("</final>"), "done");
  assert.equal(textSignal("<FINAL>ok</FINAL>"), "done");
  assert.equal(textSignal("</error>"), "error");
  assert.equal(textSignal("<error>boom</error> then <final>later</final>"), "error");
  assert.equal(textSignal("<final>ok</final>", "user"), null);
  assert.equal(
    parse.terminalTypeFromTranscript({
      message: { content: [{ type: "text", text: "<final>ok</final>" }] }
    }),
    null
  );
  assert.equal(parse.terminalTypeFromTranscript(null), null);
});

test("extractText joins only text parts", () => {
  const obj = {
    message: {
      content: [
        { type: "text", text: "one" },
        { type: "tool_use", name: "Read" },
        { type: "text", text: "two" },
        { type: "text" },
        { type: "text", text: "" }
      ]
    }
  };
  assert.equal(parse.extractText(obj), "one\ntwo");
  assert.equal(parse.extractText({ message: { content: "one" } }), "");
  assert.equal(parse.extractText({}), "");
});

test("extractToolUses and extractToolResults split by part type", () => {
  const obj = {
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.js" } },
        { type: "tool_result", tool_use_id: "t1", content: "body" },
        { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "p" } }
      ]
    }
  };
  assert.deepEqual(
    parse.extractToolUses(obj).map((part) => part.id),
    ["t1", "t2"]
  );
  assert.deepEqual(
    parse.extractToolResults(obj).map((part) => part.tool_use_id),
    ["t1"]
  );
  assert.deepEqual(parse.extractToolUses({}), []);
  assert.deepEqual(parse.extractToolResults({ message: {} }), []);
});

test("snippet collapses markup and splits at the max boundary", () => {
  const cases = [
    ["", 10, ""],
    [null, 10, ""],
    ["  a\n\n  b  ", 10, "a b"],
    ["<b>hi</b> there", 10, "hi there"],
    ["abcd", 4, "abcd"],
    ["abcde", 4, "abc…"],
    ["abcde", 1, "…"]
  ];
  for (const [input, max, expected] of cases) {
    assert.equal(parse.snippet(input, max), expected, JSON.stringify(input));
  }
  const long = parse.snippet("z".repeat(200), 40);
  assert.equal(long.length, 40);
  assert.equal(long.endsWith("…"), true);
});

test("activityPath prefers known path keys and truncates", () => {
  assert.equal(parse.activityPath({ file_path: "a.js" }), "a.js");
  assert.equal(parse.activityPath({ path: "a.js", file_path: "b.js" }), "a.js");
  assert.equal(parse.activityPath({ target_directory: "lib" }), "lib");
  assert.equal(parse.activityPath({ working_directory: "C:\\repo" }), "C:\\repo");
  assert.equal(parse.activityPath({ url: "https://example.com" }), "https://example.com");
  assert.equal(parse.activityPath({}), "");
  assert.equal(parse.activityPath(null), "");
  const long = parse.activityPath({ path: "p".repeat(400) });
  assert.equal(long.length, 120);
  assert.equal(long.endsWith("…"), true);
});

test("toolActivity maps each tool family to kind, path and short detail", () => {
  const cases = [
    [
      { name: "Read", input: { file_path: "lib/a.js", offset: 10, limit: 20 } },
      { kind: "read", path: "lib/a.js", detail: "@10 +20" }
    ],
    [
      { name: "Read", input: { file_path: "lib/a.js" } },
      { kind: "read", path: "lib/a.js", detail: "read" }
    ],
    [
      { name: "WebFetch", input: { url: "https://example.com" } },
      { kind: "read", path: "https://example.com", detail: "fetch" }
    ],
    [
      { name: "Grep", input: { path: "lib", pattern: "snippet" } },
      { kind: "search", path: "lib", detail: "snippet" }
    ],
    [
      { name: "Glob", input: { glob_pattern: "**/*.js" } },
      { kind: "search", path: "", detail: "**/*.js" }
    ],
    [
      { name: "Glob", input: { glob: "*.jsonl" } },
      { kind: "search", path: "", detail: "*.jsonl" }
    ],
    [
      { name: "WebSearch", input: { search_term: "node test runner" } },
      { kind: "search", path: "", detail: "node test runner" }
    ],
    [
      { name: "WebSearch", input: { query: "node --test" } },
      { kind: "search", path: "", detail: "node --test" }
    ],
    [
      { name: "GetDynamicTools", input: { namespace: "repo" } },
      { kind: "search", path: "", detail: "repo" }
    ],
    [
      { name: "GetDynamicTools", input: {} },
      { kind: "search", path: "", detail: "tools" }
    ],
    [
      { name: "Write", input: { file_path: "a.js" } },
      { kind: "edit", path: "a.js", detail: "edited" }
    ],
    [
      { name: "Edit", input: { file_path: "a.js" } },
      { kind: "edit", path: "a.js", detail: "edited" }
    ],
    [
      { name: "EditNotebook", input: { file_path: "n.ipynb" } },
      { kind: "edit", path: "n.ipynb", detail: "edited" }
    ],
    [
      { name: "Shell", input: { command: "node --test test/unit/" } },
      { kind: "run", path: "", detail: "node --test test/unit/" }
    ],
    [
      { name: "Shell", input: { cmd: "npm run lint", working_directory: "C:\\repo" } },
      { kind: "run", path: "C:\\repo", detail: "npm run lint" }
    ],
    [
      { name: "AwaitShell", input: { command: "echo hi" } },
      { kind: "run", path: "", detail: "echo hi" }
    ]
  ];
  for (const [tool, expected] of cases) {
    assert.deepEqual(
      parse.toolActivity(tool),
      expected,
      tool.name + " " + JSON.stringify(tool.input)
    );
  }
  assert.equal(parse.toolActivity({ name: "Frobnicate", input: { path: "a.js" } }), null);
  assert.equal(parse.toolActivity(null), null);
});

test("resolveToolName and toolArgs unwrap CallDynamicTool arguments", () => {
  const tool = {
    name: "CallDynamicTool",
    input: { toolName: "Grep", arguments: { pattern: "fixture", path: "test/fixtures" } }
  };
  assert.equal(parse.resolveToolName(tool), "Grep");
  assert.deepEqual(parse.toolArgs(tool), { pattern: "fixture", path: "test/fixtures" });
  assert.deepEqual(parse.toolActivity(tool), {
    kind: "search",
    path: "test/fixtures",
    detail: "fixture"
  });
  assert.equal(
    parse.resolveToolName({ name: "CallDynamicTool", input: { toolName: "Task" } }),
    "Task"
  );
  assert.equal(parse.resolveToolName({}), "");
  assert.deepEqual(parse.toolArgs({ name: "Read" }), {});
});

test("toolActivity never echoes a file body", () => {
  const [writeLine, replaceLine, shellLine] = fixtureObjects("tool-edit.jsonl");
  assert.equal(fixtureRaw("tool-edit.jsonl").includes("FIXTURE_BODY_MARKER"), true);

  const write = parse.toolActivity(parse.extractToolUses(writeLine)[0]);
  assert.deepEqual(write, {
    kind: "edit",
    path: "test/unit/transcript-parse.test.js",
    detail: "edited"
  });
  assert.equal(JSON.stringify(write).includes("FIXTURE_BODY_MARKER"), false);

  const replace = parse.toolActivity(parse.extractToolUses(replaceLine)[0]);
  assert.deepEqual(replace, {
    kind: "edit",
    path: "test/unit/transcript-tail.test.js",
    detail: "edited"
  });
  assert.equal(JSON.stringify(replace).includes("toBeReplaced"), false);

  assert.deepEqual(parse.toolActivity(parse.extractToolUses(shellLine)[0]), {
    kind: "run",
    path: "C:\\repo",
    detail: "node --test test/unit/"
  });
});

test("toolEstimateChars measures write bodies and caps them", () => {
  assert.equal(parse.toolEstimateChars(null), 0);
  assert.equal(
    parse.toolEstimateChars({
      name: "Write",
      input: { file_path: "a.js", contents: "x".repeat(500) }
    }),
    500
  );
  assert.equal(
    parse.toolEstimateChars({ name: "Write", input: { contents: "x".repeat(500000) } }),
    480000
  );
  assert.equal(
    parse.toolEstimateChars({ name: "StrReplace", input: { new_string: "y".repeat(120) } }),
    120
  );
  assert.equal(
    parse.toolEstimateChars({ name: "Edit", input: { old_string: "z".repeat(30) } }),
    30
  );
  assert.equal(
    parse.toolEstimateChars({ name: "EditNotebook", input: { newString: "w".repeat(60) } }),
    60
  );
  assert.equal(
    parse.toolEstimateChars({
      name: "CallDynamicTool",
      input: { toolName: "Write", arguments: { contents: "x".repeat(300) } }
    }),
    300
  );
  const shell = parse.toolEstimateChars({ name: "Shell", input: { command: "c".repeat(50000) } });
  assert.ok(shell > 0 && shell < 1000, "shell estimate " + shell);
});

test("onceUsage hands the payload out exactly once", () => {
  const payload = { model: "opus", role: "parent", in: 1, out: 2 };
  const take = parse.onceUsage(payload);
  assert.equal(take(), payload);
  assert.equal(take(), null);
  assert.equal(take(), null);
  const missing = parse.onceUsage(null);
  assert.equal(missing(), null);
  assert.equal(missing(), null);
});

test("estimateReadTokens floors at 800 and caps at 120000", () => {
  assert.equal(parse.estimateReadTokens(""), 800);
  assert.equal(parse.estimateReadTokens("a".repeat(400)), 800);
  assert.equal(parse.estimateReadTokens("a".repeat(3200)), 800);
  assert.equal(parse.estimateReadTokens("a".repeat(3204)), 801);
  assert.equal(parse.estimateReadTokens("a".repeat(1000000)), 120000);
  assert.equal(parse.estimateReadTokens(null), 800);
});

test("filesFromActivity extracts paths and drops the rest", () => {
  assert.deepEqual(parse.filesFromActivity([{ path: "a.js" }, { detail: "x" }, { path: "b.js" }]), [
    "a.js",
    "b.js"
  ]);
  assert.deepEqual(parse.filesFromActivity({ path: "a.js", detail: "x" }), ["a.js"]);
  assert.deepEqual(parse.filesFromActivity({ detail: "x" }), []);
  assert.deepEqual(parse.filesFromActivity({ path: "" }), []);
  assert.deepEqual(parse.filesFromActivity([]), []);
  assert.deepEqual(parse.filesFromActivity(null), []);
  assert.deepEqual(parse.filesFromActivity([{ path: 7 }]), ["7"]);
});

test("agentIdFromFile and isSubagentFile separate parent from subagent files", () => {
  const posix = "sessions/s1/subagents/" + UUID + ".jsonl";
  assert.equal(parse.isSubagentFile(posix), true);
  assert.equal(parse.isSubagentFile("sessions/s1/transcript.jsonl"), false);
  assert.equal(parse.isSubagentFile(path.join(TRANSCRIPTS, "subagents", "advisor.jsonl")), true);
  assert.equal(parse.isSubagentFile(path.join(TRANSCRIPTS, "parent-turn.jsonl")), false);
  assert.equal(parse.agentIdFromFile(posix, "worker"), UUID);
  assert.equal(parse.agentIdFromFile("sessions/s1/subagents/plain.jsonl"), "plain");
  assert.equal(parse.agentIdFromFile("sessions/s1/transcript.jsonl"), "parent:parent");
  assert.equal(parse.agentIdFromFile("sessions/s1/transcript.jsonl", "worker"), "parent:worker");
  assert.equal(
    parse.agentIdFromFile(path.join(TRANSCRIPTS, "subagents", "advisor.jsonl"), "advisor"),
    "advisor"
  );

  // agentIdFromFile strips with the host separator, so a backslash path only resolves on Windows.
  const windows = "C:\\sessions\\s1\\subagents\\" + UUID + ".jsonl";
  assert.equal(parse.isSubagentFile(windows), true);
  assert.equal(
    parse.agentIdFromFile(windows, "worker"),
    process.platform === "win32" ? UUID : windows.slice(0, -".jsonl".length)
  );
});

test("resolveTaskChildAgentId accepts only 36-character uuids", () => {
  for (const key of ["subagent_id", "subagentId", "agent_id", "agentId", "id"]) {
    assert.equal(parse.resolveTaskChildAgentId({ [key]: UUID }, null), UUID, key);
  }
  for (const key of ["subagent_id", "subagentId", "id"]) {
    assert.equal(parse.resolveTaskChildAgentId(null, { [key]: UUID }), UUID, key);
  }
  assert.equal(parse.resolveTaskChildAgentId({ id: UUID.toUpperCase() }, null), UUID.toUpperCase());
  assert.equal(parse.resolveTaskChildAgentId({ subagent_id: "  " + UUID + "  " }, null), UUID);
  assert.equal(parse.resolveTaskChildAgentId({ subagent_id: UUID }, { id: "copy-1" }), UUID);
  for (const bad of [
    "copy-1",
    UUID.slice(0, 35),
    UUID + "0",
    "g".repeat(36),
    "",
    null,
    undefined
  ]) {
    assert.equal(parse.resolveTaskChildAgentId({ subagent_id: bad }, null), null, String(bad));
  }
  assert.equal(parse.resolveTaskChildAgentId(null, null), null);
});

test("malformed fixture stays malformed line by line", () => {
  const raw = fixtureRaw("malformed.jsonl");
  assert.equal(raw.endsWith("\n"), false);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  assert.equal(lines.length, 3);
  assert.equal(parse.extractText(JSON.parse(lines[0])).includes("<user_query>"), true);
  assert.throws(() => JSON.parse(lines[1]), SyntaxError);
  assert.throws(() => JSON.parse(lines[2]), SyntaxError);
});
