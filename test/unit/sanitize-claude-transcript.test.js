/**
 * Tests for scripts/sanitize-claude-transcript.js: builds a session full of planted
 * names and paths, runs the real CLI, and checks nothing planted survives while the
 * ids, links and shapes that the fixtures rely on do. Temp files live in the
 * gitignored <repo>/.scratch/ (never the system temp dir) and are removed afterwards.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");

const REPO = path.join(__dirname, "..", "..");
const { MODEL_RE } = require("../../scripts/sanitize-claude-transcript.js");
const SCRIPT = path.join(REPO, "scripts", "sanitize-claude-transcript.js");
const SCRATCH = path.join(REPO, ".scratch");
const WORK = path.join(SCRATCH, `sanitize-test-${process.pid}`);

// Every planted token must be absent from all output.
const SECRET = "secret" + "proj";
const ZQ = "zq" + "secret"; // planted in keys, models, tags and attachment maps
const PLANTED = [
  SECRET,
  ZQ,
  "bob",
  "README",
  "agentreal1",
  "real-sess-1",
  "toolu_realcall",
  "msg_realmsg",
  "bob-custom-model",
  "host.example"
];

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION = "11111111-2222-4333-8444-555555555555";
const TS = (s) => new Date(Date.parse("2025-05-05T10:00:00Z") + s * 1000).toISOString();
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const base = (n, parent, extra) => ({
  parentUuid: parent === null ? null : UUID(parent),
  isSidechain: false,
  uuid: UUID(n),
  timestamp: TS(n),
  sessionId: SESSION,
  cwd: "C:\\Users\\bob\\" + SECRET,
  ...extra
});
const jl = (objs) => objs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n");

const notificationBlock = (status) =>
  [
    "<task-notification>",
    "<task-id>agentreal1</task-id>",
    "<tool-use-id>toolu_realcall</tool-use-id>",
    "<output-file>/home/bob/out.txt</output-file>",
    `<status>${status}</status>`,
    `<summary>${SECRET} done</summary>`,
    "<result>secret result</result>",
    "<usage><subagent_tokens>123</subagent_tokens><tool_uses>4</tool_uses></usage>",
    "</task-notification>"
  ].join("\n");

function sha(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}
function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(f, out);
    else out.push(f);
  }
  return out;
}
const readJsonl = (f) =>
  fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function buildInput(dir) {
  const proj = path.join(dir, "proj");
  const sub = path.join(proj, "sess1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const parentLines = [
    base(1, null, {
      type: "user",
      status: `${SECRET} status text`,
      "README.md": 1,
      ZQSECRET: { path: "p", command: "c" }, // unknown top-level key; known-looking names below it
      [`${ZQ}_shared`]: 1, // the same data key reappears in the subagent file
      counts: { [SECRET]: 3 },
      snapshot: { trackedFileBackups: { "src/secret.js": { version: 1 }, README: { version: 2 } } },
      message: { role: "user", content: `read /home/bob/${SECRET}/README.md` }
    }),
    base(2, 1, {
      type: "assistant",
      message: {
        id: "msg_realmsg1",
        role: "assistant",
        model: "bob-custom-model",
        stop_reason: SECRET,
        usage: { input_tokens: 5, output_tokens: 7 },
        content: [
          toolUse("toolu_realcall", "Agent", {
            subagent_type: SECRET + "-reviewer",
            description: `review ${SECRET}`,
            prompt: "see /home/bob/x"
          }),
          toolUse("toolu_planner", "Agent", { subagent_type: "planner", prompt: "p" }),
          toolUse("toolu_docs", "mcp__claude_ai_Claude_Docs__guide", { items: ["a"] }),
          toolUse("toolu_mcp", `mcp__${SECRET}-db__query`, { [`${SECRET}_key`]: "v", "a.b": 1 }),
          toolUse("toolu_own", "BobOnlyTool", { q: "x" }),
          // a built-in tool with an extra, unknown input key
          toolUse("toolu_bash", "Bash", { command: "ls", [`${ZQ}bashkey`]: 1 })
        ]
      }
    }),
    // a second line for the same message.id (Claude Code writes one line per block)
    base(3, 2, {
      type: "assistant",
      message: {
        id: "msg_realmsg1",
        role: "assistant",
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 5, output_tokens: 7 },
        content: [{ type: "text", text: `hello ${SECRET}` }]
      }
    }),
    // five tool_result blocks in one user message: none may be cut
    base(4, 3, {
      type: "user",
      message: {
        role: "user",
        content: ["toolu_realcall", "toolu_planner", "toolu_docs", "toolu_edit", "toolu_bash"].map(
          (id) => ({ type: "tool_result", tool_use_id: id, content: `out of ${SECRET}` })
        )
      },
      toolUseResult: {
        status: "async_launched",
        agentId: "agentreal1",
        resolvedModel: "claude-opus-5-5",
        outputFile: "/home/bob/o.txt",
        lines: [1, 2, 3, 4, 5]
      }
    }),
    // the tag inside a tool_result / Bash command must NOT become a fabricated block
    base(5, 4, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bash",
            content: `<task-notification>\n<status>completed</status>\n${SECRET}\n</task-notification>`
          }
        ]
      },
      toolUseResult: { stdout: notificationBlock("completed") }
    }),
    base(6, 5, {
      type: "assistant",
      message: {
        id: "msg_realmsg2",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [
          toolUse("toolu_edit", "Edit", {
            old_string: notificationBlock("completed"),
            new_string: "x"
          })
        ]
      }
    }),
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: TS(7),
      sessionId: SESSION,
      content: notificationBlock("completed")
    },
    {
      type: "attachment",
      parentUuid: UUID(6),
      uuid: UUID(8),
      timestamp: TS(8),
      sessionId: SESSION,
      attachment: { type: "queued_command", prompt: notificationBlock("completed") }
    },
    // a very large line
    base(9, 8, {
      type: "user",
      message: { role: "user", content: `${SECRET} `.repeat(30000) }
    }),
    // planted slugs, an MCP result full of data keys, an attachment map, a hostile usage tag
    base(11, 9, {
      type: "assistant",
      message: {
        id: "msg_realmsg3",
        role: "assistant",
        model: `claude-${ZQ}-internal`,
        content: [
          toolUse("toolu_zq", `mcp__${ZQ}__q`, { a: 1 }),
          toolUse("toolu_ag2", "Agent", {
            subagent_type: "planner",
            model: `claude-${ZQ}`,
            prompt: "p"
          }),
          toolUse("toolu_ag3", "Agent", { subagent_type: "planner", model: "haiku", prompt: "p" })
        ]
      }
    }),
    base(12, 11, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_zq", content: "x" }]
      },
      toolUseResult: {
        status: "completed",
        structuredContent: { [`${ZQ}_customers`]: { [`${ZQ}_row`]: 1 } },
        mcpMeta: { [`${ZQ}meta`]: 1 }
      }
    }),
    {
      type: "attachment",
      uuid: UUID(13),
      timestamp: TS(13),
      sessionId: SESSION,
      attachment: { type: "skill_listing", skills: { [`${ZQ}-skill`]: { name: "x" } } }
    },
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: TS(14),
      sessionId: SESSION,
      content: notificationBlock("completed").replace(
        "<tool_uses>4</tool_uses>",
        `<tool_uses>4</tool_uses><${ZQ}>5</${ZQ}>`
      )
    },
    {
      type: "pr-link",
      sessionId: SESSION,
      prNumber: 4242,
      prRepository: "o/r",
      prUrl: "https://host.example/o/r/pull/4242"
    },
    // a cut-off last line (no closing, no newline)
    '{"type":"user","uuid":"' + UUID(10) + '","message":{"role":"user","content":"/home/bob/cu'
  ];
  fs.writeFileSync(path.join(proj, "sess1.jsonl"), jl(parentLines));

  const subLines = [
    {
      ...base(21, null, {
        type: "user",
        isSidechain: true,
        agentId: "agentreal1",
        [`${ZQ}_shared`]: 1,
        message: { role: "user", content: `do ${SECRET}` }
      })
    },
    {
      ...base(22, 21, {
        type: "assistant",
        isSidechain: true,
        agentId: "agentreal1",
        message: {
          id: "msg_realmsg9",
          role: "assistant",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 1, output_tokens: 3 },
          content: [{ type: "text", text: "a" }]
        }
      })
    },
    {
      ...base(23, 22, {
        type: "assistant",
        isSidechain: true,
        agentId: "agentreal1",
        message: {
          id: "msg_realmsg9",
          role: "assistant",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 1, output_tokens: 90 },
          content: [{ type: "text", text: "b" }]
        }
      })
    }
  ];
  fs.writeFileSync(path.join(sub, "agent-agentreal1.jsonl"), jl(subLines) + "\n");
  fs.writeFileSync(
    path.join(sub, "agent-agentreal1.meta.json"),
    JSON.stringify({
      agentType: SECRET + "-reviewer",
      description: `desc ${SECRET}`,
      toolUseId: "toolu_realcall",
      model: "bob-custom-model"
    })
  );
  return path.join(proj, "sess1.jsonl");
}

const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: REPO });

let input;
let out1;
let out2;
let inputShas;
let result1;

before(() => {
  fs.mkdirSync(WORK, { recursive: true });
  input = buildInput(path.join(WORK, "in"));
  inputShas = listFiles(path.join(WORK, "in")).map((f) => [f, sha(f)]);
  out1 = path.join(WORK, "out1");
  out2 = path.join(WORK, "out2");
  result1 = run(["--session", input, "--out", out1, "--proj", "neutral", "--name", "s1"]);
  run(["--session", input, "--out", out2, "--proj", "neutral", "--name", "s1"]);
});

after(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
  try {
    fs.rmdirSync(SCRATCH); // only if nothing else lives there
  } catch {
    /* not empty or already gone */
  }
});

const outParent = () => path.join(out1, "neutral", "s1.jsonl");
const outSubDir = () => path.join(out1, "neutral", "s1", "subagents");

test("the run succeeds, reports the cut-off line it dropped, and leaves the input byte-identical", () => {
  assert.equal(result1.status, 0, result1.stderr);
  assert.match(result1.stdout, /dropped 1 unparseable input line\(s\)/);
  for (const [f, h] of inputShas) assert.equal(sha(f), h, f);
});

test("no planted name, path, id or model survives anywhere in the output", () => {
  for (const f of listFiles(out1)) {
    const text = fs.readFileSync(f, "utf8");
    for (const tok of PLANTED) {
      assert.ok(!text.toLowerCase().includes(tok.toLowerCase()), `${tok} survived in ${f}`);
    }
    assert.ok(!/Users|home\/|\\\\/.test(text), `path-like text in ${f}`);
  }
});

test("allowlisted fields are checked against known sets", () => {
  const lines = readJsonl(outParent());
  assert.equal(lines[0].status, "S1");
  const asst = lines[1].message;
  assert.equal(asst.model, "S1");
  assert.equal(asst.stop_reason, "S1");
  const [reviewer, planner, docs, mcp, own] = asst.content;
  assert.equal(reviewer.input.subagent_type, "custom-1");
  assert.equal(planner.input.subagent_type, "planner");
  assert.equal(reviewer.name, "Agent");
  assert.equal(docs.name, "mcp__claude_ai_Claude_Docs__guide");
  assert.match(mcp.name, /^mcp__s1__[0-9a-f]{12}$/);
  assert.equal(own.name, "custom-tool-1");
  assert.equal(lines[2].message.model, "claude-sonnet-5-5");
  assert.equal(lines[3].toolUseResult.status, "async_launched");
  assert.equal(lines[3].toolUseResult.resolvedModel, "claude-opus-5-5");
  const meta = JSON.parse(fs.readFileSync(path.join(outSubDir(), "agent-a1.meta.json"), "utf8"));
  assert.equal(meta.agentType, "custom-1", "same custom name maps the same way within a run");
  assert.equal(meta.model, "S1");
});

test("keys: data-keyed maps, dotted keys and unknown-tool input keys are hashed", () => {
  const lines = readJsonl(outParent());
  assert.deepEqual(
    Object.keys(lines[0].counts).map((k) => k.startsWith("k_")),
    [true]
  );
  assert.ok(!("README.md" in lines[0]));
  assert.ok(Object.keys(lines[0]).some((k) => k.startsWith("k_")));
  for (const k of Object.keys(lines[0].snapshot.trackedFileBackups)) assert.match(k, /^k_/);
  const mcp = lines[1].message.content[3];
  for (const k of Object.keys(mcp.input)) assert.match(k, /^k_/);
  // ordinary structural keys stay
  assert.ok("usage" in lines[1].message && "isSidechain" in lines[1]);
});

test("ids are hashed with a per-run salt, not a fixed one", () => {
  const a = readJsonl(outParent());
  const b = readJsonl(path.join(out2, "neutral", "s1.jsonl"));
  assert.notEqual(a[0].uuid, UUID(1));
  assert.match(a[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a[0].uuid, b[0].uuid, "two runs must not produce the same ids");
  assert.notEqual(a[0].sessionId, b[0].sessionId);
  // not the old fixed-salt digest either
  const old = crypto
    .createHash("sha1")
    .update("fixture-salt:" + UUID(1))
    .digest("hex");
  assert.ok(!a[0].uuid.startsWith(old.slice(0, 8)));
});

test("ids link across the parent, subagent and meta files", () => {
  const parent = readJsonl(outParent());
  const sub = readJsonl(path.join(outSubDir(), "agent-a1.jsonl"));
  const meta = JSON.parse(fs.readFileSync(path.join(outSubDir(), "agent-a1.meta.json"), "utf8"));
  const call = parent[1].message.content[0];
  assert.equal(meta.toolUseId, call.id);
  assert.equal(parent[3].message.content[0].tool_use_id, call.id);
  assert.equal(parent[3].toolUseResult.agentId, "a1");
  assert.equal(sub[0].agentId, "a1");
  assert.equal(sub[0].sessionId, parent[0].sessionId);
  // parent chain and repeated message ids survive
  assert.equal(parent[1].parentUuid, parent[0].uuid);
  assert.equal(parent[1].message.id, parent[2].message.id);
  assert.equal(sub[1].message.id, sub[2].message.id);
  assert.equal(sub[1].parentUuid, sub[0].uuid);
  assert.notEqual(sub[1].message.usage.output_tokens, sub[2].message.usage.output_tokens);
});

test("message.content arrays are not cut; other arrays are cut to 3", () => {
  const parent = readJsonl(outParent());
  assert.equal(parent[3].message.content.length, 5);
  assert.deepEqual(
    parent[3].message.content.map((b) => b.type),
    Array(5).fill("tool_result")
  );
  assert.equal(parent[3].toolUseResult.lines.length, 3);
});

test("task-notification blocks are rebuilt only in their carriers (finding 8)", () => {
  const parent = readJsonl(outParent());
  const tag = "<task-notification>";
  const q = parent.find((o) => o.type === "queue-operation");
  const att = parent.find((o) => o.type === "attachment");
  for (const c of [q.content, att.attachment.prompt]) {
    assert.ok(c.startsWith(tag));
    assert.match(c, /<status>completed<\/status>/);
    assert.match(c, /<subagent_tokens>123<\/subagent_tokens>/);
    assert.match(c, /<summary>S1<\/summary>/);
    assert.ok(c.includes(`<tool-use-id>${parent[1].message.content[0].id}</tool-use-id>`));
  }
  // everywhere else the tag is just a string, so it becomes the placeholder
  assert.equal(parent[4].message.content[0].content, "S1");
  assert.equal(parent[4].toolUseResult.stdout, "S1");
  assert.equal(parent[5].message.content[0].input.old_string, "S1");
  const all = parent.filter((o) => JSON.stringify(o).includes(tag));
  assert.deepEqual(all.map((o) => o.type).sort(), [
    "attachment",
    "queue-operation",
    "queue-operation"
  ]);
});

test("model slugs: only real families survive; claude-<planted> becomes S1", () => {
  const parent = readJsonl(outParent());
  const zq = parent[9];
  assert.equal(zq.message.model, "S1");
  const [, agent2, agent3] = zq.message.content;
  assert.equal(agent2.input.model, "S1");
  assert.equal(agent3.input.model, "haiku");
  for (const slug of [
    "claude-opus-4-8",
    "claude-haiku-4-5-20251001",
    "claude-fable-1",
    "inherit"
  ]) {
    assert.ok(MODEL_RE.test(slug), slug);
  }
  for (const slug of ["claude-zqsecret", "claude-opus", "claude-opus-4-x", "claude-opus-4-8-foo"]) {
    assert.ok(!MODEL_RE.test(slug), slug);
  }
});

test("task-notification usage keeps only the four known numeric tags", () => {
  const parent = readJsonl(outParent());
  const qs = parent.filter((o) => o.type === "queue-operation");
  assert.match(qs[0].content, /<usage><subagent_tokens>123<\/subagent_tokens>/);
  assert.match(qs[1].content, /<usage><\/usage>/, "a usage block with an unknown tag is emptied");
});

test("pr-link keeps its shape but the PR number is zeroed", () => {
  const pr = readJsonl(outParent()).find((o) => o.type === "pr-link");
  assert.equal(pr.prNumber, 0);
  assert.equal(pr.prRepository, "S1");
});

test("keys are an allowlist: planted keys at every depth become k_<12 hex>", () => {
  const parent = readJsonl(outParent());
  const sub = readJsonl(path.join(outSubDir(), "agent-a1.jsonl"));
  const K = /^k_[0-9a-f]{12}$/;
  // unknown top-level key, case preserved in the input
  assert.ok(!("ZQSECRET" in parent[0]));
  // the unknown key's subtree is opaque even where a child name is a known key
  const unknown = Object.entries(parent[0]).find(
    ([k, v]) => K.test(k) && v && typeof v === "object"
  );
  assert.ok(unknown, "the planted object under an unknown key");
  for (const k of Object.keys(unknown[1])) assert.match(k, K);
  assert.equal(Object.keys(unknown[1]).length, 2);
  // extra key in a built-in tool's input; the known one stays
  const bash = parent[1].message.content[5];
  assert.equal(bash.name, "Bash");
  assert.ok("command" in bash.input);
  assert.equal(Object.keys(bash.input).filter((k) => K.test(k)).length, 1);
  // result of a non-built-in (MCP) tool_use: every key under toolUseResult is hashed,
  // including the structural-looking ones, and so is the whole subtree
  const mcpResult = parent[10];
  assert.ok(mcpResult.toolUseResult && Object.keys(mcpResult.toolUseResult).length === 3);
  for (const k of Object.keys(mcpResult.toolUseResult)) assert.match(k, K);
  assert.ok(JSON.stringify(mcpResult.toolUseResult).match(/"k_[0-9a-f]{12}":\{"k_[0-9a-f]{12}":/));
  // attachment payload map
  const skill = parent[11];
  assert.equal(skill.attachment.type, "skill_listing");
  const maps = Object.entries(skill.attachment).filter(([k]) => k !== "type");
  assert.equal(maps.length, 1);
  assert.match(maps[0][0], K);
  for (const k of Object.keys(maps[0][1])) assert.match(k, K);
  // one data key, one name: the same in the parent and the subagent file, fixed length
  const pk = Object.keys(parent[0]).filter((k) => K.test(k));
  const sk = Object.keys(sub[0]).filter((k) => K.test(k));
  const shared = sk.filter((k) => pk.includes(k));
  assert.equal(shared.length, 1, "the planted shared key has the same k_ name in both files");
  for (const k of pk) assert.equal(k.length, 14);
  // and the hashed names never double as ids (no key reaches the id map)
  assert.ok(!Object.keys(parent[0]).some((k) => /^[0-9a-f]{8}$/.test(k)));
});

test("a huge input line is handled and comes out as one small placeholder line", () => {
  assert.ok(fs.statSync(input).size > 200000, "the planted input line really is huge");
  const lines = readJsonl(outParent());
  const huge = lines[8];
  assert.equal(huge.message.content, "S1");
  assert.ok(JSON.stringify(huge).length < 1000);
});

test("the cut-off input line is dropped, and --truncate-last cuts the OUTPUT tail", () => {
  assert.ok(fs.readFileSync(outParent(), "utf8").endsWith("\n"));
  const o = path.join(WORK, "out-trunc");
  const r = run(["--session", input, "--out", o, "--proj", "neutral", "--truncate-last"]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(o, "neutral", "s1.jsonl"), "utf8");
  assert.ok(!text.endsWith("\n"));
  assert.throws(() => JSON.parse(text.slice(text.lastIndexOf("\n") + 1)));
});

test("--compact rewrites parentUuid to the nearest kept ancestor", () => {
  const dir = path.join(WORK, "compact-in", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const text = (n, parent, type) =>
    base(n, parent, { type, message: { role: type, content: `t${n}`, id: "m" + n } });
  const lines = [
    text(1, null, "user"),
    text(2, 1, "assistant"),
    text(3, 2, "user"), // same shape as 1: dropped
    text(4, 3, "assistant"), // same shape as 2: dropped
    base(5, 4, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x" }] }
    })
  ];
  const file = path.join(dir, "c.jsonl");
  fs.writeFileSync(file, jl(lines) + "\n");
  const o = path.join(WORK, "compact-out");
  const r = run(["--session", file, "--out", o, "--proj", "neutral", "--compact"]);
  assert.equal(r.status, 0, r.stderr);
  const kept = readJsonl(path.join(o, "neutral", "s1.jsonl"));
  assert.equal(kept.length, 3);
  const uuids = new Set(kept.map((k) => k.uuid));
  for (const k of kept) if (k.parentUuid !== null) assert.ok(uuids.has(k.parentUuid));
  assert.equal(kept[2].parentUuid, kept[1].uuid);
});

test("finding 3: unsafe --proj/--name and overwriting the input are refused", () => {
  const before = inputShas.map(([f]) => sha(f));
  const escaped = path.join(WORK, "escaped");
  for (const proj of ["../escaped", "..", ".", "a/b", "a\\b", ""]) {
    const r = run(["--session", input, "--out", path.join(WORK, "o3"), "--proj", proj || " "]);
    assert.notEqual(r.status, 0, `--proj ${JSON.stringify(proj)} must fail`);
  }
  for (const name of ["../x", "..", "a/b"]) {
    const r = run(["--session", input, "--out", out1, "--proj", "p", "--name", name]);
    assert.notEqual(r.status, 0, `--name ${name} must fail`);
  }
  assert.ok(!fs.existsSync(escaped));
  assert.ok(!fs.existsSync(path.join(WORK, "o3")));
  // --out is the input's parent and the names line up with the real input file
  const same = run([
    "--session",
    input,
    "--out",
    path.join(WORK, "in"),
    "--proj",
    "proj",
    "--name",
    "sess1"
  ]);
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /refusing/);
  // output folder inside the input project folder
  const inside = run(["--session", input, "--out", path.dirname(input), "--proj", "sub"]);
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /refusing/);
  assert.deepEqual(
    inputShas.map(([f]) => sha(f)),
    before
  );
  assert.deepEqual(
    listFiles(path.join(WORK, "in")).sort(),
    inputShas.map(([f]) => f).sort(),
    "no new files appeared next to the input"
  );
});

test("--oversize on an empty session does not crash", () => {
  const dir = path.join(WORK, "empty-in", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "e.jsonl");
  fs.writeFileSync(file, "");
  const o = path.join(WORK, "empty-out");
  const r = run(["--session", file, "--out", o, "--proj", "neutral", "--oversize", "9000"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readJsonl(path.join(o, "neutral", "s1.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]._synthetic, "oversize");
});

test("an id value that equals a structural key name does not rename that key later", () => {
  const dir = path.join(WORK, "idkey-in", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "k.jsonl");
  fs.writeFileSync(
    file,
    jl([
      {
        ...base(1, null, { type: "assistant" }),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [toolUse("toolu_m1", "mcp__acme__q", { id: "type" })]
        }
      },
      { ...base(2, 1, { type: "user" }), message: { role: "user", content: "S" } }
    ]) + "\n"
  );
  const o = path.join(WORK, "idkey-out");
  const r = run(["--session", file, "--out", o, "--proj", "neutral"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readJsonl(path.join(o, "neutral", "s1.jsonl"));
  assert.equal(lines[0].type, "assistant");
  assert.equal(lines[1].type, "user", "later lines keep their type key");
});

test("numbers are data: zeroed in opaque subtrees and as epoch-ms, kept under known keys", () => {
  const dir = path.join(WORK, "num-in", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "n.jsonl");
  fs.writeFileSync(
    file,
    jl([
      {
        ...base(1, null, { type: "assistant" }),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          usage: { input_tokens: 11, output_tokens: 22 },
          content: [
            toolUse("toolu_m1", "mcp__acme__q", {
              phone: 5551234567,
              path: 424242,
              nested: { acct: 987654321 }
            })
          ]
        }
      },
      {
        ...base(2, 1, { type: "user" }),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_m1", content: "S" }]
        },
        toolUseResult: { balance: 123456.78, ssn: 123456789, lastLogin: 1746439200123 }
      },
      { ...base(3, 2, { type: "system", subtype: "turn_duration" }), durationMs: 1746439200999 }
    ]) + "\n"
  );
  const o = path.join(WORK, "num-out");
  const r = run(["--session", file, "--out", o, "--proj", "neutral"]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(o, "neutral", "s1.jsonl"), "utf8");
  for (const n of ["5551234567", "424242", "987654321", "123456.78", "123456789", "1746439200"]) {
    assert.ok(!text.includes(n), `number ${n} must not survive`);
  }
  const first = JSON.parse(text.split("\n")[0]);
  assert.equal(first.message.usage.output_tokens, 22, "usage counts under known keys survive");
});

test("an MCP input keeps no structural-looking key (path, command) in the clear", () => {
  const dir = path.join(WORK, "mcpkey-in", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "m.jsonl");
  fs.writeFileSync(
    file,
    jl([
      {
        ...base(1, null, { type: "assistant" }),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [toolUse("toolu_m1", "mcp__acme__q", { path: "S", command: "S" })]
        }
      }
    ]) + "\n"
  );
  const o = path.join(WORK, "mcpkey-out");
  const r = run(["--session", file, "--out", o, "--proj", "neutral"]);
  assert.equal(r.status, 0, r.stderr);
  const block = readJsonl(path.join(o, "neutral", "s1.jsonl"))[0].message.content[0];
  assert.deepEqual(
    Object.keys(block.input).every((k) => /^k_[0-9a-f]{12}$/.test(k)),
    true
  );
});

test("model slugs bound their digit runs", () => {
  assert.ok(!MODEL_RE.test("claude-opus-5551234567"));
  assert.ok(!MODEL_RE.test("claude-opus-4-8-123456789"));
  assert.ok(MODEL_RE.test("claude-haiku-4-5-20251001"));
});
