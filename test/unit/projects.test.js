/**
 * Unit tests for dashboard/projects.js. Browser IIFE run in a vm sandbox with stubbed
 * elements, fetch, and session accessors, so picker rendering and the /api/select
 * round-trip are covered without a bridge.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "projects.js");

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    value: "",
    hidden: false,
    disabled: false,
    textContent: "",
    selected: false,
    children: [],
    classNames: {},
    _html: "",
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    classList: {
      contains: () => false
    }
  };
}

function load(overrides) {
  const projectPicker = makeEl("select");
  const footerProject = makeEl("span");
  const state = { id: null, label: null };

  const sandbox = {
    window: {},
    document: { createElement: makeEl },
    Date: Date,
    fetch: () => Promise.reject(new Error("fetch not stubbed"))
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  const mod = sandbox.window.WorkshopProjects;
  assert.ok(mod, "projects.js must expose window.WorkshopProjects");

  const deps = Object.assign(
    {
      projectPicker,
      footerProject,
      bridgeUrl: "http://127.0.0.1:3847",
      quietAfterMs: 45000,
      getMode: () => "live",
      getLivePresence: () => "streaming",
      setLivePresence() {
        deps.__presenceCalls.push(Array.prototype.slice.call(arguments));
      },
      isBridgeConnected: () => true,
      getLastLiveEventAt: () => 0,
      getProjectId: () => state.id,
      getProjectLabel: () => state.label,
      setProject(id, label) {
        if (id != null) state.id = id;
        if (label != null) state.label = label;
      },
      getInsightsPanel: () => null,
      remountHistoryReplayIfNeeded() {},
      setViewMode() {},
      __presenceCalls: [],
      __state: state
    },
    overrides || {}
  );
  mod.init(deps);
  return { mod, deps, projectPicker, footerProject, state, sandbox };
}

test("setProjectPickerVisible toggles the hidden flag", () => {
  const t = load();
  t.mod.setProjectPickerVisible(true);
  assert.equal(t.projectPicker.hidden, false);
  t.mod.setProjectPickerVisible(false);
  assert.equal(t.projectPicker.hidden, true);
});

test("updateFooterProject shows the label in live, else the demo command", () => {
  const t = load();
  t.state.label = "My Project";
  t.mod.updateFooterProject();
  assert.equal(t.footerProject.textContent, "My Project");
  const demo = load({ getMode: () => "demo" });
  demo.mod.updateFooterProject();
  assert.match(demo.footerProject.textContent, /cursor --model opus/);
  const liveNoLabel = load();
  liveNoLabel.mod.updateFooterProject();
  assert.match(liveNoLabel.footerProject.textContent, /cursor --model opus/);
});

test("fillProjectPicker renders one option per project and selects the active one", () => {
  const t = load();
  t.mod.fillProjectPicker({
    projects: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" }
    ],
    selectedId: "b",
    selectedLabel: "Beta"
  });
  assert.equal(t.projectPicker.children.length, 2);
  assert.equal(t.projectPicker.children[0].value, "a");
  assert.equal(t.projectPicker.children[1].value, "b");
  assert.equal(t.projectPicker.children[1].selected, true, "the active project is selected");
  assert.equal(t.projectPicker.disabled, false);
  assert.equal(t.state.id, "b", "selection is pushed back to app state");
  assert.equal(t.state.label, "Beta");
  assert.equal(t.footerProject.textContent, "Beta");
});

test("fillProjectPicker falls back to the id when a project has no label", () => {
  const t = load();
  t.mod.fillProjectPicker({ projects: [{ id: "raw-id" }], selectedId: "raw-id" });
  assert.equal(t.projectPicker.children[0].textContent, "raw-id");
});

test("an empty project list disables the picker and reports no-projects", () => {
  const t = load();
  t.mod.fillProjectPicker({ projects: [], selectedId: null });
  assert.equal(t.projectPicker.disabled, true, "picker disabled with no projects");
  assert.equal(t.projectPicker.children.length, 1);
  assert.match(t.projectPicker.children[0].textContent, /No Cursor projects/);
  assert.deepEqual(t.deps.__presenceCalls, [["no-projects"]], "presence flips to no-projects");
});

test("no-projects does not override a down or file-origin bridge", () => {
  const down = load({ getLivePresence: () => "bridge-down" });
  down.mod.fillProjectPicker({ projects: [], selectedId: null });
  assert.deepEqual(down.deps.__presenceCalls, [], "bridge-down is not replaced");
  const file = load({ getLivePresence: () => "file-origin" });
  file.mod.fillProjectPicker({ projects: [], selectedId: null });
  assert.deepEqual(file.deps.__presenceCalls, [], "file-origin is not replaced");
});

test("recovering from no-projects picks streaming or quiet-healthy", () => {
  const recent = load({
    getLivePresence: () => "no-projects",
    getLastLiveEventAt: () => Date.now()
  });
  recent.mod.fillProjectPicker({ projects: [{ id: "a" }], selectedId: "a" });
  assert.deepEqual(recent.deps.__presenceCalls, [["streaming"]], "recent traffic means streaming");

  const idle = load({ getLivePresence: () => "no-projects", getLastLiveEventAt: () => 0 });
  idle.mod.fillProjectPicker({ projects: [{ id: "a" }], selectedId: "a" });
  assert.deepEqual(
    idle.deps.__presenceCalls,
    [["quiet-healthy"]],
    "no traffic means quiet-healthy"
  );
});

test("loadProjects fetches, fills, and returns the payload", async () => {
  const t = load();
  t.sandbox.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ projects: [{ id: "x", label: "X" }], selectedId: "x" })
    });
  const data = await t.mod.loadProjects();
  assert.equal(data.projects.length, 1);
  assert.equal(t.projectPicker.children.length, 1);
  assert.equal(t.projectPicker.hidden, false, "picker made visible in live mode");
});

test("loadProjects hides the picker and resolves null on failure", async () => {
  const t = load();
  t.sandbox.fetch = () => Promise.resolve({ ok: false, status: 500 });
  const data = await t.mod.loadProjects();
  assert.equal(data, null);
  assert.equal(t.projectPicker.hidden, true, "picker hidden when the fetch fails");
});

test("selectProject POSTs to /api/select with the bridge header", async () => {
  const t = load();
  let seen = null;
  t.sandbox.fetch = (url, opts) => {
    seen = { url: url, opts: opts };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, projectId: "new", projectLabel: "New" })
    });
  };
  const data = await t.mod.selectProject("new");
  assert.equal(seen.url, "http://127.0.0.1:3847/api/select");
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers["X-Cursor-Bridge"], "1", "bridge header required by the route");
  assert.equal(JSON.parse(seen.opts.body).id, "new");
  assert.equal(data.ok, true);
  assert.equal(t.state.id, "new", "selection stored");
  assert.equal(t.footerProject.textContent, "New");
});

test("selectProject surfaces a failed switch without throwing", async () => {
  const t = load();
  t.sandbox.fetch = () =>
    Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  const data = await t.mod.selectProject("nope");
  assert.equal(data.ok, false);
  assert.match(data.error, /Select failed \(403\)/);
  assert.equal(t.state.id, null, "a failed switch must not change the selection");
});

test("selectProject ignores an empty id and a re-entrant call", async () => {
  const t = load();
  assert.equal(await t.mod.selectProject(""), null);
  assert.equal(await t.mod.selectProject(null), null);

  let resolveFetch;
  t.sandbox.fetch = () =>
    new Promise((res) => {
      resolveFetch = res;
    });
  const first = t.mod.selectProject("a");
  const second = await t.mod.selectProject("b");
  assert.equal(second, null, "a second call while one is in flight is ignored");
  resolveFetch({ ok: true, json: () => Promise.resolve({ ok: true, projectId: "a" }) });
  await first;
});
