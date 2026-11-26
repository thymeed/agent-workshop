/**
 * Browser smoke for the Live gates in dashboard/app.js and cards.js, driven through the page's
 * own applyLiveEvent with rows cloned from a real bridge row (real bridge, planted Claude Code
 * home, Chromium with sound on):
 *  - the same row id applied twice still counts twice in Insights, and the Forecast equals the Bill;
 *  - a row with only the sseBacklog mark, or one inside only the connect-backlog quiet window,
 *    applies silently; the next plain live row animates again (the quiet flag is put back), also
 *    after rows queued during a Claude Code replay are applied quietly when it ends;
 *  - the History drawer owns the stage only on Live Claude Code (not on Cursor, not in Demo; the
 *    History view itself always does), and a seek while the stage is not owned ends the replay
 *    guard;
 *  - a subagent that arrives as catch-up (`replay: true`) is in subs but not in today's Runs,
 *    exactly one is absorbed per catch-up spawn, none outside a catch-up, the count resets at
 *    zero subs, and Runs never goes below zero.
 * Spies are installed before the page script (addInitScript). Browser profile, planted home and
 * event log live under .scratch/test-tmp (never system temp).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startBridge, stopBridge } = require("../live-bridge.js");
const { getFreePort } = require("./bridge-smoke-harness.js");
const L = require("./helpers/claude-lines");
const { mkTmp, rmTmpAll } = require("./helpers/tmp");

const SCRATCH = mkTmp("live-gates-");
const HOME = path.join(SCRATCH, "home");
const PROFILE = path.join(SCRATCH, "profile");
const LOG_DIR = path.join(SCRATCH, "app-data");
const SALT_DIR = path.join(SCRATCH, "salt");
const CWD = "/srv/proj-demo";

const at = (line, ms) => {
  const o = JSON.parse(line);
  o.timestamp = new Date(ms).toISOString();
  return JSON.stringify(o);
};
const read = (tag, name, ms) =>
  at(
    L.assistant([L.toolUse(`toolu_${tag}`, "Read", { file_path: `${CWD}/${name}` })], {
      id: `msg_${tag}`,
      usage: { input_tokens: 120, output_tokens: 30 }
    }),
    ms
  );

/** Spies installed before any page script. */
function installSpies() {
  try {
    localStorage.setItem("workshopSound", "on");
    localStorage.setItem("workshopVolume", "0.5");
  } catch (_e) {
    /* storage unavailable */
  }
  const rec = { cues: [], spawns: [] };
  window.__rec = rec;
  window.__evs = [];
  let sound;
  Object.defineProperty(window, "WorkshopSound", {
    configurable: true,
    get: () => sound,
    set: (v) => {
      sound = v;
      const real = v.play;
      v.play = function (name) {
        rec.cues.push(String(name));
        return real.apply(this, arguments);
      };
    }
  });
  /* Every row the bridge streams, parsed (the template rows are cloned from these). */
  const RealES = window.EventSource;
  window.EventSource = function (url, opts) {
    const es = new RealES(url, opts);
    es.addEventListener("message", (e) => {
      try {
        window.__evs.push(JSON.parse(e.data));
      } catch (_e) {
        /* not JSON */
      }
    });
    return es;
  };
  window.EventSource.prototype = RealES.prototype;
  /* Hold the connect-backlog quiet window open while sessionStorage says so: its 80 ms
     timer is kept here instead of scheduled, and released by the test. */
  const hold = sessionStorage.getItem("__holdQuiet") === "1";
  window.__heldQuiet = [];
  const st = window.setTimeout;
  const ct = window.clearTimeout;
  let fake = 1e9;
  window.setTimeout = function (fn, ms) {
    if (hold && ms === 80 && !window.__quietReleased) {
      const id = ++fake;
      window.__heldQuiet.push({ id, fn });
      return id;
    }
    return st.apply(this, arguments);
  };
  window.clearTimeout = function (id) {
    window.__heldQuiet = window.__heldQuiet.filter((h) => h.id !== id);
    return ct.apply(this, arguments);
  };
  const kinds = [
    ["route-token", ".route-token"],
    ["crate", ".crate"]
  ];
  const note = (n) => {
    if (!n || n.nodeType !== 1) return;
    for (const [kind, sel] of kinds)
      if (n.matches(sel) || n.querySelector(sel)) rec.spawns.push(kind);
  };
  const start = () =>
    new MutationObserver((muts) => {
      for (const m of muts) if (m.type === "childList") m.addedNodes.forEach(note);
    }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
}

async function settle(page) {
  await page.waitForFunction(
    () => document.querySelectorAll("#sessionLog .log-line").length > 1,
    null,
    { timeout: 20000 }
  );
  await page.waitForFunction(() => !window.__cursorAgentsDashTest.isLiveBacklogReplay(), null, {
    timeout: 20000
  });
  await page.waitForTimeout(600);
}

/** Apply one row through the page's applyLiveEvent; report what moved and sounded. */
async function apply(page, ev) {
  /* A crate from an earlier row sounds "pop" when it lands (~900 ms later) and is removed
     180 ms after: wait for none in flight so its cue is not blamed on this row. */
  await page.waitForFunction(() => !document.querySelector(".crate"), null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__rec.cues = [];
    window.__rec.spawns = [];
  });
  await page.evaluate((e) => window.__cursorAgentsDashTest.applyLiveEvent(e), ev);
  await page.waitForTimeout(900);
  return page.evaluate(() => ({
    cues: window.__rec.cues.slice(),
    spawns: window.__rec.spawns.slice()
  }));
}
const moved = (r) => r.spawns.includes("crate") || r.cues.includes("spark");
const silent = (r) => !r.spawns.length && !r.cues.length;

let seq = 0;
/** A fresh copy of the template row: new id, marks and extra fields as given. */
const clone = (tpl, extra) =>
  Object.assign(JSON.parse(JSON.stringify(tpl)), { id: "gate-" + ++seq }, extra || {});

async function main() {
  const errors = [];
  const fail = (m) => errors.push(m);
  const proj = path.join(HOME, ".claude", "projects", "enc-demo");
  const liveFile = path.join(proj, "live.jsonl");
  const start = Date.now() - 3600 * 1000;
  fs.mkdirSync(proj, { recursive: true });
  const head = JSON.stringify({
    type: "user",
    cwd: CWD,
    sessionId: L.SESSION,
    timestamp: new Date(start).toISOString()
  });
  fs.writeFileSync(
    liveFile,
    [head, at(L.userTurn("task text"), start + 1000), read("l1", "x.js", start + 2000)].join("\n") +
      "\n"
  );
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  delete process.env.CURSOR_TRANSCRIPTS;
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: path.join(SCRATCH, "no-cursor-projects"),
    eventLogDir: LOG_DIR,
    saltDir: SALT_DIR,
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: HOME }
  });
  const tmp = path.join(SCRATCH, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    env: { ...process.env, TEMP: tmp, TMP: tmp }
  });
  const closeErrors = [];
  try {
    await ctx.addInitScript(installSpies);
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) => errors.push("page error: " + e.message));
    const url = `http://127.0.0.1:${port}/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page);

    // a real row after the live edge: it animates, and it is the template for the rest
    const lines = await page.evaluate(
      () => document.querySelectorAll("#sessionLog .log-line").length
    );
    fs.appendFileSync(liveFile, read("l2", "y.js", Date.now()) + "\n");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#sessionLog .log-line").length > n,
      lines,
      { timeout: 20000 }
    );
    const tpl = await page.evaluate(() => {
      const rows = window.__evs.filter((e) => e && e.activity && e.usage && !e.replay);
      return rows[rows.length - 1] || null;
    });
    if (!tpl) throw new Error("no live template row was streamed");
    delete tpl.sseBacklog;
    const base = await apply(page, clone(tpl));
    if (!moved(base)) fail("template: a plain live row did not animate: " + JSON.stringify(base));

    // ---- (5) the same row id twice: Insights counts both, the Forecast equals the Bill ----
    const insights = () =>
      page.evaluate(() => {
        const s = document.querySelector("#drawerInsights [data-status]").textContent;
        const m = /^Live · (\d+) events/.exec(s);
        return {
          count: m ? Number(m[1]) : -1,
          forecast: document.querySelector("#drawerInsights [data-forecast-spend]").textContent,
          bill: document.getElementById("billSessionTotal").textContent
        };
      });
    const i0 = await insights();
    const dup = clone(tpl, { usage: { ...tpl.usage, model: "opus", in: 500000, out: 0 } });
    await page.evaluate((e) => {
      window.__cursorAgentsDashTest.applyLiveEvent(e);
      window.__cursorAgentsDashTest.applyLiveEvent(e);
    }, dup);
    await page.waitForTimeout(600);
    const i1 = await insights();
    if (i1.count !== i0.count + 2)
      fail(`(5) same id twice: Insights count ${i0.count} -> ${i1.count}`);
    if (i1.forecast !== i1.bill)
      fail("(5) same id twice: Forecast and Bill differ: " + JSON.stringify(i1));
    const toCents = (t) => Math.round(Number(String(t).replace(/[^0-9.]/g, "")) * 100);
    if (toCents(i1.bill) - toCents(i0.bill) !== 400)
      fail(`(5) the Bill did not take both rows ($2.00 each): ${i0.bill} -> ${i1.bill}`);

    // ---- (6) the sseBacklog mark alone is silent; the next plain row animates again ----
    const marked = await apply(page, clone(tpl, { sseBacklog: true }));
    if (!silent(marked))
      fail("(6) sseBacklog-only row moved or sounded: " + JSON.stringify(marked));
    const after = await apply(page, clone(tpl));
    if (!moved(after))
      fail("(6) the row after a silent row did not animate: " + JSON.stringify(after));

    // ---- (8) catch-up subagents and today's Runs ----
    const runs = () => page.evaluate(() => window.__cursorAgentsDashTest.getDailyStats().runs);
    const subs = () => page.evaluate(() => Number(document.getElementById("hudSubs").textContent));
    const spawn = (n, replay) =>
      page.evaluate(
        ([k, r]) =>
          window.__cursorAgentsDashTest.applyLiveEvent({
            id: "spawn-" + k + (r ? "-r" : ""),
            iso: new Date().toISOString(),
            role: "worker",
            kind: "delegates",
            type: "spawn",
            message: "spawn",
            source: "subagent:" + k,
            replay: r || undefined
          }),
        [n, replay]
      );
    const r0 = await runs();
    const s0 = await subs();
    await spawn(101, false);
    if ((await runs()) !== r0 + 1) fail(`(8) a live spawn: Runs ${r0} -> ${await runs()}, want +1`);
    await spawn(102, true);
    if ((await subs()) !== s0 + 2)
      fail(`(8) a catch-up spawn is not in subs: ${s0} -> ${await subs()}`);
    if ((await runs()) !== r0 + 1)
      fail(`(8) a catch-up spawn moved Runs: ${r0 + 1} -> ${await runs()}`);
    await spawn(103, false);
    if ((await runs()) !== r0 + 2)
      fail(
        `(8) one catch-up spawn absorbed more or less than one: Runs ${await runs()}, want ${r0 + 2}`
      );
    const direct = await page.evaluate(() => {
      const C = window.AgentCards;
      const runsNow = () => C.getDailyStats().runs;
      const out = {};
      C.syncLiveSubs(0); // zero subs: the absorbed count resets
      const r = runsNow();
      C.absorbBackfillSub();
      C.syncLiveSubs(r + 2); // r + 2 subs, one of them catch-up
      out.oneAbsorbed = runsNow() - r;
      C.syncLiveSubs(0);
      C.syncLiveSubs(r + 2); // after the reset nothing is absorbed
      out.afterReset = runsNow() - r;
      C.reset({}); // a new day: Runs 0
      for (let i = 0; i < 5; i++) C.absorbBackfillSub();
      C.syncLiveSubs(1);
      out.manyAbsorbed = runsNow();
      return out;
    });
    if (direct.oneAbsorbed !== 1)
      fail("(8) absorbBackfillSub took " + (2 - direct.oneAbsorbed) + " subs, want 1");
    if (direct.afterReset !== 2)
      fail("(8) the absorbed count did not reset at zero subs: " + direct.afterReset);
    if (!(direct.manyAbsorbed >= 0)) fail("(8) Runs went below zero: " + direct.manyAbsorbed);

    // ---- (7) who owns the stage on Live Claude Code ----
    const evs = [clone(tpl, { replay: true }), clone(tpl, { replay: true })];
    const seek = () =>
      page.evaluate((e) => {
        const T = window.__cursorAgentsDashTest;
        T.replaySeek(e, 1, "scrub");
        return { active: T.isReplaySessionActive(), guard: T.replayGuardInfo() };
      }, evs);
    const drawer = (open) =>
      page.evaluate((o) => {
        document.getElementById("drawerHistory").open = o;
      }, open);
    const s7a = await seek();
    if (s7a.active || s7a.guard.holding)
      fail("(7) Stage, drawer closed: a seek took the stage: " + JSON.stringify(s7a));
    await drawer(true);
    await page.waitForTimeout(300);
    const s7b = await seek();
    if (!s7b.active || !s7b.guard.holding)
      fail(
        "(7) Stage, drawer open on Claude Code: the seek did not take the stage: " +
          JSON.stringify(s7b)
      );

    // rows that arrive meanwhile are queued, then applied quietly when the replay ends
    await page.evaluate(() => {
      window.__rec.cues = [];
      window.__rec.spawns = [];
    });
    await page.evaluate((e) => window.__cursorAgentsDashTest.applyLiveEvent(e), clone(tpl));
    const queued = await page.evaluate(
      () => window.__cursorAgentsDashTest.replayGuardInfo().queued
    );
    if (queued !== 1) fail("(6) a row during the replay was not queued: " + queued);
    await drawer(false); // the drawer's toggle ends the replay
    await page.waitForFunction(
      () => !window.__cursorAgentsDashTest.replayGuardInfo().holding,
      null,
      {
        timeout: 5000
      }
    );
    await page.waitForTimeout(600);
    const drained = await page.evaluate(() => ({
      cues: window.__rec.cues,
      spawns: window.__rec.spawns
    }));
    if (drained.spawns.includes("crate"))
      fail("(6) the queued row animated when the replay ended: " + JSON.stringify(drained));
    const afterQueue = await apply(page, clone(tpl));
    if (!moved(afterQueue))
      fail("(6) the row after the queued rows did not animate: " + JSON.stringify(afterQueue));

    // the drawer closes without its toggle reaching the page: the next seek ends the guard
    await drawer(true);
    await page.waitForTimeout(300);
    const s7c = await seek();
    if (!s7c.guard.holding) fail("(7) setup: the guard is not holding: " + JSON.stringify(s7c));
    await page.evaluate(() => {
      window.__blockToggle = (e) => e.stopImmediatePropagation();
      window.addEventListener("toggle", window.__blockToggle, true);
      document.getElementById("drawerHistory").open = false;
    });
    await page.waitForTimeout(300);
    const s7d = await seek();
    await page.evaluate(() => window.removeEventListener("toggle", window.__blockToggle, true));
    if (s7d.active || s7d.guard.holding)
      fail(
        "(7) a seek while the stage is not owned left the replay running: " + JSON.stringify(s7d)
      );

    // the History view always owns the stage
    await page.evaluate(() => window.__cursorAgentsDashTest.setViewMode("history"));
    await page.waitForTimeout(300);
    const s7e = await seek();
    if (!s7e.active) fail("(7) the History view did not own the stage: " + JSON.stringify(s7e));
    await page.evaluate(() => window.__cursorAgentsDashTest.setViewMode("stage"));
    await page.waitForTimeout(300);

    // ---- (6) the quiet window alone (no mark): reload with its timer held open ----
    await page.evaluate(() => sessionStorage.setItem("__holdQuiet", "1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelectorAll("#sessionLog .log-line").length > 1,
      null,
      { timeout: 20000 }
    );
    await page.waitForTimeout(600);
    const held = await page.evaluate(() => ({
      window: window.__cursorAgentsDashTest.isLiveBacklogReplay(),
      timers: window.__heldQuiet.length
    }));
    if (!held.window || !held.timers)
      fail("(6) setup: the quiet window is not held: " + JSON.stringify(held));
    const inWindow = await apply(page, clone(tpl));
    if (!silent(inWindow))
      fail("(6) a row inside the quiet window moved or sounded: " + JSON.stringify(inWindow));
    await page.evaluate(() => {
      window.__quietReleased = true;
      window.__heldQuiet.splice(0).forEach((h) => h.fn());
      sessionStorage.removeItem("__holdQuiet");
    });
    if (await page.evaluate(() => window.__cursorAgentsDashTest.isLiveBacklogReplay()))
      fail("(6) the quiet window did not close");
    const outWindow = await apply(page, clone(tpl));
    if (!moved(outWindow))
      fail("(6) the row after the quiet window did not animate: " + JSON.stringify(outWindow));

    // ---- (7) Demo and Cursor: the drawer never owns the stage ----
    const ownsWithDrawer = async (what) => {
      await drawer(true);
      await page.waitForTimeout(300);
      const s = await seek();
      if (s.active) fail(`(7) ${what}, drawer open: a seek took the stage: ` + JSON.stringify(s));
      await drawer(false);
      await page.waitForTimeout(200);
    };
    await page.click("#modeDemo");
    await page.waitForTimeout(500);
    await ownsWithDrawer("Demo");
    await page.click("#modeLive");
    await page.waitForFunction(() => !document.getElementById("sourceSeg").hidden, null, {
      timeout: 15000
    });
    await page.click("#sourceCursor");
    await page.waitForTimeout(1000);
    await ownsWithDrawer("Live on Cursor");

    // the History view owns the stage on its own: on Cursor the drawer path cannot
    await page.evaluate(() => window.__cursorAgentsDashTest.setViewMode("history"));
    await page.waitForTimeout(300);
    const s7f = await seek();
    if (!s7f.active)
      fail("(7) the History view on Cursor did not own the stage: " + JSON.stringify(s7f));
    await page.evaluate(() => window.__cursorAgentsDashTest.setViewMode("stage"));
  } finally {
    try {
      await ctx.close();
    } catch (e) {
      closeErrors.push(e);
    }
    try {
      await stopBridge();
    } catch (e) {
      closeErrors.push(e);
    }
    const rmError = rmTmpAll([SCRATCH]);
    if (rmError) closeErrors.push(rmError);
  }
  if (closeErrors.length) throw closeErrors[0];
  if (errors.length) {
    console.error("live-gates-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("live-gates-smoke OK");
}

main().catch((err) => {
  rmTmpAll([SCRATCH]); // setup failed before the run's own cleanup
  console.error(err);
  process.exit(1);
});
