/**
 * Pins the on-disk Claude Code transcript shapes. The fixtures are real sessions
 * run through scripts/sanitize-claude-transcript.js: keys, line types, nesting,
 * message.content blocks, ids (hashed, links intact) and numbers survive; other
 * arrays are cut to 3 items; every other string is "S1".
 *
 * SYNTHETIC robustness cases (added by the sanitizer, not found in real data) are
 * labelled as such below: the over-8192 line (_synthetic "oversize"), the cut-off
 * last line of the WSL file, the cost-state-is-last assertion that depends on that
 * cut, and the early partial-usage line (_synthetic "partial-usage"). Real files
 * checked at fixture time: every one ends with a newline and every parentUuid
 * resolves inside its own file.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..", "fixtures", "claude-code", "real");
const WIN = path.join(ROOT, "C--proj-demo");
const WSL = path.join(ROOT, "-home-user-demo");
const PARENT = path.join(WIN, "s1.jsonl");
const SUBDIR = path.join(WIN, "s1", "subagents");
const WSL_PARENT = path.join(WSL, "s1.jsonl");

const rawLines = (file) => fs.readFileSync(file, "utf8").split("\n");
const readJsonl = (file) =>
  rawLines(file)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const blocks = (o) => (o.message && Array.isArray(o.message.content) ? o.message.content : []);
const agentCalls = (lines) =>
  lines.flatMap((o) =>
    o.type === "assistant"
      ? blocks(o).filter((b) => b.type === "tool_use" && b.name === "Agent")
      : []
  );

const parent = readJsonl(PARENT);
const isSynthetic = (o) => "_synthetic" in o;

test("conversation lines carry timestamp, sessionId, uuid, isSidechain", () => {
  // synthetic lines (the oversize filler) are excluded: they only carry what we gave them
  const convo = parent.filter(
    (o) => (o.type === "user" || o.type === "assistant") && !isSynthetic(o)
  );
  assert.ok(convo.length > 5);
  for (const o of convo) {
    assert.equal(typeof o.timestamp, "string", o.type);
    assert.ok(!Number.isNaN(Date.parse(o.timestamp)));
    assert.equal(typeof o.sessionId, "string");
    assert.equal(typeof o.uuid, "string");
    assert.equal(typeof o.isSidechain, "boolean");
  }
  for (const f of fs.readdirSync(SUBDIR).filter((n) => n.endsWith(".jsonl"))) {
    const first = readJsonl(path.join(SUBDIR, f)).find((o) => o.type === "user");
    assert.equal(first.isSidechain, true, f);
    assert.equal(typeof first.agentId, "string", f);
  }
});

test("assistant lines have message.model and a usage block", () => {
  const assistants = parent.filter((o) => o.type === "assistant");
  assert.ok(assistants.length > 3);
  for (const o of assistants) {
    assert.equal(typeof o.message.model, "string");
    assert.equal(typeof o.message.id, "string");
    const u = o.message.usage;
    assert.equal(typeof u.input_tokens, "number");
    assert.equal(typeof u.output_tokens, "number");
    assert.equal(typeof u.cache_read_input_tokens, "number");
  }
});

test("delegation tool is named Agent; model is optional in its input", () => {
  const calls = agentCalls(parent);
  assert.ok(
    calls.some((c) => c.input.model),
    "an Agent call WITH model"
  );
  assert.ok(
    calls.some((c) => !("model" in c.input)),
    "an Agent call WITHOUT model"
  );
  for (const c of calls) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.input.subagent_type, "string");
    assert.ok("description" in c.input && "prompt" in c.input);
  }
  assert.ok(!parent.some((o) => blocks(o).some((b) => b.type === "tool_use" && b.name === "Task")));
});

test("Agent toolUseResult carries agentId, resolvedModel, status, isAsync, outputFile", () => {
  const results = parent.filter((o) => o.toolUseResult && o.toolUseResult.agentId);
  assert.ok(results.length >= 2);
  const callIds = new Set(agentCalls(parent).map((c) => c.id));
  for (const o of results) {
    const r = o.toolUseResult;
    assert.match(r.resolvedModel, /^claude-/);
    assert.equal(r.status, "async_launched");
    assert.equal(r.isAsync, true);
    assert.ok("outputFile" in r);
    const link = blocks(o).find((b) => b.type === "tool_result").tool_use_id;
    assert.ok(callIds.has(link), "tool_result links to an Agent tool_use");
  }
});

const groupsById = (lines) => {
  const byId = new Map();
  for (const o of lines.filter((x) => x.type === "assistant")) {
    byId.set(o.message.id, [...(byId.get(o.message.id) || []), o]);
  }
  return [...byId.values()].filter((v) => v.length > 1);
};
const subLines = () =>
  fs
    .readdirSync(SUBDIR)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => readJsonl(path.join(SUBDIR, n)));

test("assistant lines repeat message.id once per content block; usage is usually identical but can grow", () => {
  const repeated = groupsById(parent);
  assert.ok(repeated.length >= 1, "at least one message.id repeats");
  let identical = 0;
  for (const group of repeated) {
    assert.equal(
      new Set(group.map((o) => o.uuid)).size,
      group.length,
      "each line has its own uuid"
    );
    for (const o of group) assert.equal(blocks(o).length, 1);
    if (new Set(group.map((o) => JSON.stringify(o.message.usage))).size === 1) identical++;
  }
  assert.ok(identical >= 1, "usage is usually identical across the repeats");

  // Wherever it differs, output_tokens only grows and the LAST line holds the final usage.
  let grew = 0;
  for (const lines of [parent, ...subLines()]) {
    for (const group of groupsById(lines)) {
      const out = group.map((o) => o.message.usage.output_tokens);
      assert.deepEqual(
        out,
        [...out].sort((a, b) => a - b),
        "output_tokens never shrinks"
      );
      assert.equal(out[out.length - 1], Math.max(...out), "last line holds the final usage");
      if (out[0] < out[out.length - 1]) {
        grew++;
        // SYNTHETIC: the committed sources had no growing id; the sanitizer adds one in a
        // subagent (sidechain) file and labels it. Real data shows 3 -> 2381 style growth.
        assert.ok(group[0].isSidechain, "growth is a sidechain thing");
        assert.equal(group[0]._synthetic, "partial-usage");
      }
    }
  }
  assert.ok(grew >= 1, "a sidechain fixture shows usage growth");
});

test("every parentUuid resolves to a line in its own file", () => {
  const files = [PARENT, WSL_PARENT, ...fs.readdirSync(SUBDIR).map((n) => path.join(SUBDIR, n))];
  for (const file of files.filter((n) => n.endsWith(".jsonl"))) {
    const lines = rawLines(file)
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return []; // the synthetic cut-off line
        }
      });
    const uuids = new Set(lines.map((o) => o.uuid).filter(Boolean));
    for (const o of lines) {
      if (typeof o.parentUuid === "string") {
        assert.ok(uuids.has(o.parentUuid), `dangling parentUuid in ${path.basename(file)}`);
      }
    }
  }
});

test("subagent meta.toolUseId equals the parent Agent tool_use id", () => {
  const callIds = agentCalls(parent).map((c) => c.id);
  const metas = fs.readdirSync(SUBDIR).filter((n) => n.endsWith(".meta.json"));
  assert.equal(metas.length, 2);
  for (const m of metas) {
    const meta = JSON.parse(fs.readFileSync(path.join(SUBDIR, m), "utf8"));
    assert.equal(typeof meta.agentType, "string");
    assert.ok(callIds.includes(meta.toolUseId), m);
    assert.ok(fs.existsSync(path.join(SUBDIR, m.replace(".meta.json", ".jsonl"))));
  }
  // The result's agentId names the subagent file.
  for (const o of parent.filter((x) => x.toolUseResult && x.toolUseResult.agentId)) {
    assert.ok(fs.existsSync(path.join(SUBDIR, `agent-${o.toolUseResult.agentId}.jsonl`)));
  }
});

test("task-notification blocks sit only in their carriers and link to an Agent call", () => {
  const callIds = new Set(agentCalls(parent).map((c) => c.id));
  let n = 0;
  for (const o of parent) {
    const carrier =
      (o.type === "queue-operation" && o.content) || (o.attachment && o.attachment.prompt) || "";
    const text = JSON.stringify(o);
    if (!text.includes("<task-notification>")) continue;
    assert.ok(String(carrier).includes("<task-notification>"), `stray notification in ${o.type}`);
    n++;
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(carrier)[1];
    assert.ok(callIds.has(id), "notification points at an Agent call");
  }
  assert.ok(n >= 2);
});

test("queue-operation enqueue carries a task-notification with status and usage", () => {
  const q = parent.filter(
    (o) =>
      o.type === "queue-operation" &&
      o.operation === "enqueue" &&
      String(o.content).includes("<task-notification>")
  );
  assert.ok(q.length >= 1);
  const c = q[0].content;
  assert.match(c, /<status>completed<\/status>/);
  assert.match(c, /<subagent_tokens>\d+<\/subagent_tokens>/);
  assert.match(c, /<tool_uses>\d+<\/tool_uses>/);
  assert.match(c, /<duration_ms>\d+<\/duration_ms>/);
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(c)[1];
  assert.ok(agentCalls(parent).some((a) => a.id === toolUseId));
});

test("SYNTHETIC: a line can exceed 8192 bytes", () => {
  const big = rawLines(PARENT).filter((l) => Buffer.byteLength(l) > 8192);
  assert.ok(big.length >= 1);
  assert.equal(JSON.parse(big[0])._synthetic, "oversize");
});

test("SYNTHETIC: the last line of a live file can be cut off (unparseable, no newline)", () => {
  const text = fs.readFileSync(WSL_PARENT, "utf8");
  assert.ok(!text.endsWith("\n"));
  const last = text.slice(text.lastIndexOf("\n") + 1);
  assert.ok(last.length > 0);
  assert.throws(() => JSON.parse(last));
  // every earlier line is whole
  for (const l of text.slice(0, text.lastIndexOf("\n")).split("\n")) JSON.parse(l);
});

test("api-request-blob exists and carries no real text", () => {
  const blobs = parent.filter((o) => o.type === "api-request-blob");
  assert.ok(blobs.length >= 1);
  const strings = [];
  (function walk(v, key) {
    if (typeof v === "string") strings.push([key, v]);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  })(blobs.map((b) => b.message));
  assert.ok(strings.length > 0);
  for (const [key, val] of strings) {
    if (key === "text" || key === "content") {
      assert.equal(val, "S1", `real text in blob: ${key}`);
    }
  }
});

test("noise line types are present and lightweight", () => {
  const types = new Set(parent.map((o) => o.type));
  for (const t of ["queue-operation", "ai-title", "mode", "file-history-snapshot", "api-request"]) {
    assert.ok(types.has(t), t);
  }
  // SYNTHETIC: cost-state is the (cut-off) last line of the WSL fixture
  assert.ok(rawLines(WSL_PARENT).pop().startsWith('{"type":"cost-state"'));
});

test("sessions live under both a Windows-style and a WSL-style project dir", () => {
  assert.ok(fs.existsSync(PARENT));
  assert.ok(fs.existsSync(WSL_PARENT));
  assert.match(path.basename(WIN), /^[A-Za-z]--/);
  assert.match(path.basename(WSL), /^-home-/);
});
