/**
 * Unit tests for dashboard/source-switch.js. Browser IIFE run in a vm sandbox with stubbed
 * elements, storage, and fetch, so the choice, the reconcile rule, the in-flight guard, and
 * failure handling are covered without a bridge.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "source-switch.js");
const PROJECTS_SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "projects.js");
const KEY = "ca.source.v1";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* Results from the vm sandbox carry the sandbox's prototypes: compare plain copies. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function makeEl() {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    listeners,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name)
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return attrs[k] === undefined ? null : attrs[k];
    },
    hasAttribute(k) {
      return attrs[k] !== undefined;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    click() {
      (listeners.click || []).forEach((fn) => fn());
    }
  };
}

function memoryStorage(seed) {
  const store = Object.assign({}, seed || {});
  return {
    store,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    }
  };
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * opts.seed: stored localStorage values. Left out, the page starts from a stored "cursor"
 * (most tests below are about switching away from it); pass `seed: {}` for a first visit. opts.storage: a storage object (null or throwing
 * ones too). opts.answer(body): the bridge's answer (a response or a promise). opts.hold: keep
 * each POST pending until the test calls holds[i]().
 */
function setup(opts) {
  opts = opts || {};
  const els = {
    cursorButton: makeEl(),
    claudeButton: makeEl(),
    group: makeEl(),
    chip: makeEl(),
    chipValue: makeEl(),
    liveHint: makeEl()
  };
  const calls = [];
  const holds = [];
  const changed = [];
  function answer(body) {
    if (opts.answer) return opts.answer(body);
    return reply(200, { ok: true, source: body.source });
  }
  const sandbox = { window: {} };
  sandbox.fetch = (url, o) => {
    const body = JSON.parse(o.body);
    calls.push({ url, opts: o, body });
    if (opts.hold) {
      return new Promise((resolve) => holds.push(() => resolve(answer(body))));
    }
    return Promise.resolve(answer(body));
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopSource;
  assert.ok(mod, "source-switch.js must expose window.WorkshopSource");
  const storage =
    opts.storage === undefined
      ? memoryStorage(opts.seed === undefined ? { [KEY]: "cursor" } : opts.seed)
      : opts.storage;
  mod.init(
    Object.assign(
      {
        cursorButton: els.cursorButton,
        claudeButton: els.claudeButton,
        group: els.group,
        chip: els.chip,
        chipValue: els.chipValue,
        liveHint: els.liveHint,
        bridgeUrl: "http://127.0.0.1:3847",
        storage,
        onChanged: (src) => changed.push(src)
      },
      opts.deps || {}
    )
  );
  return { mod, els, calls, holds, changed, storage };
}

test("with no stored choice the default is claude-code and its button and chip show it", () => {
  const t = setup({ seed: {} });
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.claudeButton.getAttribute("aria-pressed"), "true");
  assert.equal(t.els.cursorButton.getAttribute("aria-pressed"), "false");
  assert.equal(t.els.claudeButton.classList.contains("on"), true);
  assert.equal(t.els.cursorButton.classList.contains("on"), false);
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  assert.equal(t.storage.store[KEY], undefined, "showing the default stores nothing");
});

test("a stored cursor choice still wins over the default", () => {
  const t = setup({ seed: { [KEY]: "cursor" } });
  assert.equal(t.mod.getSource(), "cursor");
  assert.equal(t.els.cursorButton.getAttribute("aria-pressed"), "true");
  assert.equal(t.els.claudeButton.getAttribute("aria-pressed"), "false");
  assert.equal(t.els.chipValue.textContent, "Cursor");
});

test("a stored claude-code choice is respected at startup", () => {
  const t = setup({ seed: { [KEY]: "claude-code" } });
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.claudeButton.getAttribute("aria-pressed"), "true");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
});

test("any other stored value falls back to the claude-code default", () => {
  for (const bad of ["Claude Code", "claude", "Cursor", "nope", ""]) {
    const t = setup({ seed: { [KEY]: bad } });
    assert.equal(t.mod.getSource(), "claude-code", "stored " + JSON.stringify(bad));
    assert.equal(t.els.chipValue.textContent, "Claude Code", "stored " + JSON.stringify(bad));
  }
});

test("storage that throws leaves claude-code and does not break a switch", async () => {
  const boom = {
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    }
  };
  const t = setup({ storage: boom });
  assert.equal(t.mod.getSource(), "claude-code");
  const r = await t.mod.setSource("cursor");
  assert.equal(r.ok, true, "the switch still succeeds without storage");
  assert.equal(t.mod.getSource(), "cursor");
});

test("no storage at all also gives the claude-code default", () => {
  const t = setup({ storage: null });
  assert.equal(t.mod.getSource(), "claude-code");
});

test("first connect: a bridge already on claude-code and no stored choice sends no POST", async () => {
  const t = setup({ seed: {} });
  const r = await t.mod.reconcile("claude-code");
  assert.equal(r, null);
  assert.equal(t.calls.length, 0, "page and bridge agree on the default");
  assert.deepEqual(t.changed, []);
  assert.equal(t.mod.getSource(), "claude-code");
});

test("first connect: a stored cursor choice and a bridge on claude-code POSTs once to switch", async () => {
  const t = setup({ seed: { [KEY]: "cursor" } });
  const r = await t.mod.reconcile("claude-code");
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body, { source: "cursor" });
  assert.equal(t.mod.getSource(), "cursor");
  assert.deepEqual(t.changed, ["cursor"]);
});

test("first connect: no stored choice and a bridge on cursor (--dir) POSTs once to claude-code", async () => {
  const t = setup({ seed: {} });
  const r = await t.mod.reconcile("cursor");
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body, { source: "claude-code" });
  assert.equal(t.mod.getSource(), "claude-code");
});

test("a hello with no source (older bridge) sends nothing and keeps the default showing", async () => {
  const t = setup({ seed: {} });
  assert.equal(await t.mod.reconcile(undefined), null);
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
});

test("setVisible shows the seg and the chip in Live and hides both otherwise", () => {
  const t = setup();
  t.mod.setVisible(true);
  assert.equal(t.els.group.hidden, false);
  assert.equal(t.els.chip.hidden, false);
  t.mod.setVisible(false);
  assert.equal(t.els.group.hidden, true);
  assert.equal(t.els.chip.hidden, true);
});

test("a user switch POSTs /api/source with the bridge header, then stores and applies it", async () => {
  const t = setup();
  const r = await t.mod.setSource("claude-code");
  assert.deepEqual(plain(r), { ok: true, source: "claude-code" });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, "http://127.0.0.1:3847/api/source");
  assert.equal(t.calls[0].opts.method, "POST");
  assert.equal(t.calls[0].opts.headers["X-Cursor-Bridge"], "1");
  assert.deepEqual(t.calls[0].body, { source: "claude-code" });
  assert.equal(t.storage.store[KEY], "claude-code", "the choice is stored");
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.claudeButton.getAttribute("aria-pressed"), "true");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  assert.deepEqual(t.changed, ["claude-code"], "follow-up runs once");
});

test("a pick of the source already in use sends nothing", async () => {
  const t = setup();
  const r = await t.mod.setSource("cursor");
  assert.deepEqual(plain(r), { ok: true, source: "cursor", unchanged: true });
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.changed, []);
});

test("an unknown source is refused without a POST", async () => {
  const t = setup();
  const r = await t.mod.setSource("nope");
  assert.equal(r.ok, false);
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "cursor");
});

test("a second switch while one is in flight is ignored and the buttons are disabled", async () => {
  const t = setup({ hold: true });
  const first = t.mod.setSource("claude-code");
  assert.equal(t.els.claudeButton.getAttribute("aria-disabled"), "true", "busy during the flight");
  assert.equal(t.els.cursorButton.getAttribute("aria-disabled"), "true");
  assert.equal(t.els.claudeButton.disabled, false, "never disabled: focus must stay on the button");
  const busy = await t.mod.setSource("cursor");
  assert.equal(busy.ok, false);
  assert.equal(busy.busy, true);
  assert.equal(t.calls.length, 1, "only one POST while in flight");
  t.holds[0]();
  assert.equal((await first).ok, true);
  assert.equal(t.els.claudeButton.hasAttribute("aria-disabled"), false, "idle after the flight");
  assert.equal(t.els.cursorButton.hasAttribute("aria-disabled"), false, "idle after the flight");
});

test("a refused switch restores the previous buttons, keeps the choice, and shows the error", async () => {
  const t = setup({
    answer: () => reply(403, { ok: false, error: "Forbidden · same-origin required" })
  });
  const r = await t.mod.setSource("claude-code");
  assert.deepEqual(plain(r), { ok: false, error: "Forbidden · same-origin required" });
  assert.equal(t.els.cursorButton.getAttribute("aria-pressed"), "true", "previous state restored");
  assert.equal(t.els.claudeButton.getAttribute("aria-pressed"), "false");
  assert.equal(t.els.cursorButton.hasAttribute("aria-disabled"), false, "idle after a refusal");
  assert.equal(t.els.liveHint.hidden, false);
  assert.equal(t.els.liveHint.className, "live-hint err");
  assert.equal(t.els.liveHint.textContent, "Forbidden · same-origin required");
  assert.equal(t.storage.store[KEY], "cursor", "a failed switch leaves the stored choice");
  assert.equal(t.mod.getSource(), "cursor");
  assert.deepEqual(t.changed, [], "no follow-up on failure");
});

test("a refused switch with no error body reports the status", async () => {
  const t = setup({ answer: () => reply(500, {}) });
  const r = await t.mod.setSource("claude-code");
  assert.equal(r.error, "Source switch failed (500)");
  assert.equal(t.els.liveHint.textContent, "Source switch failed (500)");
});

test("a network failure reports a plain error without throwing", async () => {
  const t = setup({ answer: () => Promise.reject(new Error("offline")) });
  const r = await t.mod.setSource("claude-code");
  assert.deepEqual(plain(r), { ok: false, error: "Could not switch source" });
  assert.equal(t.mod.getSource(), "cursor");
});

test("reconcile POSTs the stored choice once, then does nothing on later connects", async () => {
  const t = setup({ seed: { [KEY]: "claude-code" }, hold: true });
  const first = t.mod.reconcile("cursor");
  const again = await t.mod.reconcile("cursor");
  assert.equal(again, null, "no second attempt while the first is in flight");
  assert.equal(t.calls.length, 1, "exactly one POST");
  assert.deepEqual(t.calls[0].body, { source: "claude-code" }, "the stored choice wins");
  t.holds[0]();
  assert.equal((await first).ok, true);
  assert.equal(t.mod.getSource(), "claude-code");
  assert.deepEqual(t.changed, ["claude-code"]);

  await t.mod.reconcile("claude-code");
  assert.equal(t.calls.length, 1, "a matching bridge is not switched again");
});

test("reconcile with a matching bridge sends nothing", async () => {
  const t = setup({ seed: { [KEY]: "claude-code" } });
  await t.mod.reconcile("claude-code");
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "claude-code");
});

test("reconcile ignores a missing or unknown bridge source (older bridge)", async () => {
  const t = setup({ seed: { [KEY]: "claude-code" } });
  assert.equal(await t.mod.reconcile(undefined), null);
  assert.equal(await t.mod.reconcile("elsewhere"), null);
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "claude-code");
});

test("a failed reconcile shows what the bridge is actually reading and stores nothing", async () => {
  const t = setup({ answer: () => reply(500, { ok: false, error: "busy" }) });
  const r = await t.mod.reconcile("claude-code");
  assert.equal(r.ok, false);
  assert.equal(t.mod.getSource(), "claude-code", "the bridge's reading is shown");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  assert.equal(t.els.liveHint.textContent, "busy");
  assert.equal(t.storage.store[KEY], "cursor", "the choice is not overwritten");
  assert.deepEqual(t.changed, []);
});

test("applySource shows a bridge reading without writing the stored choice", () => {
  const t = setup();
  t.mod.applySource("claude-code");
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  assert.equal(t.storage.store[KEY], "cursor", "applySource leaves the stored choice");
  t.mod.applySource("elsewhere");
  assert.equal(t.mod.getSource(), "claude-code", "an unknown value is ignored");
});

test("a Cursor reset after a Claude Code hello turns the chip and the source back to Cursor", () => {
  const t = setup();
  // the bridge's hello and reset shapes (live-bridge.js): both carry source
  t.mod.applySource("claude-code");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  const cursorReset = { ok: true, source: "cursor", projectId: "p", projectLabel: "p" };
  t.mod.applySource(cursorReset.source);
  assert.equal(t.els.chipValue.textContent, "Cursor");
  assert.equal(t.mod.getSource(), "cursor");
  assert.equal(t.storage.store[KEY], "cursor", "a bridge reading never writes the stored choice");
});

test("onSourceShown hears every reading: startup, a bridge reading, a finished switch", async () => {
  const shown = [];
  const t = setup({
    seed: { [KEY]: "claude-code" },
    deps: { onSourceShown: (s) => shown.push(s) }
  });
  assert.deepEqual(shown, ["claude-code"], "startup shows the stored choice");
  t.mod.applySource("cursor");
  assert.deepEqual(shown, ["claude-code", "cursor"], "a bridge reading is announced");
  await t.mod.setSource("claude-code");
  assert.equal(shown[shown.length - 1], "claude-code", "a finished switch is announced");
});

test("clicking a source button starts a switch", async () => {
  const t = setup();
  t.els.claudeButton.click();
  await flush();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].body, { source: "claude-code" });
  t.els.cursorButton.click();
  await flush();
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1].body, { source: "cursor" });
});

test("a switch that lands after leaving Live does not run onChanged", async () => {
  const t = setup({ hold: true });
  const first = t.mod.setSource("claude-code");
  t.mod.setVisible(false);
  t.holds[0]();
  const r = await first;
  assert.equal(r.ok, true, "the switch itself still succeeds");
  assert.deepEqual(t.changed, [], "no stream restart while in Demo");
  assert.equal(t.mod.getSource(), "claude-code", "the bridge reading is still shown");
  assert.equal(t.storage.store[KEY], "claude-code", "the choice is still stored");
});

test("a switch that lands after Live is re-entered still runs onChanged", async () => {
  const t = setup({ hold: true });
  const first = t.mod.setSource("claude-code");
  t.mod.setVisible(false);
  t.mod.setVisible(true);
  t.holds[0]();
  await first;
  assert.deepEqual(t.changed, ["claude-code"]);
});

test("projectLabelsFrom takes Claude Code's null label and never keeps a Claude label for Cursor", () => {
  const t = setup();
  const cc = t.mod.projectLabelsFrom(
    { ok: true, source: "claude-code", projectId: null, projectLabel: null },
    "Cursor Proj",
    "c1"
  );
  assert.deepEqual(plain(cc), { label: null, id: null }, "Claude Code null replaces the label");

  const picked = t.mod.projectLabelsFrom(
    { ok: true, source: "claude-code", projectId: "p1", projectLabel: "CC Proj" },
    null,
    null
  );
  assert.deepEqual(plain(picked), { label: "CC Proj", id: "p1" });

  const back = t.mod.projectLabelsFrom(
    { ok: true, source: "cursor", projectId: null, projectLabel: null },
    "CC Proj",
    "p1"
  );
  assert.deepEqual(plain(back), { label: null, id: null }, "a Claude label is not kept for Cursor");

  const cursor = t.mod.projectLabelsFrom(
    { ok: true, source: "cursor", projectId: "c2", projectLabel: "Cur Proj" },
    null,
    null
  );
  assert.deepEqual(plain(cursor), { label: "Cur Proj", id: "c2" });

  const kept = t.mod.projectLabelsFrom(
    { ok: true, source: "cursor", projectId: null, projectLabel: null },
    "Cur Proj",
    "c2"
  );
  assert.deepEqual(
    plain(kept),
    { label: "Cur Proj", id: "c2" },
    "Cursor keeps its label when none is sent"
  );

  const noSource = t.mod.projectLabelsFrom({ ok: true, projectLabel: null }, "Cur Proj", "c2");
  assert.deepEqual(
    plain(noSource),
    { label: "Cur Proj", id: "c2" },
    "an older bridge keeps the label"
  );

  assert.deepEqual(plain(t.mod.projectLabelsFrom(null, "Cur Proj", "c2")), {
    label: "Cur Proj",
    id: "c2"
  });
});

test("the footer says claude code after a Claude Code hello with no selection replaces a Cursor label", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  vm.runInContext(fs.readFileSync(PROJECTS_SOURCE, "utf8"), sandbox, { filename: PROJECTS_SOURCE });
  const footer = makeEl();
  const state = { mode: "live", source: "cursor", label: null, id: null };
  sandbox.window.WorkshopProjects.init({
    footerProject: footer,
    getMode: () => state.mode,
    getProjectLabel: () => state.label,
    getSource: () => state.source
  });
  const ws = sandbox.window.WorkshopSource;
  const proj = sandbox.window.WorkshopProjects;

  let next = ws.projectLabelsFrom(
    { ok: true, source: "cursor", projectId: "c1", projectLabel: "Cursor Proj" },
    state.label,
    state.id
  );
  state.label = next.label;
  state.id = next.id;
  proj.updateFooterProject();
  assert.equal(footer.textContent, "Cursor Proj");

  state.source = "claude-code";
  next = ws.projectLabelsFrom(
    { ok: true, source: "claude-code", projectId: null, projectLabel: null, models: {} },
    state.label,
    state.id
  );
  state.label = next.label;
  state.id = next.id;
  proj.updateFooterProject();
  assert.equal(footer.textContent, "claude code");
});

/* An explicit Cursor folder (hello explicitDir: true) wins for the run. */
function countingStorage(seed) {
  const s = memoryStorage(seed);
  s.writes = [];
  const set = s.setItem;
  s.setItem = (k, v) => {
    s.writes.push([k, v]);
    set(k, v);
  };
  return s;
}

test("explicit Cursor folder, no stored choice: no POST, Cursor shown, nothing stored", async () => {
  const storage = countingStorage({});
  const t = setup({ storage });
  await t.mod.reconcile("cursor", true);
  await flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "cursor");
  assert.equal(t.els.chipValue.textContent, "Cursor");
  assert.equal(t.els.cursorButton.getAttribute("aria-pressed"), "true");
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.store[KEY], undefined);
  assert.deepEqual(t.changed, []);
});

test("explicit Cursor folder, stored claude-code: no POST, Cursor shown, storage kept", async () => {
  const storage = countingStorage({ [KEY]: "claude-code" });
  const t = setup({ storage });
  await t.mod.reconcile("cursor", true);
  await flush();
  assert.equal(t.calls.length, 0);
  assert.equal(t.mod.getSource(), "cursor");
  assert.equal(t.els.chipValue.textContent, "Cursor");
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.store[KEY], "claude-code");
});

test("explicit folder: a click on Claude Code switches once and stores; a reconnect keeps it", async () => {
  const storage = countingStorage({ [KEY]: "claude-code" });
  const t = setup({ storage });
  await t.mod.reconcile("cursor", true);
  t.els.claudeButton.click();
  await flush();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(plain(t.calls[0].body), { source: "claude-code" });
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(t.els.chipValue.textContent, "Claude Code");
  assert.deepEqual(storage.writes, [[KEY, "claude-code"]]);
  assert.deepEqual(t.changed, ["claude-code"]);
  // SSE reconnect: the bridge still says explicitDir but now reads Claude Code.
  await t.mod.reconcile("claude-code", true);
  await flush();
  assert.equal(t.calls.length, 1, "no POST back to Cursor");
  assert.equal(t.mod.getSource(), "claude-code");
  assert.equal(storage.store[KEY], "claude-code");
});

test("explicit folder: a click back on Cursor stores cursor, and a reload keeps it", async () => {
  const storage = countingStorage({});
  const t = setup({ storage });
  await t.mod.reconcile("cursor", true);
  t.els.claudeButton.click();
  await flush();
  t.els.cursorButton.click();
  await flush();
  assert.equal(t.calls.length, 2);
  assert.equal(storage.store[KEY], "cursor");
  assert.equal(t.mod.getSource(), "cursor");
  // reload: a new page with the stored cursor choice meets the same hello
  const t2 = setup({ storage: memoryStorage({ [KEY]: "cursor" }) });
  await t2.mod.reconcile("cursor", true);
  assert.equal(t2.calls.length, 0);
  assert.equal(t2.mod.getSource(), "cursor");
});

test("explicit folder but the bridge reads Claude Code (another client): normal reconcile", async () => {
  const t = setup({ seed: { [KEY]: "cursor" } });
  await t.mod.reconcile("claude-code", true);
  await flush();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(plain(t.calls[0].body), { source: "cursor" });
});

test("an old bridge with no explicitDir keeps the old rule: the stored choice is POSTed", async () => {
  const t = setup({ seed: {} });
  await t.mod.reconcile("cursor");
  await flush();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(plain(t.calls[0].body), { source: "claude-code" });
  const t2 = setup({ seed: {} });
  await t2.mod.reconcile("cursor", false);
  await flush();
  assert.equal(t2.calls.length, 1);
});
