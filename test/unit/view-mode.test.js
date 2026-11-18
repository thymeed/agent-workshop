/**
 * Unit tests for dashboard/view-mode.js. Browser IIFE, run in a vm sandbox with stubbed
 * elements and sessionStorage so the mode logic and focus policy are covered directly.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "view-mode.js");

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    open: false,
    hidden: false,
    textContent: "",
    className: "",
    attrs: {},
    classes: {},
    children: [],
    listeners: {},
    focused: false,
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    classList: null,
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    focus() {
      el.focused = true;
    },
    contains(other) {
      return el === other || el.children.includes(other);
    },
    querySelector() {
      return null;
    },
    appendChild(c) {
      el.children.push(c);
      return c;
    }
  };
  el.classList = {
    add(c) {
      el.classes[c] = true;
    },
    remove(c) {
      delete el.classes[c];
    },
    toggle(c, on) {
      if (on) el.classes[c] = true;
      else delete el.classes[c];
    },
    contains(c) {
      return !!el.classes[c];
    }
  };
  return el;
}

function load(store) {
  const session = store || {};
  const drawers = {
    drawerActivity: makeEl(),
    drawerBill: makeEl(),
    drawerLog: makeEl(),
    drawerStations: makeEl(),
    drawerInsights: makeEl(),
    drawerHistory: makeEl()
  };
  const el = {
    appEl: makeEl(),
    drawersEl: makeEl(),
    panelsBtn: makeEl(),
    historyHint: makeEl(),
    viewStageBtn: makeEl("button"),
    viewInsightsBtn: makeEl("button"),
    viewHistoryBtn: makeEl("button")
  };

  const sandbox = {
    window: {},
    sessionStorage: {
      getItem: (k) => (k in session ? session[k] : null),
      setItem: (k, v) => {
        session[k] = String(v);
      }
    },
    document: {
      getElementById: () => null,
      activeElement: null,
      body: makeEl("body")
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopViewMode;
  assert.ok(mod, "view-mode.js must expose window.WorkshopViewMode");
  return {
    mod,
    el,
    drawers,
    session,
    sandbox,
    init: (extra) =>
      mod.init(
        Object.assign(
          Object.assign({}, el, drawers, {
            sound: { play() {} },
            endReplaySession: () => {
              assert.ok(true);
            },
            getInsightsPanel: () => null
          }),
          extra || {}
        )
      )
  };
}

test("normalizeViewMode only accepts the three views", () => {
  const { mod } = load();
  assert.equal(mod.normalizeViewMode("insights"), "insights");
  assert.equal(mod.normalizeViewMode("history"), "history");
  assert.equal(mod.normalizeViewMode("stage"), "stage");
  assert.equal(mod.normalizeViewMode("HISTORY"), "history", "case-insensitive");
  assert.equal(mod.normalizeViewMode(""), "stage");
  assert.equal(mod.normalizeViewMode(null), "stage");
  assert.equal(mod.normalizeViewMode("nonsense"), "stage");
});

test("init applies the stored view and defaults to stage", () => {
  const a = load({ "cursorAgents.viewMode": "history" });
  a.init();
  assert.equal(a.mod.getMode(), "history", "stored view is restored");
  const b = load();
  b.init();
  assert.equal(b.mod.getMode(), "stage", "no stored view means stage");
  const c = load({ "cursorAgents.viewMode": "garbage" });
  c.init();
  assert.equal(c.mod.getMode(), "stage", "an unknown stored value falls back to stage");
});

test("setViewMode opens only the matching drawer", () => {
  const t = load();
  t.init();
  t.mod.setViewMode("history");
  assert.equal(t.drawers.drawerHistory.open, true);
  assert.equal(t.drawers.drawerActivity.open, false);
  assert.equal(t.drawers.drawerInsights.open, false);
  assert.equal(t.el.appEl.getAttribute("data-view-mode"), "history");

  t.mod.setViewMode("stage");
  assert.equal(t.drawers.drawerActivity.open, true);
  assert.equal(t.drawers.drawerHistory.open, false);

  t.mod.setViewMode("insights");
  assert.equal(t.drawers.drawerInsights.open, true);
  assert.equal(t.drawers.drawerActivity.open, false);
});

test("setViewMode persists unless skipPersist is set", () => {
  const t = load();
  t.init();
  t.mod.setViewMode("history");
  assert.equal(t.session["cursorAgents.viewMode"], "history");
  t.mod.setViewMode("insights", { skipPersist: true });
  assert.equal(t.session["cursorAgents.viewMode"], "history", "skipPersist must not write");
});

test("setViewMode marks the active header button", () => {
  const t = load();
  t.init();
  t.mod.setViewMode("insights");
  assert.equal(t.el.viewInsightsBtn.getAttribute("aria-pressed"), "true");
  assert.equal(t.el.viewStageBtn.getAttribute("aria-pressed"), "false");
  assert.equal(t.el.viewHistoryBtn.getAttribute("aria-pressed"), "false");
});

test("focus is reclaimed only when the hidden sheet held it", () => {
  const t = load();
  t.init();
  /* Nothing focused: focus must not be stolen by the view change. */
  t.sandbox.document.activeElement = null;
  t.el.viewStageBtn.focused = false;
  t.mod.setViewMode("history");
  assert.equal(t.el.viewStageBtn.focused, false, "a view change must not steal focus");

  /* Focus inside the History sheet, then switch to Stage: it must come back. */
  t.sandbox.document.activeElement = t.drawers.drawerHistory;
  t.el.viewHistoryBtn.focused = false;
  t.mod.setViewMode("stage");
  assert.equal(
    t.el.viewStageBtn.focused,
    true,
    "hiding the sheet that held focus must return focus to the view control"
  );
});

test("togglePanels opens then closes the panel set", () => {
  const t = load();
  t.init();
  t.mod.setViewMode("stage");
  t.mod.togglePanels();
  assert.equal(t.drawers.drawerBill.open, true);
  assert.equal(t.drawers.drawerLog.open, true);
  assert.equal(t.el.panelsBtn.getAttribute("aria-pressed"), "true");
  t.mod.togglePanels();
  assert.equal(t.drawers.drawerBill.open, false);
  assert.equal(t.el.panelsBtn.getAttribute("aria-pressed"), "false");
});

test("bindViewModeButton switches the view on click", () => {
  const t = load();
  t.init();
  const btn = makeEl("button");
  t.mod.bindViewModeButton(btn, "insights");
  assert.equal(btn.listeners.click.length, 1, "one click handler bound");
  btn.listeners.click[0]();
  assert.equal(t.mod.getMode(), "insights");
});

test("updateHistoryHint toggles its copy", () => {
  const t = load();
  t.init();
  t.mod.updateHistoryHint(true);
  assert.match(t.el.historyHint.textContent, /driving/);
  t.mod.updateHistoryHint(false);
  assert.match(t.el.historyHint.textContent, /Play or scrub/);
});

test("History off: every way in lands on Stage and the header button is hidden", () => {
  const t = load();
  t.init();
  t.mod.setHistoryAllowed(false);
  assert.equal(t.el.viewHistoryBtn.hidden, true, "History button is hidden");
  t.mod.setViewMode("history"); // what a project pick does
  assert.equal(t.mod.getMode(), "stage");
  assert.equal(t.el.appEl.getAttribute("data-view-mode"), "stage");
  assert.equal(t.session["cursorAgents.viewMode"], "stage", "the blocked view is not stored");
  t.mod.bindViewModeButton(t.el.viewHistoryBtn, "history");
  t.el.viewHistoryBtn.listeners.click[0]();
  assert.equal(t.mod.getMode(), "stage", "the header button cannot open History either");
  t.mod.setViewMode("insights");
  assert.equal(t.mod.getMode(), "insights", "other views still work");
});

test("History on again: the button returns and a pick opens History", () => {
  const t = load();
  t.init();
  t.mod.setHistoryAllowed(false);
  t.mod.setHistoryAllowed(true);
  assert.equal(t.el.viewHistoryBtn.hidden, false);
  t.mod.setViewMode("history");
  assert.equal(t.mod.getMode(), "history", "a Cursor pick may open History");
});

test("turning History off while it is open returns to Stage", () => {
  const t = load();
  t.init();
  t.mod.setViewMode("history");
  assert.equal(t.mod.getMode(), "history");
  t.mod.setHistoryAllowed(false);
  assert.equal(t.mod.getMode(), "stage");
  assert.equal(t.el.appEl.getAttribute("data-view-mode"), "stage");
});

test("a stored History view is dropped once History turns off", () => {
  const t = load({ "cursorAgents.viewMode": "history" });
  t.init();
  assert.equal(t.mod.getMode(), "history", "Demo and Cursor restore it");
  t.mod.setHistoryAllowed(false);
  assert.equal(t.mod.getMode(), "stage");
  const u = load({ "cursorAgents.viewMode": "history" });
  u.mod.setHistoryAllowed(false); // before init, like a stored Claude Code choice
  u.init();
  assert.equal(u.mod.getMode(), "stage", "init cannot restore History while it is off");
});

test("hiding the History button while it has focus moves focus to the Stage button", () => {
  const t = load();
  t.init();
  t.sandbox.document.activeElement = t.el.viewHistoryBtn;
  t.mod.setHistoryAllowed(false);
  assert.equal(t.el.viewStageBtn.focused, true, "focus lands on Stage, not the page top");
  const u = load();
  u.init();
  u.sandbox.document.activeElement = u.el.viewInsightsBtn;
  u.mod.setHistoryAllowed(false);
  assert.equal(u.el.viewStageBtn.focused, false, "focus elsewhere is left alone");
});

test("with no WorkshopSource the page source is claude-code, the default", () => {
  const t = load();
  assert.equal(t.sandbox.window.WorkshopSource, undefined);
  assert.equal(t.mod.currentSource(), "claude-code");
  t.sandbox.window.WorkshopSource = { getSource: () => "cursor" };
  assert.equal(t.mod.currentSource(), "cursor", "a loaded switch is asked");
});

test("with no WorkshopSource, Live turns History off like Claude Code; Demo keeps it", () => {
  const t = load();
  t.init();
  t.mod.syncHistoryAllowed("live");
  assert.equal(t.el.viewHistoryBtn.hidden, true, "Live with the default source: History off");
  t.mod.syncHistoryAllowed("demo");
  assert.equal(t.el.viewHistoryBtn.hidden, false, "Demo: History on");
  t.sandbox.window.WorkshopSource = { getSource: () => "cursor" };
  t.mod.syncHistoryAllowed("live");
  assert.equal(t.el.viewHistoryBtn.hidden, false, "Live reading Cursor: History on");
  t.sandbox.window.WorkshopSource = { getSource: () => "claude-code" };
  t.mod.syncHistoryAllowed("live");
  assert.equal(t.el.viewHistoryBtn.hidden, true, "Live reading Claude Code: History off");
});
