/**
 * Locks the on-disk Cursor transcript format this bridge actually reads.
 *
 * The fixtures under `test/fixtures/transcripts/` were written by hand and describe a
 * shape that does not exist on disk: a top-level `timestamp`, a `usage` block, and
 * `{"type":"user"}` conversation lines. They are kept because they still exercise the
 * tolerant parser paths. This file pins what Cursor really writes, so a drift in either
 * direction is visible instead of silent.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const parse = require("../../lib/transcript-parse");

const REAL = path.join(__dirname, "..", "fixtures", "transcripts", "real");
const SESSION = "7f3a1c2e-9b4d-4a61-8e05-3c2d1f4b6a90";
const PARENT = path.join(REAL, SESSION, SESSION + ".jsonl");
const WORKER = path.join(REAL, SESSION, "subagents", "b81d4f60-2c37-4e59-9a1b-7d3e5f8c0a24.jsonl");
const EXPLORER = path.join(
  REAL,
  SESSION,
  "subagents",
  "c92e5a71-3d48-4f60-ab2c-8e4f6a9d1b35.jsonl"
);
const TERMINALS = path.join(REAL, "turn-ended.jsonl");

function objects(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("real fixtures use only the two line shapes Cursor writes", () => {
  for (const file of [PARENT, WORKER, EXPLORER]) {
    for (const obj of objects(file)) {
      const shape = parse.lineShape(obj);
      assert.notEqual(
        shape,
        "unknown",
        path.basename(file) + " · " + JSON.stringify(obj).slice(0, 80)
      );
      if (shape === "conversation") {
        assert.deepEqual(Object.keys(obj).sort(), ["message", "role"]);
      } else {
        assert.equal(obj.type, "turn_ended");
        assert.ok(obj.status, "terminal line names a status");
      }
    }
  }
  /* turn-ended.jsonl holds the terminal variants plus one deliberate unknown shape,
     which is what the bridge's drift counter exists to notice. */
  const terminals = objects(TERMINALS);
  const unknown = terminals.filter((obj) => parse.lineShape(obj) === "unknown");
  assert.equal(unknown.length, 1, "exactly one intentional drift line");
  assert.equal(unknown[0].type, "summary");
});

test("real fixtures carry none of the fields the legacy fixtures invented", () => {
  for (const file of [PARENT, WORKER, EXPLORER]) {
    const raw = fs.readFileSync(file, "utf8");
    for (const field of ["timestamp", "usage", "input_tokens", "output_tokens", "createdAt"]) {
      assert.equal(
        new RegExp('"' + field + '"\\s*:').test(raw),
        false,
        path.basename(file) + " must not carry a " + field + " field"
      );
    }
    /* Time is prose inside the user text, not a field. */
    assert.ok(raw.includes("<timestamp>"), path.basename(file) + " carries a prose timestamp");
  }
});

test("a real conversation line stamps at ingest time because it has no timestamp field", () => {
  const before = Date.now();
  const stamped = Date.parse(parse.transcriptTimestamp(objects(PARENT)[0]));
  assert.ok(!Number.isNaN(stamped));
  assert.ok(
    stamped >= before - 1000 && stamped <= Date.now() + 1000,
    "expected an ingest-time stamp, got " + new Date(stamped).toISOString()
  );
});

test("every real fixture ends on a terminal line", () => {
  for (const file of [PARENT, WORKER, EXPLORER]) {
    const objs = objects(file);
    const last = objs[objs.length - 1];
    assert.equal(parse.lineShape(last), "terminal", path.basename(file));
    assert.equal(parse.turnEndedFromLine(last).type, "done", path.basename(file));
  }
});

test("turnEndedFromLine reads success, error and an unknown status", () => {
  const [ok, quota, cancelled, aborted] = objects(TERMINALS);
  assert.deepEqual(parse.turnEndedFromLine(ok), {
    status: "success",
    type: "done",
    reason: "",
    known: true
  });
  const quotaOut = parse.turnEndedFromLine(quota);
  assert.equal(quotaOut.type, "error");
  assert.equal(quotaOut.known, true);
  assert.ok(quotaOut.reason.includes("Other Models usage limit reached"));
  assert.equal(parse.turnEndedFromLine(cancelled).reason, "user_stopped_generation");
  const unknown = parse.turnEndedFromLine(aborted);
  assert.equal(unknown.type, null, "an unknown status must not claim done or error");
  assert.equal(unknown.known, false);
  assert.equal(parse.turnEndedFromLine({ role: "user" }), null);
  assert.equal(parse.turnEndedFromLine(null), null);
});

test("turnEndedFromLine truncates a long reason", () => {
  const out = parse.turnEndedFromLine({
    type: "turn_ended",
    status: "error",
    error: "e".repeat(500)
  });
  assert.equal(out.reason.length, 160);
});

test("modelInfoFromSlug maps every slug seen in real delegations", () => {
  const cases = [
    ["claude-sonnet-5-5-high", "Sonnet", "sonnet"],
    ["claude-haiku-5-5-thinking-high", "Haiku", "haiku"],
    ["claude-fable-5-1-thinking-high", "Fable", "fable"],
    ["claude-opus-4-6-high", "Opus", "opus"],
    ["composer-2.5-fast", "Composer", null],
    ["grok-4.7-high", "Grok", null],
    ["gpt-5.2-codex", "GPT", null],
    ["gemini-3-pro", "Gemini", null],
    ["deepseek-v4-flash:cloud", "DeepSeek", null]
  ];
  for (const [slug, label, bucket] of cases) {
    const info = parse.modelInfoFromSlug(slug);
    assert.equal(info.label, label, slug);
    assert.equal(info.bucket, bucket, slug);
    assert.equal(info.known, true, slug);
    assert.equal(info.placeholder, false, slug);
  }
});

test("modelInfoFromSlug treats route words as placeholders, not models", () => {
  for (const raw of ["inherit", "fast", "auto", "default", "parent", "none", "  INHERIT  "]) {
    const info = parse.modelInfoFromSlug(raw);
    assert.equal(info.placeholder, true, raw);
    assert.equal(info.label, "", raw);
    assert.equal(info.bucket, null, raw);
  }
  for (const blank of ["", null, undefined]) {
    const info = parse.modelInfoFromSlug(blank);
    assert.equal(info.placeholder, true, String(blank));
    assert.equal(info.label, "", String(blank));
    assert.equal(info.slug, "", String(blank));
  }
});

test("modelInfoFromSlug shows an unknown slug verbatim and prices nothing", () => {
  const info = parse.modelInfoFromSlug("brand-new-model-9");
  assert.equal(info.known, false);
  assert.equal(info.label, "brand-new-model-9");
  assert.equal(info.bucket, null, "an unknown family must not be billed at a guessed rate");
});

test("extractDelegationModel reads the slug out of real Task args", () => {
  const parent = objects(PARENT);
  const delegations = parent.flatMap((obj) =>
    parse
      .extractToolUses(obj)
      .filter((tool) => parse.resolveToolName(tool) === "Task")
      .map((tool) => parse.extractDelegationModel(tool))
  );
  assert.equal(delegations.length, 2, "the parent fixture pins two delegations");
  assert.equal(delegations[0].slug, "claude-sonnet-5-5-high");
  assert.equal(delegations[0].label, "Sonnet");
  assert.equal(delegations[1].slug, "composer-2.5-fast");
  assert.equal(delegations[1].label, "Composer");
  assert.notEqual(delegations[0].label, delegations[1].label, "two stations, two models");
});

test("extractDelegationModel is empty when the child inherits", () => {
  const tool = {
    name: "CallDynamicTool",
    input: { toolName: "Task", arguments: { subagent_type: "advisor", model: "inherit" } }
  };
  const info = parse.extractDelegationModel(tool);
  assert.equal(info.placeholder, true);
  assert.equal(info.label, "", "a station must never render 'inherit' as a model");
});

test("real subagent role comes from the prompt, since the parent names no child id", () => {
  const explorerText = parse.extractText(objects(EXPLORER)[0]);
  assert.equal(parse.inferRoleFromSubagentText(explorerText), "explorer");
  const workerText = parse.extractText(objects(WORKER)[0]);
  assert.equal(parse.inferRoleFromSubagentText(workerText), "worker");

  /* No real delegation carries a child id, so the parent-side spawn row cannot resolve. */
  const parent = objects(PARENT);
  for (const obj of parent) {
    for (const tool of parse.extractToolUses(obj)) {
      if (parse.resolveToolName(tool) !== "Task") continue;
      const args = parse.toolArgs(tool);
      assert.equal(parse.resolveTaskChildAgentId(args, tool.input), null);
    }
  }
});

test("the real tool names map to activity or fall through harmlessly", () => {
  const seen = new Set();
  for (const file of [PARENT, WORKER, EXPLORER]) {
    for (const obj of objects(file)) {
      for (const tool of parse.extractToolUses(obj)) {
        seen.add(parse.resolveToolName(tool));
      }
    }
  }
  /* resolveToolName unwraps CallDynamicTool to the dynamic tool it calls, which is how
     a delegation is recognized at all. `UpdateCurrentStep` is plumbing: it updates the
     step label but drops no crate. */
  assert.deepEqual([...seen].sort(), [
    "Glob",
    "Grep",
    "Read",
    "StrReplace",
    "Task",
    "UpdateCurrentStep"
  ]);
  assert.equal(parse.toolActivity({ name: "Read", input: { path: "a.js" } }).kind, "read");
  assert.equal(parse.toolActivity({ name: "StrReplace", input: { path: "a.js" } }).kind, "edit");
  assert.equal(
    parse.toolActivity({ name: "Glob", input: { glob_pattern: "*.js" } }).kind,
    "search"
  );
  assert.equal(
    parse.toolActivity({ name: "UpdateCurrentStep", input: { current_step: "x" } }),
    null
  );
});
