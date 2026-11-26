/**
 * Unit tests for dashboard/claude-history.js (browser IIFE, run in a vm sandbox with stubbed
 * elements and a scripted bridge): label format, picker fill, empty / truncated / 409 / 400 /
 * network paths, stale-response guards, and source / project switches dropping the replay.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildForbidden } = require("../helpers/privacy-patterns");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "claude-history.js");
const FORBIDDEN = buildForbidden([]);
const OPAQUE = "cs-0123456789abcdef01234567";

const local = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s || 0).toISOString();

function makeSelect() {
  const sel = {
    children: [],
    value: "",
    disabled: false,
    listeners: {},
    appendChild(o) {
      sel.children.push(o);
      return o;
    },
    addEventListener(type, fn) {
      (sel.listeners[type] = sel.listeners[type] || []).push(fn);
    },
    choose(v) {
      sel.value = v;
      (sel.listeners.change || []).forEach((fn) => fn());
    },
    texts: () => sel.children.map((o) => o.textContent),
    values: () => sel.children.map((o) => o.value)
  };
  Object.defineProperty(sel, "textContent", {
    get: () => "",
    set: () => {
      sel.children = [];
    }
  });
  return sel;
}

function load() {
  const sandbox = {
    window: {},
    document: { createElement: () => ({ value: "", textContent: "", disabled: false }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.ClaudeHistory;
  assert.ok(mod, "claude-history.js must expose window.ClaudeHistory");
  return mod;
}

const H = load();

/** A scripted bridge: every request waits until the test settles it. */
function harness(over) {
  const select = makeSelect();
  const els = { wrap: { hidden: true }, select, status: { textContent: "" } };
  const state = { mode: "live", source: "claude-code", historyOpen: true };
  const calls = [];
  const pending = [];
  const replay = [];
  const copy = [];
  const panel = {
    setReplayEvents: (e) => replay.push(e),
    setReplayEmptyText: (x) => copy.push(x)
  };
  const fetchJson = (p) =>
    new Promise((resolve, reject) => {
      const entry = { path: p, resolve, reject };
      calls.push(p);
      pending.push(entry);
    });
  const ch = H.create(
    Object.assign(
      {
        els,
        fetchJson,
        getMode: () => state.mode,
        getSource: () => state.source,
        getPanel: () => panel,
        isHistoryOpen: () => state.historyOpen
      },
      over || {}
    )
  );
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    ch,
    els,
    select,
    state,
    calls,
    pending,
    replay,
    copy,
    tick,
    /** Answer the oldest unanswered request. */
    async answer(status, body) {
      const e = pending.shift();
      assert.ok(e, "a request was expected");
      e.resolve({ status, body });
      await tick();
      return e.path;
    },
    async fail() {
      pending.shift().reject(new Error("net"));
      await tick();
    }
  };
}

const sess = (id, o) => Object.assign({ id, startedAt: null, lastAt: null, events: null }, o);
const ev = (i, extra) =>
  Object.assign(
    {
      id: i,
      iso: local(2026, 11, 18, 15, 12 + i),
      ts: "15:12:00",
      role: "parent",
      kind: "status",
      type: "turn",
      active: ["opus"],
      message: "m" + i,
      replay: true,
      source: "session"
    },
    extra
  );

// ---------- labels ----------

test("label: local time, event count, duration", () => {
  const s = sess(OPAQUE, {
    startedAt: local(2026, 11, 18, 15, 12),
    lastAt: local(2026, 11, 18, 15, 20)
  });
  assert.equal(H.formatLabel(s), "Nov 18, 3:12 PM · 8 min", "list entry: count unknown yet");
  const info = H.describeEvents([ev(0), ev(8)]);
  assert.equal(
    H.formatLabel(s, { count: 412, startMs: info.startMs, endMs: info.endMs }),
    "Nov 18, 3:12 PM · 412 events · 8 min"
  );
});

test("label: one event, zero minutes, hours, midnight and noon", () => {
  const a = sess(OPAQUE, {
    startedAt: local(2026, 11, 18, 0, 5),
    lastAt: local(2026, 11, 18, 0, 5, 30)
  });
  assert.equal(
    H.formatLabel(a, { count: 1, startMs: NaN, endMs: NaN }),
    "Nov 18, 12:05 AM · 1 event · 0 min"
  );
  const b = sess(OPAQUE, {
    startedAt: local(2026, 11, 18, 12, 0),
    lastAt: local(2026, 11, 18, 13, 5)
  });
  assert.equal(H.formatLabel(b), "Nov 18, 12:00 PM · 1 h 5 min");
  const c = sess(OPAQUE, {
    startedAt: local(2026, 11, 18, 9, 0),
    lastAt: local(2026, 11, 18, 11, 0)
  });
  assert.equal(H.formatLabel(c), "Nov 18, 9:00 AM · 2 h");
});

test("label: missing, invalid or backwards timestamps drop the part, never throw", () => {
  const last = local(2026, 11, 18, 15, 12);
  assert.equal(
    H.formatLabel(sess(OPAQUE, { lastAt: last })),
    "Nov 18, 3:12 PM",
    "no start: no duration"
  );
  assert.equal(H.formatLabel(sess(OPAQUE, { startedAt: "nope", lastAt: last })), "Nov 18, 3:12 PM");
  assert.equal(H.formatLabel(sess(OPAQUE, { startedAt: "", lastAt: "x" })), "Session");
  assert.equal(H.formatLabel(null), "Session");
  assert.equal(H.formatLabel({}, { count: 3, startMs: NaN, endMs: NaN }), "Session · 3 events");
  const back = sess(OPAQUE, { startedAt: last, lastAt: local(2026, 11, 18, 15, 0) });
  assert.equal(H.formatLabel(back), "Nov 18, 3:12 PM", "end before start: no duration");
});

test("label never carries the opaque id, a path or a prompt", () => {
  const s = sess(OPAQUE, {
    startedAt: local(2026, 11, 18, 15, 12),
    lastAt: local(2026, 11, 18, 15, 20),
    name: "secret-file.jsonl",
    cwd: "C:\\Users\\bob\\proj"
  });
  const label = H.formatLabel(s, { count: 5, startMs: NaN, endMs: NaN });
  assert.ok(!label.includes(OPAQUE) && !label.includes("cs-") && !label.includes("secret"));
  assert.ok(!FORBIDDEN.test(label), label);
});

test("describeEvents counts and finds the first and last time; events without time give NaN", () => {
  const d = H.describeEvents([ev(5), ev(1), { iso: "bad" }, null]);
  assert.equal(d.count, 4);
  assert.equal(d.startMs, Date.parse(ev(1).iso));
  assert.equal(d.endMs, Date.parse(ev(5).iso));
  const none = H.describeEvents([{}, {}]);
  assert.equal(none.count, 2);
  assert.ok(Number.isNaN(none.startMs) && Number.isNaN(none.endMs));
  assert.equal(H.describeEvents(undefined).count, 0);
});

// ---------- list ----------

test("the picker is filled from the list: ids only in values, labels without ids", async () => {
  const h = harness();
  const p = h.ch.refresh();
  assert.equal(h.calls[0], "/api/claude/sessions");
  assert.equal(h.els.wrap.hidden, false);
  await h.answer(200, {
    ok: true,
    sessions: [
      sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {
        startedAt: local(2026, 11, 18, 15, 12),
        lastAt: local(2026, 11, 18, 15, 20)
      }),
      sess("cs-bbbbbbbbbbbbbbbbbbbbbbbb", { lastAt: local(2026, 11, 10, 9, 0) })
    ]
  });
  await p;
  assert.deepEqual(h.select.values(), [
    "",
    "cs-aaaaaaaaaaaaaaaaaaaaaaaa",
    "cs-bbbbbbbbbbbbbbbbbbbbbbbb"
  ]);
  assert.deepEqual(h.select.texts(), [
    "Choose a session…",
    "Nov 18, 3:12 PM · 8 min",
    "Nov 10, 9:00 AM"
  ]);
  assert.equal(h.select.disabled, false);
  assert.equal(h.els.status.textContent, "2 sessions from the last 14 days");
  for (const t of [...h.select.texts(), h.els.status.textContent]) {
    assert.ok(!t.includes("cs-") && !FORBIDDEN.test(t), t);
  }
});

test("a list cut short is said, one session reads in the singular", async () => {
  const h = harness();
  h.ch.refresh();
  await h.answer(200, { sessions: [sess("cs-a", {})], truncated: true });
  assert.equal(
    h.els.status.textContent,
    "1 session from the last 14 days (the list was cut short)"
  );
});

test("no sessions in 14 days: a clear message and a disabled picker", async () => {
  const h = harness();
  h.ch.refresh();
  await h.answer(200, { ok: true, sessions: [] });
  assert.equal(h.els.status.textContent, "No sessions in the last 14 days.");
  assert.equal(h.select.disabled, true);
  assert.deepEqual(h.select.texts(), ["No sessions"]);
});

test("list 409, 500 and a network error show a message and do not throw", async () => {
  const h = harness();
  h.ch.refresh();
  await h.answer(409, { ok: false, error: "No project selected" });
  assert.equal(h.els.status.textContent, "Pick a project to see its older sessions.");
  assert.equal(h.select.disabled, true);
  h.ch.refresh();
  await h.answer(500, { ok: false });
  assert.equal(h.els.status.textContent, "The sessions could not be listed.");
  h.ch.refresh();
  await h.answer(200, { sessions: "nope" });
  assert.equal(h.els.status.textContent, "The sessions could not be listed.", "bad shape");
  h.ch.refresh();
  await h.fail();
  assert.equal(h.els.status.textContent, "Could not reach the bridge.");
});

test("refresh when the page is not on Live + Claude Code asks nothing and hides the picker", async () => {
  const h = harness();
  h.state.source = "cursor";
  await h.ch.refresh();
  assert.equal(h.calls.length, 0, "Cursor path: no Claude request");
  assert.equal(h.els.wrap.hidden, true);
  h.state.source = "claude-code";
  h.state.mode = "demo";
  await h.ch.refresh();
  assert.equal(h.calls.length, 0, "Demo: no request");
});

// ---------- loading one session ----------

async function listed(h, items) {
  const p = h.ch.refresh();
  await h.answer(200, {
    sessions: items || [
      sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {}),
      sess("cs-bbbbbbbbbbbbbbbbbbbbbbbb", {})
    ]
  });
  await p;
}

test("choosing a session fetches it by opaque id and hands decorated events to the replay", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(h.calls[1], "/api/claude/session?id=cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, {
    ok: true,
    events: [ev(0), ev(8, { source: "subagent:1", role: "worker", modelLabel: "Sonnet" })],
    truncated: false
  });
  assert.equal(h.replay.length, 1);
  const got = h.replay[0];
  assert.equal(got.length, 2);
  assert.equal(got[0].agentId, "session");
  assert.equal(got[0].parentId, null);
  assert.equal(got[1].agentId, "subagent:1");
  assert.equal(got[1].parentId, "session");
  assert.equal(got[1].name, "worker");
  assert.equal(got[1].model, "Sonnet");
  assert.equal(got[1].replay, true, "events stay replay rows");
  assert.equal(h.els.status.textContent, "2 events");
  assert.equal(h.select.value, "cs-aaaaaaaaaaaaaaaaaaaaaaaa", "the choice stays selected");
  assert.match(
    h.select.texts()[1],
    /^Nov 18, 3:12 PM · 2 events · 8 min$/,
    "label learns count and span"
  );
});

test("a truncated session says so; an empty one says so", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)], truncated: true });
  assert.match(h.els.status.textContent, /^1 event · this session was cut at the size limits/);
  h.select.choose("cs-bbbbbbbbbbbbbbbbbbbbbbbb");
  await h.answer(200, { events: [], truncated: false });
  assert.equal(h.els.status.textContent, "No events in this session");
});

test("session 400 (stale id) reloads the list; 409, 404 and network errors drop the replay", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  assert.equal(h.replay.length, 1);
  h.select.choose("cs-bbbbbbbbbbbbbbbbbbbbbbbb");
  const before = h.calls.length;
  await h.answer(400, { ok: false, error: "Unknown session" });
  assert.equal(h.replay.at(-1), null, "the old replay is dropped");
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1), "/api/claude/sessions", "the list is requested again");
  await h.answer(200, { sessions: [sess("cs-cccccccccccccccccccccccc", {})] });
  assert.deepEqual(h.select.values(), ["", "cs-cccccccccccccccccccccccc"]);

  h.select.choose("cs-cccccccccccccccccccccccc");
  await h.answer(409, { ok: false, error: "No project selected" });
  assert.equal(h.els.status.textContent, "Pick a project to replay its sessions.");
  assert.equal(h.select.value, "");
  h.select.choose("cs-cccccccccccccccccccccccc");
  await h.answer(404, { ok: false });
  assert.equal(h.els.status.textContent, "That session could not be read.");
  h.select.choose("cs-cccccccccccccccccccccccc");
  await h.fail();
  assert.equal(h.els.status.textContent, "Could not load the session.");
});

test("choosing the placeholder drops the replay and asks nothing", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  const calls = h.calls.length;
  h.select.choose("");
  assert.equal(h.calls.length, calls);
  assert.equal(h.replay.at(-1), null);
});

test("status texts carry no path or id even when the bridge body carries one", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(500, { ok: false, error: "C:\\Users\\bob\\x.jsonl not readable " + OPAQUE });
  assert.ok(!FORBIDDEN.test(h.els.status.textContent) && !h.els.status.textContent.includes("cs-"));
});

// ---------- stale responses ----------

test("a slow first session answer after a second choice is ignored", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  h.select.choose("cs-bbbbbbbbbbbbbbbbbbbbbbbb");
  // answer the SECOND request first, then the first
  h.pending.reverse();
  await h.answer(200, { events: [ev(0), ev(1)] });
  await h.answer(200, { events: [ev(0)] });
  assert.equal(h.replay.length, 1, "only the latest choice reaches the replay");
  assert.equal(h.replay[0].length, 2);
  assert.equal(h.select.value, "cs-bbbbbbbbbbbbbbbbbbbbbbbb");
});

test("a list answer that arrives after a newer refresh is ignored", async () => {
  const h = harness();
  h.ch.refresh();
  h.ch.refresh();
  await h.answer(200, { sessions: [sess("cs-old", {})] });
  assert.ok(!h.select.values().includes("cs-old"), "the first answer is stale");
  await h.answer(200, { sessions: [sess("cs-new", {})] });
  assert.ok(h.select.values().includes("cs-new"));
});

test("a list refresh while a session loads does not discard that load", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  /* History is reopened before the session answer: the list reloads, the load must survive. */
  h.ch.onHistoryOpen();
  await h.answer(200, { events: [ev(0), ev(1)] });
  assert.equal(h.replay.length, 1, "the session still reaches the replay");
  assert.equal(h.replay[0].length, 2);
  assert.match(h.els.status.textContent, /^2 events/);
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  assert.equal(h.select.value, "cs-aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a session answer before the list answer leaves the picker loading, then the list enables it", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  h.ch.onHistoryOpen();
  await h.answer(200, { events: [ev(0)] });
  assert.equal(h.select.disabled, true, "the picker waits for the list");
  assert.deepEqual(h.select.texts(), ["Loading sessions…"], "no half-filled list meanwhile");
  await h.answer(200, {
    sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {}), sess("cs-bbbbbbbbbbbbbbbbbbbbbbbb", {})]
  });
  assert.equal(h.select.disabled, false, "the list answer enables the picker");
  assert.equal(h.select.value, "cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(h.select.children.length, 3);
});

test("a session answer that arrives after a source switch is ignored", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  h.state.source = "cursor";
  await h.ch.sync("live|cursor|p1");
  await h.answer(200, { events: [ev(0)] });
  assert.equal(h.replay.length, 0, "nothing reaches the replay");
  assert.equal(h.els.wrap.hidden, true);
});

// ---------- switches ----------

test("a source switch away drops the replay and hides the picker; back lists again", async () => {
  const h = harness();
  h.ch.sync("live|claude-code|p1");
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  assert.equal(h.replay.length, 1);
  h.state.source = "cursor";
  await h.ch.sync("live|cursor|p1");
  assert.equal(h.replay.at(-1), null, "replay dropped");
  assert.equal(h.els.wrap.hidden, true);
  const calls = h.calls.length;
  h.state.source = "claude-code";
  h.ch.sync("live|claude-code|p1");
  assert.equal(h.calls.length, calls + 1);
  assert.equal(h.calls.at(-1), "/api/claude/sessions");
});

test("a project change drops the replay and lists again; the same key is a repeat", async () => {
  const h = harness();
  h.ch.sync("live|claude-code|p1");
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  const calls = h.calls.length;
  await h.ch.sync("live|claude-code|p1");
  assert.equal(h.calls.length, calls, "same key: nothing happens");
  assert.equal(h.replay.length, 1);
  h.ch.sync("live|claude-code|p2");
  assert.equal(h.replay.at(-1), null, "replay dropped");
  assert.equal(h.calls.length, calls + 1);
});

test("sync with History closed makes no request; opening History lists", async () => {
  const h = harness();
  h.state.historyOpen = false;
  await h.ch.sync("live|claude-code|p1");
  assert.equal(h.calls.length, 0);
  assert.equal(h.els.wrap.hidden, false);
  h.state.historyOpen = true;
  h.ch.onHistoryOpen();
  assert.equal(h.calls[0], "/api/claude/sessions");
});

test("reopening History keeps an open session that is still listed, drops one that is gone", async () => {
  const h = harness();
  await listed(h);
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  h.ch.onHistoryOpen();
  await h.answer(200, {
    sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {}), sess("cs-zzzzzzzzzzzzzzzzzzzzzzzz", {})]
  });
  assert.equal(h.select.value, "cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(h.replay.length, 1, "the replay stays");
  h.ch.onHistoryOpen();
  await h.answer(200, { sessions: [sess("cs-zzzzzzzzzzzzzzzzzzzzzzzz", {})] });
  assert.equal(h.select.value, "");
  assert.equal(h.replay.at(-1), null, "the vanished session's replay is dropped");
});

// ---------- replay stage hand-over ----------

test("ReplayStage passes a Claude Code session row on as the live row it already is", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  const file = path.resolve(__dirname, "..", "..", "dashboard", "replay-stage.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  const RS = sandbox.window.ReplayStage;
  const row = ev(3, { role: "worker", active: ["worker"], kind: "delegates", message: "go" });
  const out = RS.mapHistoryEvent(row);
  assert.equal(out.length, 1);
  assert.equal(out[0].message, "go");
  assert.deepEqual(Array.from(out[0].active), ["worker"]);
  assert.equal(out[0].replay, true);
  assert.notEqual(out[0], row, "the row is copied, not shared");
  // a Cursor history event keeps its own mapping
  const cursor = RS.mapHistoryEvent({ type: "spawn", agentId: "a1", name: "worker", ts: "x" });
  assert.match(cursor[0].message, /^Spawn · worker/);
  // a row that is only partly live-shaped is not passed through
  const partial = RS.mapHistoryEvent({ type: "turn", role: "worker", kind: "x", agentId: "a" });
  assert.match(partial[0].message, /^Turn/);
});

test("the empty replay tree gets Claude Code wording while the picker is on, Cursor wording back off", async () => {
  const h = harness();
  h.ch.sync("live|claude-code|p1");
  await h.tick();
  assert.equal(h.copy.at(-1), "Choose a session above to replay it.");
  assert.doesNotMatch(h.copy.at(-1), /cursor/i);
  h.state.source = "cursor";
  h.ch.sync("live|cursor|p1");
  assert.equal(h.copy.at(-1), null, "the Cursor wording is back");
});

test("dropping an open replay tells the page once; nothing to drop tells it nothing", async () => {
  const dropped = [];
  const h = harness({ onReplayDropped: () => dropped.push(h.replay.length) });
  h.ch.sync("live|claude-code|p1");
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  h.select.choose("");
  assert.equal(dropped.length, 0, "no replay was open");
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  h.select.choose("");
  assert.deepEqual(dropped, [1], "told once, before the panel's replay is cleared");
  assert.equal(h.replay.at(-1), null);
  h.select.choose("");
  assert.equal(dropped.length, 1, "a second drop with no replay open is silent");
});

test("a project or source change with a replay open tells the page", async () => {
  const dropped = [];
  const h = harness({ onReplayDropped: () => dropped.push(1) });
  h.ch.sync("live|claude-code|p1");
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  h.select.choose("cs-aaaaaaaaaaaaaaaaaaaaaaaa");
  await h.answer(200, { events: [ev(0)] });
  h.ch.sync("live|claude-code|p2");
  assert.equal(dropped.length, 1, "project change");
  await h.answer(200, { sessions: [sess("cs-bbbbbbbbbbbbbbbbbbbbbbbb", {})] });
  h.select.choose("cs-bbbbbbbbbbbbbbbbbbbbbbbb");
  await h.answer(200, { events: [ev(0)] });
  h.state.source = "cursor";
  await h.ch.sync("live|cursor|p2");
  assert.equal(dropped.length, 2, "source change");
});

test("a sync while the History drawer is open lists sessions, not the open-History hint", async () => {
  const h = harness();
  /* The drawer is open (isHistoryOpen true) while the view is Stage: sync must list. */
  h.state.historyOpen = true;
  const done = h.ch.sync("live|claude-code|p1");
  assert.equal(h.calls.at(-1), "/api/claude/sessions", "sync fetches the list");
  await h.answer(200, { sessions: [sess("cs-aaaaaaaaaaaaaaaaaaaaaaaa", {})] });
  await done;
  assert.ok(!h.select.texts().includes("Open History to list sessions"), "no hint once open");
  assert.ok(h.select.values().includes("cs-aaaaaaaaaaaaaaaaaaaaaaaa"), "the session is listed");
});
