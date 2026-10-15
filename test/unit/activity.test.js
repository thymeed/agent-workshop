/**
 * Direct unit tests for dashboard/activity.js. It is a browser IIFE, so it runs here in
 * a vm sandbox with a minimal DOM stub (createElement/appendChild/innerHTML/textContent)
 * and stub session deps. That covers the real logic - kind bucketing, the row cap, the
 * role filter, empty-state copy - without a browser.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "activity.js");

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    id: "",
    _html: "",
    textContent: "",
    children: [],
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    }
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._html;
    },
    set(v) {
      el._html = String(v);
      el.children = [];
    }
  });
  return el;
}

function load(deps) {
  const sessionLog = makeEl("section");
  const activityRead = makeEl("div");
  const activityEdit = makeEl("div");
  const registry = { logEmpty: null };

  const sandbox = {
    window: {},
    document: {
      createElement: makeEl,
      getElementById(id) {
        if (id === "logEmpty") return registry.logEmpty;
        return null;
      }
    },
    __registry: registry
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopActivity;
  assert.ok(mod, "activity.js must expose window.WorkshopActivity");

  const base = {
    sessionLog,
    activityRead,
    activityEdit,
    escapeHtml: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, "~"),
    roleLabel: { opus: "Opus", advisor: "Fable", worker: "Sonnet" },
    stepMs: 1500,
    cap: 40,
    getMode: () => "live",
    getLivePresence: () => "streaming",
    noteSensitivePath: null,
    spawnCrate: null
  };
  mod.init(Object.assign(base, deps || {}));
  return { mod, sessionLog, activityRead, activityEdit, registry };
}

test("activityKindBucket maps tool kinds onto the two columns", () => {
  const { mod } = load();
  for (const k of ["edit", "edited", "write", "strReplace", "run"]) {
    assert.equal(mod.activityKindBucket(k), "edit", `${k} should be an edit`);
  }
  for (const k of ["read", "search", "grep", "glob", "webfetch"]) {
    assert.equal(mod.activityKindBucket(k), "read", `${k} should be a read`);
  }
  assert.equal(mod.activityKindBucket(""), "read", "unknown kinds default to read");
  assert.equal(mod.activityKindBucket(null), "read");
  assert.equal(mod.activityKindBucket(undefined), "read");
});

test("emptyLogMessage varies with mode and presence", () => {
  const cases = [
    ["demo", null, /choose Demo/],
    ["live", "file-origin", /needs the bridge/],
    ["live", "bridge-down", /click Reconnect/],
    ["live", "no-projects", /No Cursor projects/],
    ["live", "connecting", /Connecting/],
    ["live", "quiet-healthy", /idle/],
    ["live", "streaming", /waiting for transcript events/],
    ["live", null, /waiting for transcript events/]
  ];
  for (const [mode, presence, re] of cases) {
    const { mod } = load({ getMode: () => mode, getLivePresence: () => presence });
    assert.match(mod.emptyLogMessage(), re, `${mode}/${presence}`);
  }
});

test("append buckets, times, and unshifts rows", () => {
  const { mod } = load();
  mod.append({ kind: "write", role: "worker", path: "a.js", detail: "d" });
  const items = mod.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "edit", "write is bucketed to edit");
  assert.equal(items[0].role, "worker");
  assert.equal(items[0].path, "a.js");
  assert.equal(items[0].t, "00:00", "first row uses the initial clock label");
  mod.append({ kind: "read", role: "explorer", path: "b.js" });
  assert.equal(mod.getItems()[0].path, "b.js", "newest row is first");
  /* The clock label is driven by the log sequence, not the row count: activity rows do
     not advance it (unchanged from the pre-split behaviour). */
  assert.equal(mod.getItems()[0].t, "00:00", "activity rows alone do not advance the clock");
  mod.append({ kind: "read", role: "explorer", path: "c.js" }, "00:07");
  assert.equal(mod.getItems()[0].t, "00:07", "an explicit timestamp is honoured");
});

test("append caps the list and keeps the newest", () => {
  const { mod } = load({ cap: 3 });
  for (let i = 0; i < 6; i++) mod.append({ kind: "read", role: "worker", path: "f" + i });
  const items = mod.getItems();
  assert.equal(items.length, 3, "cap must hold");
  assert.equal(items[0].path, "f5", "newest kept");
  assert.equal(items[2].path, "f3", "oldest dropped");
});

test("append defaults missing fields rather than rendering undefined", () => {
  const { mod } = load();
  mod.append({ kind: "read" });
  const row = mod.getItems()[0];
  assert.equal(row.role, "parent");
  assert.equal(row.path, "n/a");
  assert.equal(row.detail, "");
});

test("append reports privacy and crate side effects", () => {
  const seen = { privacy: [], crates: [] };
  const { mod } = load({
    noteSensitivePath: (role, p) => seen.privacy.push([role, p]),
    spawnCrate: (e) => seen.crates.push(e)
  });
  mod.append({ kind: "edit", role: "parent", path: "secret.js" });
  assert.deepEqual(seen.privacy, [["opus", "secret.js"]], "parent maps to the opus card");
  assert.equal(seen.crates.length, 1, "every appended row spawns a crate");
  assert.equal(seen.crates[0].path, "secret.js");
});

test("render splits rows into the read and edit columns", () => {
  const { mod, activityRead, activityEdit } = load();
  mod.append({ kind: "read", role: "worker", path: "r.js" });
  mod.append({ kind: "edit", role: "worker", path: "e.js" });
  const readRows = activityRead.children.filter((c) => /activity-row/.test(c.className));
  const editRows = activityEdit.children.filter((c) => /activity-row/.test(c.className));
  assert.equal(readRows.length, 1, "one read row");
  assert.equal(editRows.length, 1, "one edit row");
  assert.ok(readRows[0].innerHTML.includes("r.js"), "read row carries its path");
  assert.ok(editRows[0].innerHTML.includes("e.js"), "edit row carries its path");
});

test("render escapes every interpolated field", () => {
  const { mod, activityRead } = load();
  mod.append({ kind: "read", role: "worker", path: "<img>", detail: '"onx"' });
  const html = activityRead.children[0].innerHTML;
  assert.ok(!html.includes("<img>"), "raw path markup must not survive");
  assert.ok(!html.includes('"onx"'), "raw detail quotes must not survive");
});

test("setFilter narrows both columns by card role", () => {
  const { mod, activityRead, activityEdit } = load();
  mod.append({ kind: "read", role: "worker", path: "w.js" });
  mod.append({ kind: "read", role: "parent", path: "p.js" });
  mod.setFilter("worker");
  assert.equal(
    activityRead.children.filter((c) => /activity-row/.test(c.className)).length,
    1,
    "only the worker row survives the filter"
  );
  assert.ok(activityRead.children[0].innerHTML.includes("w.js"));
  mod.setFilter(null);
  assert.equal(
    activityRead.children.filter((c) => /activity-row/.test(c.className)).length,
    2,
    "clearing the filter restores both rows"
  );
  assert.equal(activityEdit.children.length >= 1, true);
});

test("filtered empty state names the role", () => {
  const { mod, activityRead } = load();
  mod.setFilter("advisor");
  const empty = activityRead.children[0];
  assert.ok(/activity-empty/.test(empty.className));
  assert.match(empty.textContent, /Fable/, "empty copy should name the filtered role");
});

test("clear empties the list and both columns", () => {
  const { mod, activityRead, activityEdit } = load();
  mod.append({ kind: "read", role: "worker", path: "a.js" });
  mod.clear();
  assert.equal(mod.getItems().length, 0);
  assert.equal(activityRead.children.length, 1, "one empty-state node remains");
  assert.ok(/activity-empty/.test(activityRead.children[0].className));
  assert.ok(/activity-empty/.test(activityEdit.children[0].className));
  assert.equal(activityRead.children[0].id, "activityReadEmpty");
});

test("appendLog drops the empty state and appends a line", () => {
  const { mod, sessionLog, registry } = load();
  mod.resetLogEmpty();
  assert.equal(sessionLog.children.length, 1, "empty state present after reset");
  registry.logEmpty = sessionLog.children[0];
  mod.appendLog("worker", "editing 4 files", "fail");
  const lines = sessionLog.children.filter((c) => /log-line/.test(c.className));
  assert.equal(lines.length, 1, "a log line was appended");
  assert.equal(sessionLog.children.length, 1, "the empty state was removed");
  assert.ok(/role-worker/.test(lines[0].className));
  assert.ok(lines[0].innerHTML.includes("fail"), "message class carried through");
});

test("appendLog escapes role and message", () => {
  const { mod, sessionLog } = load();
  mod.appendLog("<b>role</b>", "<script>x</script>");
  const line = sessionLog.children.find((c) => /log-line/.test(c.className));
  assert.ok(!line.innerHTML.includes("<script>"), "message markup must not survive");
  assert.ok(!line.innerHTML.includes("<b>role</b>"), "role markup must not survive");
});

test("resetSeq zeroes the clock and clears the filter", () => {
  const { mod, activityRead } = load();
  mod.appendLog("parent", "one");
  mod.appendLog("parent", "two");
  mod.appendLog("parent", "three");
  /* Log lines advance the clock, which is what activity rows then read. */
  mod.append({ kind: "read", role: "worker", path: "a.js" });
  assert.equal(
    mod.getItems()[0].t,
    "00:04",
    "row reads the log-driven clock (3 steps x 1.5s = 4s)"
  );

  mod.setFilter("worker");
  mod.resetSeq();
  mod.append({ kind: "read", role: "worker", path: "b.js" });
  assert.equal(mod.getItems()[0].t, "00:00", "clock restarts from zero after resetSeq");
  assert.equal(
    activityRead.children.filter((c) => /activity-row/.test(c.className)).length,
    2,
    "filter cleared, so every row is visible"
  );
});

test("resetLogEmpty accepts explicit copy and defaults to the presence message", () => {
  const { mod, sessionLog } = load({ getMode: () => "live", getLivePresence: () => "bridge-down" });
  mod.resetLogEmpty("Replay session…");
  assert.equal(sessionLog.children[0].textContent, "Replay session…");
  mod.resetLogEmpty();
  assert.match(sessionLog.children[0].textContent, /click Reconnect/);
  assert.equal(sessionLog.children[0].id, "logEmpty", "the empty node keeps its id");
});
