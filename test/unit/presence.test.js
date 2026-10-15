/**
 * Unit tests for dashboard/presence.js. Browser IIFE run in a vm sandbox with stubbed
 * elements, localStorage, timers, and fetch, so the presence state machine, the bridge
 * cue transitions, and the sync-age chip are covered without a browser.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "presence.js");

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    hidden: false,
    textContent: "",
    className: "",
    attrs: {},
    classes: {},
    listeners: {},
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    closest() {
      return el.__chip || null;
    },
    querySelector() {
      return null;
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

function load(overrides) {
  const els = {
    appEl: makeEl(),
    liveHint: makeEl(),
    liveBanner: makeEl(),
    liveCoach: makeEl(),
    hudSyncAge: makeEl("strong")
  };
  const chip = makeEl();
  els.hudSyncAge.__chip = chip;
  const store = {};
  const cues = [];
  const timers = [];
  const state = { mode: "live" };

  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      }
    },
    location: { protocol: "http:" },
    fetch: () => Promise.resolve({ ok: false }),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    Date: Date
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopPresence;
  assert.ok(mod, "presence.js must expose window.WorkshopPresence");

  const deps = Object.assign(
    {
      appEl: els.appEl,
      liveHint: els.liveHint,
      livePresenceBanner: els.liveBanner,
      liveCoach: els.liveCoach,
      hudSyncAge: els.hudSyncAge,
      sessionLog: { querySelector: () => null },
      bridgeUrl: "http://127.0.0.1:3847",
      sound: {
        play(name) {
          cues.push(name);
        }
      },
      getMode: () => state.mode,
      getProjectLabel: () => "My Project",
      isBridgeConnected: () => true,
      refreshEmptyLog() {}
    },
    overrides || {}
  );
  mod.init(deps);
  return { mod, els, chip, store, cues, timers, state, sandbox };
}

test("setLivePresence sets the presence value and the app attribute", () => {
  const t = load();
  t.mod.setLivePresence("streaming");
  assert.equal(t.mod.getPresence(), "streaming");
  assert.equal(t.els.appEl.getAttribute("data-live-presence"), "streaming");
  t.mod.setLivePresence(null);
  assert.equal(t.mod.getPresence(), null);
  assert.equal(t.els.appEl.getAttribute("data-live-presence"), null, "attribute cleared");
});

test("each presence state writes its own hint and banner copy", () => {
  const cases = [
    ["file-origin", /needs the bridge/, /file:\/\/ pages cannot stream/],
    ["connecting", /Connecting/, /Connecting to the Live bridge/],
    ["bridge-down", /Bridge offline/, /stations may look idle/],
    ["no-projects", /no Cursor projects/, /No Cursor projects found/],
    ["quiet-healthy", /Quiet/, /Workshop idle/],
    ["streaming", /Streaming · My Project/, null]
  ];
  for (const [state, hintRe, bannerRe] of cases) {
    const t = load();
    t.mod.setLivePresence(state);
    assert.match(t.els.liveHint.textContent, hintRe, `${state} hint`);
    if (bannerRe) {
      assert.match(t.els.liveBanner.textContent, bannerRe, `${state} banner`);
      assert.equal(t.els.liveBanner.hidden, false, `${state} banner shown`);
    } else {
      assert.equal(t.els.liveBanner.hidden, true, "streaming hides the banner");
    }
  }
});

test("a bridge-down detail replaces the click-Reconnect copy", () => {
  const t = load();
  t.mod.setLivePresence("bridge-down", "retry 1/6 in 2s");
  assert.match(t.els.liveBanner.textContent, /retry 1\/6 in 2s/);
  assert.ok(
    !/click Reconnect/.test(t.els.liveBanner.textContent),
    "must not tell the user to click Reconnect while it is retrying"
  );
});

test("bridge cues fire on entry to down and once on recovery", () => {
  const t = load();
  t.mod.setLivePresence("connecting");
  assert.deepEqual(t.cues, [], "connecting is not a cue");

  t.mod.setLivePresence("bridge-down");
  assert.deepEqual(t.cues, ["bridgeDown"], "entering bridge-down cues once");

  t.mod.setLivePresence("bridge-down", "retry 1/6 in 1s");
  assert.deepEqual(t.cues, ["bridgeDown"], "staying down does not re-cue");

  /* A retry passes through connecting on the way back up. */
  t.mod.setLivePresence("connecting");
  assert.deepEqual(t.cues, ["bridgeDown"], "retrying is not yet 'up'");

  t.mod.setLivePresence("quiet-healthy");
  assert.deepEqual(t.cues, ["bridgeDown", "bridgeUp"], "recovering cues up after connecting");

  t.mod.setLivePresence("streaming");
  assert.deepEqual(t.cues, ["bridgeDown", "bridgeUp"], "staying healthy does not re-cue");
});

test("leaving bridge-down without recovering does not cue up", () => {
  const t = load();
  t.mod.setLivePresence("bridge-down");
  t.mod.setLivePresence("file-origin");
  assert.deepEqual(t.cues, ["bridgeDown"], "file-origin is not a recovery");
  t.mod.setLivePresence("bridge-down");
  assert.deepEqual(
    t.cues,
    ["bridgeDown", "bridgeDown"],
    "re-entering down after a non-recovery cues again"
  );
});

test("non-live mode hides the banner and never cues", () => {
  const t = load({ getMode: () => "demo" });
  t.mod.setLivePresence("bridge-down");
  assert.equal(t.els.liveBanner.hidden, true);
  assert.deepEqual(t.cues, [], "demo mode does not cue");
});

test("getMode demo hides the banner and coach", () => {
  const t = load({ getMode: () => "demo" });
  t.mod.setLivePresence("streaming");
  assert.equal(t.els.liveCoach.hidden, true);
});

test("scheduleQuietHealthy fires only from a connectable state", () => {
  const t = load();
  t.mod.setLivePresence("bridge-down");
  t.mod.scheduleQuietHealthy();
  assert.equal(t.timers.length, 0, "no timer while the bridge is down");

  t.mod.setLivePresence("streaming");
  t.mod.scheduleQuietHealthy();
  assert.equal(t.timers.length, 1, "a timer is scheduled while streaming");

  /* Running the timer moves a quiet bridge to quiet-healthy. */
  t.mod.setLivePresence("streaming");
  t.timers[0]();
  assert.equal(t.mod.getPresence(), "quiet-healthy");
});

test("scheduleQuietHealthy does nothing in demo mode", () => {
  const t = load({ getMode: () => "demo" });
  t.mod.scheduleQuietHealthy();
  assert.equal(t.timers.length, 0);
});

test("formatSyncAge renders the documented buckets", () => {
  const t = load();
  assert.equal(t.mod.formatSyncAge(null), "n/a");
  assert.equal(t.mod.formatSyncAge("not-a-date"), "n/a");
  assert.equal(t.mod.formatSyncAge(new Date().toISOString()), "just now");
  assert.equal(t.mod.formatSyncAge(new Date(Date.now() - 5000).toISOString()), "5s ago");
  assert.equal(t.mod.formatSyncAge(new Date(Date.now() - 90000).toISOString()), "1m ago");
  assert.equal(t.mod.formatSyncAge(new Date(Date.now() - 3 * 3600e3).toISOString()), "3h ago");
});

test("refreshSyncAgeChip shows n/a in demo and the age in live", () => {
  const demo = load({ getMode: () => "demo" });
  demo.mod.refreshSyncAgeChip();
  assert.equal(demo.els.hudSyncAge.textContent, "n/a");

  const live = load();
  live.mod.applyBridgeSyncMeta({ lastScanAt: new Date(Date.now() - 2000).toISOString() });
  assert.equal(live.els.hudSyncAge.textContent, "2s ago");
});

test("a stale scan marks the chip stale and a fresh one clears it", () => {
  const t = load();
  t.mod.applyBridgeSyncMeta({ lastScanAt: new Date(Date.now() - 600000).toISOString() });
  assert.equal(t.chip.classes.stale, true, "an old scan is stale");
  t.mod.applyBridgeSyncMeta({ lastScanAt: new Date().toISOString() });
  assert.notEqual(t.chip.classes.stale, true, "a fresh scan is not stale");
});

test("applyBridgeSyncMeta adopts the bridge poll interval", () => {
  const t = load();
  t.mod.applyBridgeSyncMeta({ pollMs: 1500, lastScanAt: new Date().toISOString() });
  assert.match(t.chip.getAttribute("title"), /~1500ms/, "poll interval reflected in the tip");
  t.mod.applyBridgeSyncMeta({ pollMs: "not-a-number", lastScanAt: new Date().toISOString() });
  assert.match(t.chip.getAttribute("title"), /~1500ms/, "a junk pollMs is ignored");
});

test("onboard helpers round-trip through storage", () => {
  const t = load();
  assert.equal(t.mod.hasSeenOnboard(), false, "unseen by default");
  t.mod.markOnboardSeen();
  assert.equal(t.mod.hasSeenOnboard(), true, "recorded");
});

test("the coach shows only for a live, connectable bridge the user has not seen", () => {
  const unseen = load();
  unseen.mod.setLivePresence("streaming");
  assert.equal(unseen.els.liveCoach.hidden, false, "coach shows on first live");

  const seen = load();
  seen.mod.markOnboardSeen();
  seen.mod.setLivePresence("streaming");
  assert.equal(seen.els.liveCoach.hidden, true, "coach hidden once seen");

  const down = load();
  down.mod.setLivePresence("bridge-down");
  assert.equal(down.els.liveCoach.hidden, true, "coach hidden while down");
});

test("noteLiveEvent records a timestamp used by the quiet check", () => {
  const t = load();
  assert.equal(t.mod.getLastEventAt(), 0, "no traffic yet");
  t.mod.noteLiveEvent();
  assert.ok(t.mod.getLastEventAt() > 0, "traffic timestamp recorded");
});
