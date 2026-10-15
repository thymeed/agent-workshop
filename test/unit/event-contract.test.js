/**
 * Contract test: the runtime event-type Set must match the documented union in
 * types/events.js. The JSDoc cast in lib/event-log.js tells tsc the runtime guard
 * already proved the value, so these two must not drift - this is what proves it.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { EVENT_TYPES } = require("../../lib/event-log.js");

const ROOT = path.resolve(__dirname, "..", "..");
const TYPES_SRC = fs.readFileSync(path.join(ROOT, "types", "events.js"), "utf8");

function documentedHistoryEventTypes() {
  const m = TYPES_SRC.match(/@typedef \{([^}]*)\} HistoryEventType/);
  assert.ok(m, "types/events.js must declare a HistoryEventType typedef");
  return m[1]
    .split("|")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

test("EVENT_TYPES matches the documented HistoryEventType union", () => {
  const documented = documentedHistoryEventTypes();
  assert.deepEqual(
    [...EVENT_TYPES].sort(),
    [...documented].sort(),
    "lib/event-log.js EVENT_TYPES and types/events.js HistoryEventType have drifted apart"
  );
});

test("HistoryEvent typedef covers the fields normalizeEvent returns", () => {
  const m = TYPES_SRC.match(/@typedef \{object\} HistoryEvent\b([\s\S]*?)\n \*\//);
  assert.ok(m, "HistoryEvent typedef block must be present");
  const documented = [...m[1].matchAll(/@property \{[^}]*\} (\w+)/g)].map((x) => x[1]).sort();

  const { normalizeEvent } = require("../../lib/event-log.js");
  const produced = Object.keys(
    normalizeEvent({
      ts: new Date().toISOString(),
      sessionId: "s",
      agentId: "a",
      name: "n",
      model: "m",
      type: "turn",
      inputTokens: 1,
      outputTokens: 2,
      files: []
    })
  ).sort();

  assert.deepEqual(
    documented,
    produced,
    "HistoryEvent typedef and normalizeEvent's output shape have drifted apart"
  );
  assert.ok(documented.includes("parentId"), "parentId is part of the contract");
});
