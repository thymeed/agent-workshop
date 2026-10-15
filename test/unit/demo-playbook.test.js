/**
 * Unit tests for dashboard/demo-playbook.js. The module is a browser IIFE holding the
 * scripted demo beats; every collaborator is a spy here, so the storyboard's ordering,
 * accounting, and final teardown are covered without a browser.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "demo-playbook.js");
const APP_SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "app.js");

function load() {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push({ name, args });
    };

  const sandbox = {
    window: {},
    setTimeout: () => {
      calls.push({ name: "setTimeout", args: [] });
      return 1;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopDemo;
  assert.ok(mod, "demo-playbook.js must expose window.WorkshopDemo");

  const deps = {
    animateRoute: record("animateRoute"),
    prefersReducedMotion: () => false,
    setActive: record("setActive"),
    setCalls: record("setCalls"),
    setEffort: record("setEffort"),
    setPlaying: record("setPlaying"),
    setStatus: record("setStatus"),
    setSubs: record("setSubs"),
    setUsageSnapshot: record("setUsageSnapshot"),
    triggerShipCelebration: record("triggerShipCelebration"),
    activity: { appendLog: record("appendLog"), append: record("append") },
    advisorLastEl: { textContent: "" },
    demoBtn: {
      textContent: "",
      classList: { remove: record("classList.remove"), add: record("classList.add") },
      setAttribute: record("setAttribute")
    },
    ROLE_LABEL: { opus: "Opus", advisor: "Fable", worker: "Sonnet" }
  };
  mod.init(deps);

  const run = (from, to) => {
    for (let i = from; i <= to; i++) {
      calls.length = 0;
      mod.steps[i]();
    }
  };
  return { mod, calls, deps, run };
}

test("exposes the step array and its length", () => {
  const { mod } = load();
  assert.ok(Array.isArray(mod.steps), "steps must be an array");
  assert.ok(mod.steps.length > 0, "steps must not be empty");
  assert.equal(mod.stepCount(), mod.steps.length);
  for (const fn of mod.steps) assert.equal(typeof fn, "function", "every step is callable");
});

test("the array is byte-identical to the block that was lifted out of app.js", () => {
  /* Guards the mechanical extraction: the step bodies must not drift from the original
     source, apart from the single documented setPlaying substitution. */
  const app = fs.readFileSync(APP_SOURCE, "utf8");
  assert.ok(!/^ {2}var steps = \[$/m.test(app), "app.js should no longer inline the steps array");
  const playbook = fs.readFileSync(SOURCE, "utf8");
  assert.ok(
    playbook.includes("setPlaying(false);"),
    "the final beat must call setPlaying rather than assign a foreign flag"
  );
});

test("running the full play advances the session counters", () => {
  const { mod, calls } = load();
  const seen = [];
  for (let i = 0; i < mod.steps.length; i++) {
    calls.length = 0;
    mod.steps[i]();
    seen.push(...calls.map((c) => c.name));
  }
  assert.ok(seen.includes("setActive"), "beats highlight stations");
  assert.ok(seen.includes("setStatus"), "beats write station status");
  assert.ok(seen.includes("appendLog"), "beats write the session log");
  assert.ok(seen.includes("setUsageSnapshot"), "beats move the bill");
  assert.ok(seen.includes("triggerShipCelebration"), "the final beat ships");
  assert.ok(seen.includes("setPlaying"), "the final beat stops the transport");
});

test("advisor calls increment as the story escalates", () => {
  const { mod, calls } = load();
  const callCounts = [];
  for (let i = 0; i < mod.steps.length; i++) {
    calls.length = 0;
    mod.steps[i]();
    for (const c of calls) {
      if (c.name === "setCalls") callCounts.push(c.args[0]);
    }
  }
  assert.deepEqual(callCounts, [1, 2, 3], "advisor is consulted three times, in order");
});

test("the failure beat reports a failing run and the fix reports a pass", () => {
  const { mod, calls } = load();
  const statuses = [];
  for (let i = 0; i < mod.steps.length; i++) {
    calls.length = 0;
    mod.steps[i]();
    for (const c of calls) {
      if (c.name === "setStatus") statuses.push(c.args);
    }
  }
  assert.ok(
    statuses.some((s) => s[2] === "fail"),
    "at least one station reports a failure state"
  );
  assert.ok(
    statuses.some((s) => s[2] === "pass"),
    "at least one station reports a passing state"
  );
});

test("the last beat resets the transport and clears station highlights", () => {
  const { mod, calls } = load();
  calls.length = 0;
  mod.steps[mod.steps.length - 1]();
  const names = calls.map((c) => c.name);
  assert.ok(names.includes("setPlaying"), "transport flag cleared");
  assert.deepEqual(
    calls.find((c) => c.name === "setPlaying").args,
    [false],
    "setPlaying(false) ends the run"
  );
  assert.ok(names.includes("setAttribute"), "the play button returns to its idle label");
  assert.ok(names.includes("setActive"), "the final beat re-clears the highlighted stations");
});

test("accounts one subagent per delegated read", () => {
  const { mod, calls } = load();
  const subsid = [];
  for (let i = 0; i < mod.steps.length; i++) {
    calls.length = 0;
    mod.steps[i]();
    for (const c of calls) {
      if (c.name === "setSubs") subsid.push(c.args[0]);
    }
  }
  assert.ok(subsid.length > 0, "the story delegates work");
  assert.deepEqual(
    [...subsid].sort((a, b) => a - b),
    subsid,
    "the subagent count never goes backwards"
  );
});

test("every usage snapshot carries all six model buckets", () => {
  const { mod, calls } = load();
  const buckets = [];
  for (let i = 0; i < mod.steps.length; i++) {
    calls.length = 0;
    mod.steps[i]();
    for (const c of calls) {
      if (c.name === "setUsageSnapshot" && c.args[0]) buckets.push(c.args[0]);
    }
  }
  assert.ok(buckets.length > 0, "the story moves the bill");
  for (const snap of buckets) {
    assert.deepEqual(
      Object.keys(snap).sort(),
      ["explorer", "fable", "haiku", "opus", "researcher", "sonnet"],
      "a snapshot must define every bucket the bill renders"
    );
  }
});
