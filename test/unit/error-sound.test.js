/**
 * Unit tests for dashboard/error-sound.js: when a row plays the error sound. Loaded in a vm
 * sandbox with a stub `window`. The Claude Code cases run the real parser and wire first, so
 * the status string decides the outcome end to end.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("../../lib/claude-code-parse.js");
const W = require("../../lib/claude-code-wire.js");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "error-sound.js");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
const { shouldPlay } = sandbox.window.WorkshopErrorSound;

/** The wire event for one child notification with this status. */
function childEvent(status) {
  const state = P.createState();
  P.parseLine(
    {
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: { subagent_type: "worker", model: "sonnet" }
          }
        ]
      }
    },
    state
  );
  const rows = P.parseLine(
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-01-01T00:00:01.000Z",
      content: `<task-notification><task-id>a1</task-id><tool-use-id>toolu_1</tool-use-id><status>${status}</status></task-notification>`
    },
    state
  );
  assert.equal(rows.length, 1);
  return W.eventFromRow(rows[0]);
}

for (const status of ["failed", "error", "killed"]) {
  test(`a child row with status ${status} plays the error sound once`, () => {
    const ev = childEvent(status);
    assert.equal(ev.role, "worker", "a child row, not the parent");
    assert.equal(ev.failed, true);
    assert.equal(shouldPlay(ev, {}), true);
    // the same row seen again (a second SSE delivery) stays silent
    assert.equal(shouldPlay(ev, { alreadySeen: true }), false);
  });
}

for (const status of ["stopped", "cancelled", "canceled"]) {
  test(`a child row with status ${status} stays silent but is still an error row`, () => {
    const ev = childEvent(status);
    assert.equal(ev.type, "error");
    assert.notEqual(ev.failed, true);
    assert.equal(shouldPlay(ev, {}), false);
  });
}

test("a completed or unknown child row never plays it", () => {
  assert.equal(shouldPlay(childEvent("completed"), {}), false);
  assert.equal(shouldPlay(childEvent("exploded"), {}), false);
});

test("a replayed failed row stays silent (bridge catch-up, History replay, SSE backlog)", () => {
  const ev = childEvent("failed");
  assert.equal(shouldPlay({ ...ev, replay: true }, {}), false);
  assert.equal(shouldPlay(ev, { isReplay: true }), false);
  assert.equal(shouldPlay(ev, { backlog: true }), false);
  assert.equal(shouldPlay({ ...ev, sseBacklog: true }, {}), false, "the row's own backlog mark");
});

test("a Cursor error-looking row never plays, even with the old replayError mark", () => {
  const cursorLive = { role: "worker", kind: "status", type: "error", message: "error" };
  assert.equal(shouldPlay(cursorLive, {}), false);
  assert.equal(shouldPlay({ ...cursorLive, replayError: true }, {}), false);
  assert.equal(shouldPlay(null, {}), false);
});

test("the wire only keeps failed on error rows", () => {
  const ev = W.eventFromRow({ type: "done", role: "worker", failed: true, ts: "x", message: "m" });
  assert.equal(ev.failed, undefined);
});
