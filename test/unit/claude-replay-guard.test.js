/**
 * Unit tests for dashboard/claude-replay-guard.js: the snapshot a Claude Code replay keeps of the
 * Live state, the queue of Live rows that arrive meanwhile, and end() as the one way the replay
 * stops owning the stage (restore, then the queued rows in order; discard; queue overflow).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "claude-replay-guard.js");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
const G = sandbox.window.ClaudeReplayGuard;

function make(over) {
  const log = [];
  let live = { n: 1 };
  const guard = G.create(
    Object.assign(
      {
        capture: () => {
          log.push("capture");
          return { n: live.n };
        },
        restore: (s) => {
          log.push("restore:" + s.n);
          live = { n: s.n };
        },
        applyQueued: (r) => log.push("apply:" + r),
        rebuild: () => log.push("rebuild")
      },
      over || {}
    )
  );
  return { guard, log, setLive: (n) => (live = { n }) };
}

test("exposes create and the default cap", () => {
  assert.equal(typeof G.create, "function");
  assert.equal(G.DEFAULT_CAP, 20000);
});

test("nothing held: offer is refused, end does nothing", () => {
  const t = make();
  assert.equal(t.guard.holding(), false);
  assert.equal(t.guard.offer("a"), false);
  assert.equal(t.guard.end(), false);
  assert.deepEqual(t.log, []);
});

test("take keeps the Live state once; a second take keeps the first copy", () => {
  const t = make();
  assert.equal(t.guard.take(), true);
  t.setLive(7);
  assert.equal(t.guard.take(), false, "already holding");
  assert.deepEqual(t.log, ["capture"], "captured once");
  t.guard.end();
  assert.deepEqual(t.log, ["capture", "restore:1"], "the first copy came back");
});

test("end restores first, then applies the queued rows in arrival order", () => {
  const t = make();
  t.guard.take();
  assert.equal(t.guard.offer("r1"), true);
  assert.equal(t.guard.offer("r2"), true);
  assert.equal(t.guard.offer("r3"), true);
  assert.equal(t.guard.info().queued, 3);
  assert.equal(t.guard.end(), true);
  assert.deepEqual(t.log, ["capture", "restore:1", "apply:r1", "apply:r2", "apply:r3"]);
  assert.equal(t.guard.holding(), false);
  assert.equal(t.guard.info().queued, 0);
});

test("end is idempotent: a second end applies nothing again", () => {
  const t = make();
  t.guard.take();
  t.guard.offer("r1");
  t.guard.end();
  const n = t.log.length;
  assert.equal(t.guard.end(), false);
  assert.equal(t.log.length, n);
});

test("a new replay after an end starts with a fresh snapshot and an empty queue", () => {
  const t = make();
  t.guard.take();
  t.guard.offer("old");
  t.guard.end();
  t.setLive(5);
  t.guard.take();
  t.guard.end();
  assert.deepEqual(t.log.slice(-2), ["capture", "restore:5"]);
});

test("discard drops the snapshot and the queue without restoring or applying", () => {
  const t = make();
  t.guard.take();
  t.guard.offer("r1");
  assert.equal(t.guard.end({ discard: true }), true);
  assert.deepEqual(t.log, ["capture"]);
  assert.equal(t.guard.holding(), false);
  t.guard.end();
  assert.deepEqual(t.log, ["capture"], "no stale snapshot is applied later");
  assert.equal(t.guard.info().discarded, 1);
});

test("queue cap: past it the queue is dropped, end rebuilds instead of restoring", () => {
  const t = make({ cap: 3 });
  t.guard.take();
  for (const r of ["a", "b", "c"]) assert.equal(t.guard.offer(r), true);
  assert.equal(t.guard.info().overflow, false, "exactly at the cap is not an overflow");
  assert.equal(t.guard.offer("d"), true, "one past the cap is still taken (dropped)");
  assert.equal(t.guard.info().overflow, true);
  assert.equal(t.guard.info().queued, 0, "the queue was dropped");
  assert.equal(t.guard.offer("e"), true);
  assert.equal(t.guard.info().queued, 0, "nothing queues after an overflow");
  t.guard.end();
  assert.deepEqual(t.log, ["capture", "rebuild"]);
  assert.equal(t.guard.info().overflow, false, "the flag is clear for the next replay");
  t.guard.take();
  t.guard.offer("f");
  t.guard.end();
  assert.deepEqual(t.log.slice(-3), ["capture", "restore:1", "apply:f"]);
});

test("a cap of exactly the rows offered restores and applies all of them", () => {
  const t = make({ cap: 2 });
  t.guard.take();
  t.guard.offer("a");
  t.guard.offer("b");
  t.guard.end();
  assert.deepEqual(t.log, ["capture", "restore:1", "apply:a", "apply:b"]);
});

test("the default cap holds 20000 rows and overflows at 20001", () => {
  const t = make();
  t.guard.take();
  for (let i = 0; i < 20000; i++) t.guard.offer(i);
  assert.equal(t.guard.info().queued, 20000);
  assert.equal(t.guard.info().overflow, false);
  t.guard.offer("x");
  assert.equal(t.guard.info().overflow, true);
});

test("a snapshot is a copy: later changes to the Live state do not reach it", () => {
  const t = make();
  t.guard.take();
  t.setLive(99);
  t.guard.end();
  assert.ok(t.log.includes("restore:1"));
});

test("release runs once on every way a held replay ends, before restore, discard or rebuild", () => {
  const ends = [
    ["restore", undefined, ["capture", "release", "restore:1"], 0],
    ["discard", { discard: true }, ["capture", "release"], 0],
    ["rebuild", undefined, ["capture", "release", "rebuild"], 2]
  ];
  for (const [name, opts, want, cap] of ends) {
    const log = [];
    const guard = G.create({
      capture: () => (log.push("capture"), { n: 1 }),
      restore: (s) => log.push("restore:" + s.n),
      applyQueued: () => {},
      rebuild: () => log.push("rebuild"),
      release: () => log.push("release"),
      cap: cap || undefined
    });
    guard.take();
    if (cap) for (let i = 0; i < cap + 1; i++) guard.offer(i);
    guard.end(opts);
    guard.end(opts);
    assert.deepEqual(log, want, name);
  }
});

test("release is not called when nothing is held", () => {
  let released = 0;
  const t = make({ release: () => released++ });
  t.guard.end();
  t.guard.end({ discard: true });
  assert.equal(released, 0);
});
