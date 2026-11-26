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
    querySelector(sel) {
      return el.found && el.found[sel] ? el.found[sel] : null;
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
      body: makeEl("body"),
      docListeners: {},
      addEventListener(type, fn) {
        (this.docListeners[type] = this.docListeners[type] || []).push(fn);
      }
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
  t.mod.setViewMode("history");
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

test("History is allowed in Demo and in Live on both sources, Claude Code included", () => {
  const t = load();
  t.init();
  for (const mode of ["demo", "live"]) {
    for (const source of [undefined, "cursor", "claude-code"]) {
      t.sandbox.window.WorkshopSource = source ? { getSource: () => source } : undefined;
      t.mod.syncHistoryAllowed(mode);
      assert.equal(t.el.viewHistoryBtn.hidden, false, mode + " / " + source + ": button shown");
    }
  }
  t.sandbox.window.WorkshopSource = { getSource: () => "claude-code" };
  t.mod.syncHistoryAllowed("live");
  t.mod.setViewMode("history");
  assert.equal(t.mod.getMode(), "history", "the header button opens History on Claude Code");
});

test("a stored History view is restored in Live on Claude Code", () => {
  const t = load({ "cursorAgents.viewMode": "history" });
  t.sandbox.window.WorkshopSource = { getSource: () => "claude-code" };
  t.init();
  t.mod.syncHistoryAllowed("live");
  assert.equal(t.mod.getMode(), "history");
});

test("a project pick opens History on Cursor and stays put on Claude Code", () => {
  const t = load();
  t.init();
  t.sandbox.window.WorkshopSource = { getSource: () => "cursor" };
  assert.equal(t.mod.navigateAfterProjectPick(), true);
  assert.equal(t.mod.getMode(), "history", "Cursor: a pick opens History");
  t.mod.setViewMode("stage");
  t.sandbox.window.WorkshopSource = { getSource: () => "claude-code" };
  assert.equal(t.mod.navigateAfterProjectPick(), false);
  assert.equal(t.mod.getMode(), "stage", "Claude Code: a pick stays on Stage");
  t.mod.setViewMode("insights");
  t.mod.navigateAfterProjectPick();
  assert.equal(t.mod.getMode(), "insights", "Claude Code: a pick keeps the current view");
  t.mod.setViewMode("history");
  t.mod.navigateAfterProjectPick();
  assert.equal(t.mod.getMode(), "history", "Claude Code: already on History stays there");
});

test("onHistoryOpen runs each time History is entered, and not for other views", () => {
  let opened = 0;
  const t = load();
  t.init({ onHistoryOpen: () => (opened += 1) });
  t.mod.setViewMode("insights");
  t.mod.setViewMode("stage");
  assert.equal(opened, 0);
  t.mod.setViewMode("history");
  assert.equal(opened, 1);
  t.mod.setViewMode("stage");
  t.mod.setViewMode("history");
  assert.equal(opened, 2);
});

test("onHistoryLeave runs on every non-History view, never on History", () => {
  let left = 0;
  const t = load();
  t.init({ onHistoryLeave: () => (left += 1) });
  left = 0; // init itself lands on a view
  t.mod.setViewMode("history");
  assert.equal(left, 0, "entering History does not leave it");
  t.mod.setViewMode("insights");
  assert.equal(left, 1, "Insights leaves History");
  t.mod.setViewMode("history");
  t.mod.setViewMode("stage");
  assert.equal(left, 2, "Stage leaves History");
});

test("a History drawer opened from Stage or Insights lists sessions; closing does not", () => {
  let opened = 0;
  const t = load();
  t.init({ onHistoryOpen: () => (opened += 1) });
  /* The summary opens the drawer directly; the toggle event follows. */
  t.drawers.drawerHistory.open = true;
  t.drawers.drawerHistory.listeners.toggle.forEach((fn) => fn());
  assert.equal(t.mod.getMode(), "stage", "the view stays on Stage");
  assert.equal(opened, 1, "a drawer opened from Stage calls onHistoryOpen");
  t.drawers.drawerHistory.open = false;
  t.drawers.drawerHistory.listeners.toggle.forEach((fn) => fn());
  assert.equal(opened, 1, "closing the drawer does not call onHistoryOpen");
});

test("entering History through the view lists sessions once, not twice", () => {
  let opened = 0;
  const t = load();
  t.init({ onHistoryOpen: () => (opened += 1) });
  t.mod.setViewMode("history");
  t.drawers.drawerHistory.listeners.toggle.forEach((fn) => fn());
  assert.equal(opened, 1, "the view call alone; the toggle does not repeat it");
});

/** A load() whose document serves a replay host and whose panel records mountReplay. */
function loadWithHost(available) {
  const t = load();
  const host = makeEl();
  host.scrollIntoView = () => {
    t.scrolls += 1;
  };
  t.scrolls = 0;
  t.mounts = 0;
  t.sandbox.document.getElementById = (id) => (id === "historyReplayHost" ? host : null);
  const panel = {
    mountReplay: () => (t.mounts += 1),
    showTab() {},
    pause() {}
  };
  t.state = { available, opened: 0, left: 0 };
  t.init({
    getInsightsPanel: () => panel,
    drawerReplayAvailable: () => t.state.available,
    onHistoryOpen: () => {
      t.state.opened += 1;
      /* Listing sessions can drop a replay, which repaints the transport and drops focus. */
      if (t.state.dropFocusOnOpen) t.sandbox.document.activeElement = t.sandbox.document.body;
    },
    onHistoryLeave: () => (t.state.left += 1)
  });
  return t;
}

const toggle = (t) => t.drawers.drawerHistory.listeners.toggle.forEach((fn) => fn());

test("isHistoryOpen is true for the History view and for an open drawer on any view", () => {
  const t = load();
  t.init();
  assert.equal(t.mod.isHistoryOpen(), false, "Stage with the drawer closed");
  t.drawers.drawerHistory.open = true;
  assert.equal(t.mod.getMode(), "stage");
  assert.equal(t.mod.isHistoryOpen(), true, "Stage with the drawer open");
  t.mod.setViewMode("insights");
  t.drawers.drawerHistory.open = true;
  assert.equal(t.mod.isHistoryOpen(), true, "Insights with the drawer open");
  t.drawers.drawerHistory.open = false;
  assert.equal(t.mod.isHistoryOpen(), false, "Insights with the drawer closed");
  t.mod.setViewMode("history");
  t.drawers.drawerHistory.open = false;
  assert.equal(t.mod.isHistoryOpen(), true, "the History view counts as open");
});

test("a drawer opened from Stage mounts the shared transport without scrolling when it can replay", () => {
  const t = loadWithHost(true);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(t.mod.getMode(), "stage");
  assert.equal(t.state.opened, 1, "sessions are listed");
  assert.equal(t.mounts, 1, "the shared transport is mounted into the host");
  assert.equal(t.scrolls, 0, "the page is not scrolled");
  assert.match(t.el.historyHint.textContent, /Pick a session/);
  assert.doesNotMatch(t.el.historyHint.textContent, /driving/);
});

test("a drawer opened from Stage mounts nothing where no session can be replayed", () => {
  const t = loadWithHost(false);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(t.mounts, 0, "Cursor and Demo keep their old behavior");
  assert.equal(t.el.historyHint.textContent, "Open the History tab to replay sessions.");
});

test("closing the drawer outside the History view hands the stage back; in History it does not", () => {
  const t = loadWithHost(true);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  const leftBefore = t.state.left;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(t.state.left, leftBefore + 1, "the stage is released");
  t.mod.setViewMode("history");
  const leftInHistory = t.state.left;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(t.state.left, leftInHistory, "History view: closing the sheet leaves the replay");
});

test("the History view still scrolls to Play when it mounts the transport", () => {
  const t = loadWithHost(true);
  t.mod.setViewMode("history");
  assert.ok(t.mounts >= 1);
  assert.ok(t.scrolls >= 1, "History keeps its scroll");
});

test("a mode or source change mounts the transport for a drawer that is already open", () => {
  const t = loadWithHost(false);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(t.mounts, 0);
  t.state.available = true;
  t.mod.syncHistoryAllowed();
  assert.equal(t.mounts, 1, "now replayable: mounted");
  assert.match(t.el.historyHint.textContent, /Pick a session/);
});

test("the hint is not rewritten when the words do not change", () => {
  const t = load();
  let writes = 0;
  let text = "";
  Object.defineProperty(t.el.historyHint, "textContent", {
    get: () => text,
    set: (v) => {
      writes += 1;
      text = v;
    }
  });
  t.init();
  t.mod.setViewMode("history");
  const before = writes;
  t.mod.updateHistoryHint(false);
  t.mod.updateHistoryHint(false);
  t.mod.setViewMode("history");
  assert.equal(writes, before, "same state, same text: no write to the live region");
  t.mod.updateHistoryHint(true);
  assert.equal(writes, before + 1, "a changed state still writes");
  assert.equal(text, "Replay driving stage");
});

test("every History hint is a single sentence", () => {
  const t = loadWithHost(true);
  const seen = [];
  t.drawers.drawerHistory.open = true;
  toggle(t);
  seen.push(t.el.historyHint.textContent);
  t.state.available = false;
  t.mod.syncHistoryAllowed();
  seen.push(t.el.historyHint.textContent);
  t.mod.setViewMode("history");
  seen.push(t.el.historyHint.textContent);
  assert.equal(seen.length, 3);
  for (const h of seen) {
    assert.equal(h.split(/[.!?](s|$)/).filter((x) => x.trim() && !/^s*$/.test(x)).length, 1, h);
  }
});

test("a remount keeps focus on the same transport control, else moves it to the summary", () => {
  const t = loadWithHost(true);
  const host = t.sandbox.document.getElementById("historyReplayHost");
  const summary = makeEl("summary");
  t.drawers.drawerHistory.found = { summary };
  const oldPlay = makeEl("button");
  oldPlay.attrs["data-replay-play"] = "";
  host.children.push(oldPlay);
  const newPlay = makeEl("button");
  host.found = { "[data-replay-play]": newPlay };
  t.sandbox.document.activeElement = oldPlay;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(newPlay.focused, true, "the repainted Play button takes focus");
  assert.equal(summary.focused, false);
  /* The control is gone after the repaint: the summary gets it. */
  host.found = {};
  t.sandbox.document.activeElement = oldPlay;
  toggle(t);
  assert.equal(summary.focused, true, "no matching control: the drawer trigger");
});

test("focus on a transport control survives the session listing repainting it", () => {
  const t = loadWithHost(true);
  t.state.dropFocusOnOpen = true;
  const host = t.sandbox.document.getElementById("historyReplayHost");
  const summary = makeEl("summary");
  t.drawers.drawerHistory.found = { summary };
  const oldPlay = makeEl("button");
  oldPlay.attrs["data-replay-play"] = "";
  host.children.push(oldPlay);
  const newPlay = makeEl("button");
  host.found = { "[data-replay-play]": newPlay };
  t.sandbox.document.activeElement = oldPlay;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(t.state.opened, 1);
  assert.equal(newPlay.focused, true, "focus noted before the listing, restored after the mount");
});

test("a remount never steals focus from outside the transport", () => {
  const t = loadWithHost(true);
  const host = t.sandbox.document.getElementById("historyReplayHost");
  const summary = makeEl("summary");
  t.drawers.drawerHistory.found = { summary };
  const play = makeEl("button");
  host.found = { "[data-replay-play]": play };
  const other = makeEl("button");
  t.sandbox.document.activeElement = other;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  t.sandbox.document.activeElement = t.sandbox.document.body;
  toggle(t);
  assert.equal(play.focused, false);
  assert.equal(summary.focused, false);
  assert.equal(other.focused, false);
});

test("closing the drawer outside History moves focus from inside it to the summary", () => {
  const t = loadWithHost(true);
  const summary = makeEl("summary");
  const select = makeEl("select");
  t.drawers.drawerHistory.found = { summary };
  t.drawers.drawerHistory.children.push(select);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  /* Focus still inside when the toggle runs. */
  t.sandbox.document.activeElement = select;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focused, true, "focus inside the closed drawer goes to the summary");
});

test("closing the drawer after focus already dropped to the body still rescues it", () => {
  const t = loadWithHost(true);
  const summary = makeEl("summary");
  const select = makeEl("select");
  t.drawers.drawerHistory.found = { summary };
  t.drawers.drawerHistory.children.push(select);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  const doc = t.sandbox.document;
  doc.docListeners.focusin.forEach((fn) => fn({ target: select }));
  doc.activeElement = doc.body; // the browser blurred it when the content was hidden
  t.drawers.drawerHistory.open = false;
  doc.docListeners.focusout.forEach((fn) => fn({ target: select, relatedTarget: null }));
  toggle(t);
  assert.equal(summary.focused, true, "the last focus was in the drawer");
});

test("closing the drawer leaves focus alone when it was elsewhere", () => {
  const t = loadWithHost(true);
  const summary = makeEl("summary");
  const select = makeEl("select");
  const outside = makeEl("button");
  t.drawers.drawerHistory.found = { summary };
  t.drawers.drawerHistory.children.push(select);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  const doc = t.sandbox.document;
  doc.docListeners.focusin.forEach((fn) => fn({ target: select }));
  doc.docListeners.focusin.forEach((fn) => fn({ target: outside }));
  doc.activeElement = outside;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focused, false, "focus moved elsewhere first: not stolen");
  /* A click on blank page while the drawer is open also clears the memory. */
  t.drawers.drawerHistory.open = true;
  toggle(t);
  doc.docListeners.focusin.forEach((fn) => fn({ target: select }));
  doc.activeElement = doc.body;
  doc.docListeners.focusout.forEach((fn) => fn({ target: select, relatedTarget: null }));
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focused, false, "blank-page click while open: not stolen");
});

/** A summary whose focus() records the options it was called with. */
function recordingSummary() {
  const summary = makeEl("summary");
  summary.focusCalls = [];
  summary.focus = (opts) => {
    summary.focused = true;
    summary.focusCalls.push(opts);
  };
  return summary;
}

test("a rescue clears the drawer-focus memory: the next close does not rescue again", () => {
  const t = loadWithHost(true);
  const summary = recordingSummary();
  const select = makeEl("select");
  t.drawers.drawerHistory.found = { summary };
  t.drawers.drawerHistory.children.push(select);
  const doc = t.sandbox.document;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  doc.docListeners.focusin.forEach((fn) => fn({ target: select }));
  doc.activeElement = doc.body;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focusCalls.length, 1, "the first close rescues focus");
  /* Reopen and close with focus already on the body and no new focus inside the drawer. */
  t.drawers.drawerHistory.open = true;
  toggle(t);
  doc.activeElement = doc.body;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focusCalls.length, 1, "the memory was spent: no second rescue");
});

test("rescued and restored focus never scrolls the page (preventScroll: true)", () => {
  const t = loadWithHost(true);
  const summary = recordingSummary();
  const select = makeEl("select");
  t.drawers.drawerHistory.found = { summary };
  t.drawers.drawerHistory.children.push(select);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  t.sandbox.document.activeElement = select;
  t.drawers.drawerHistory.open = false;
  toggle(t);
  assert.equal(summary.focusCalls.length, 1);
  assert.deepEqual({ ...summary.focusCalls[0] }, { preventScroll: true }, "rescue to the summary");

  /* A remount that hands focus back to the same transport control. */
  const host = t.sandbox.document.getElementById("historyReplayHost");
  const oldPlay = makeEl("button");
  oldPlay.attrs["data-replay-play"] = "";
  host.children.push(oldPlay);
  const newPlay = makeEl("button");
  const calls = [];
  newPlay.focus = (opts) => calls.push(opts);
  host.found = { "[data-replay-play]": newPlay };
  t.sandbox.document.activeElement = oldPlay;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0] }, { preventScroll: true }, "restore to the transport control");
});

test("focus on a control inside .insights-replay (outside the host) counts as in the transport", () => {
  const t = loadWithHost(true);
  const host = t.sandbox.document.getElementById("historyReplayHost");
  const summary = recordingSummary();
  t.drawers.drawerHistory.found = { summary };
  /* The transport is still painted in the Insights sheet, not in the drawer's host. */
  const elsewhere = makeEl("button");
  elsewhere.attrs["data-replay-pause"] = "";
  elsewhere.closest = (sel) => (sel === ".insights-replay" ? makeEl("div") : null);
  const newPause = makeEl("button");
  host.found = { "[data-replay-pause]": newPause };
  t.sandbox.document.activeElement = elsewhere;
  t.drawers.drawerHistory.open = true;
  toggle(t);
  assert.equal(newPause.focused, true, "focus follows the control into the drawer's host");
  assert.equal(summary.focusCalls.length, 0);
});

test("remountHistoryReplayIfNeeded remounts an open drawer outside History, without scrolling", () => {
  const t = loadWithHost(true);
  t.drawers.drawerHistory.open = true;
  toggle(t);
  const mounts = t.mounts;
  const scrolls = t.scrolls;
  t.mod.remountHistoryReplayIfNeeded();
  assert.equal(t.mounts, mounts + 1, "the open drawer is remounted");
  assert.equal(t.scrolls, scrolls, "no scroll outside the History view");
  t.state.available = false;
  t.mod.remountHistoryReplayIfNeeded();
  assert.equal(t.mounts, mounts + 1, "nothing to replay: no remount");
  t.state.available = true;
  t.drawers.drawerHistory.open = false;
  t.mod.remountHistoryReplayIfNeeded();
  assert.equal(t.mounts, mounts + 1, "a closed drawer is not remounted");
});

test("leaving History resets the driving hint", () => {
  const t = loadWithHost(false);
  t.mod.setViewMode("history");
  t.mod.updateHistoryHint(true);
  assert.equal(t.el.historyHint.textContent, "Replay driving stage");
  t.mod.setViewMode("stage");
  assert.equal(t.el.historyHint.textContent, "Open the History tab to replay sessions.");
  t.mod.setViewMode("history");
  t.mod.updateHistoryHint(true);
  t.mod.setViewMode("insights");
  assert.equal(t.el.historyHint.textContent, "Open the History tab to replay sessions.");
});
