/**
 * Browser smoke for the silent backfill: a real bridge with a planted Claude Code home and a
 * real Chromium with sound switched on through the stored setting. Everything the page is
 * handed as backfill (the first catch-up of a fresh bridge, the SSE connect backlog of a bridge
 * that is already live) must set the stage state and raise NO sound cue, route token, crate,
 * toast or ship celebration. The first row after the live edge animates and sounds. A History
 * replay animates one event at a time and never as a burst when it starts or is scrubbed.
 * The spies are injected before the page script runs (addInitScript): the audio entry point
 * (WorkshopSound.play and AudioContext.createOscillator) and a MutationObserver on the DOM.
 * A bridge restarted while the tab stays open restarts its row ids; a genuinely new row that
 * reuses an id the page already saw still animates.
 * Browser profile, planted home and event log live under .scratch/test-tmp (never system temp).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const http = require("http");
const bridge1 = require("../live-bridge.js");
const { getFreePort } = require("./bridge-smoke-harness.js");
const L = require("./helpers/claude-lines");
const { mkTmp, rmTmpAll } = require("./helpers/tmp");

const SCRATCH = mkTmp("silent-backfill-");
const SALT_DIR = path.join(SCRATCH, "salt");
const HOME = path.join(SCRATCH, "home");
const PROFILE = path.join(SCRATCH, "profile");
const LOG_DIR = path.join(SCRATCH, "app-data");
const DAY = 24 * 60 * 60 * 1000;
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

function writeSession(file, startMs, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = JSON.stringify({
    type: "user",
    cwd: CWD,
    sessionId: L.SESSION,
    timestamp: new Date(startMs).toISOString()
  });
  fs.writeFileSync(file, [head, ...lines].join("\n") + "\n");
}

/** Spies installed before any page script: stored sound setting, cue log, audio and DOM log. */
function installSpies() {
  try {
    localStorage.setItem("workshopSound", "on");
    localStorage.setItem("workshopVolume", "0.5");
  } catch (_e) {
    /* storage unavailable */
  }
  const rec = { cues: [], osc: 0, spawns: [], toasts: [] };
  window.__rec = rec;
  let sound;
  Object.defineProperty(window, "WorkshopSound", {
    configurable: true,
    get: () => sound,
    set: (v) => {
      sound = v;
      const real = v.play;
      v.play = function (name) {
        rec.cues.push({ name: String(name), t: performance.now(), audible: !v.isMuted() });
        return real.apply(this, arguments);
      };
    }
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && AC.prototype.createOscillator) {
    const realOsc = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      rec.osc += 1;
      return realOsc.apply(this, arguments);
    };
  }
  const kinds = [
    ["route-token", ".route-token"],
    ["crate", ".crate"],
    ["alert-item", ".alert-item"],
    ["ship", ".celebrating, .ship-celebration"]
  ];
  const note = (n) => {
    if (!n || n.nodeType !== 1) return;
    for (const [kind, sel] of kinds) {
      if (n.matches(sel) || n.querySelector(sel)) rec.spawns.push({ kind, t: performance.now() });
    }
  };
  const start = () => {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") m.addedNodes.forEach(note);
        else if (m.type === "attributes") {
          const el = m.target;
          if (el.id === "stageToast" && el.classList.contains("show"))
            rec.toasts.push({ text: el.textContent, t: performance.now() });
          else if (m.attributeName === "class" && el.matches(".celebrating"))
            rec.spawns.push({ kind: "ship", t: performance.now() });
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
}

const snap = (page) =>
  page.evaluate(() => ({
    cues: window.__rec.cues.map((c) => c.name),
    cueTimes: window.__rec.cues.map((c) => c.t),
    osc: window.__rec.osc,
    spawns: window.__rec.spawns.map((s) => s.kind),
    toasts: window.__rec.toasts.length
  }));

const logLines = (page) =>
  page.evaluate(() => document.querySelectorAll("#sessionLog .log-line").length);

async function settle(page) {
  await page.waitForFunction(
    () => document.querySelectorAll("#sessionLog .log-line").length > 1,
    null,
    { timeout: 20000 }
  );
  await page.waitForFunction(() => !window.__cursorAgentsDashTest.isLiveBacklogReplay(), null, {
    timeout: 20000
  });
  await page.waitForTimeout(800);
}

async function main() {
  const errors = [];
  const fail = (m) => errors.push(m);
  const proj = path.join(HOME, ".claude", "projects", "enc-demo");
  const nowMs = Date.now();
  const minute = (ms) => Math.floor(ms / 60000) * 60000;

  // the older session replayed in part (c): reads, a delegation and its result, an edit
  const oldStart = minute(nowMs - 3 * DAY);
  writeSession(path.join(proj, "old.jsonl"), oldStart, [
    at(L.userTurn("task text"), oldStart + 1000),
    read("o1", "a.js", oldStart + 2000),
    at(L.assistant([L.agentCall("toolu_od", "worker", "sonnet")]), oldStart + 3000),
    at(L.agentResult("toolu_od", "oagent"), oldStart + 4000),
    at(
      L.assistant([L.toolUse("toolu_o2", "Edit", { file_path: `${CWD}/b.js` })], {
        id: "msg_o2",
        usage: { input_tokens: 90, output_tokens: 40 }
      }),
      oldStart + 5000
    ),
    read("o3", "c.js", oldStart + 6000),
    at(L.notification("toolu_od", "oagent", "completed"), oldStart + 7000)
  ]);
  fs.utimesSync(path.join(proj, "old.jsonl"), (oldStart + 7000) / 1000, (oldStart + 7000) / 1000);

  // the live session: three rows already on disk before any page opens
  const liveFile = path.join(proj, "live.jsonl");
  const liveStart = minute(nowMs - 3600 * 1000);
  const liveLines = [
    at(L.userTurn("task text"), liveStart + 1000),
    read("l1", "x.js", liveStart + 2000),
    read("l2", "y.js", liveStart + 3000),
    at(L.assistant([L.agentCall("toolu_ld", "worker", "sonnet")]), liveStart + 4000),
    at(L.agentResult("toolu_ld", "lagent"), liveStart + 5000)
  ];
  writeSession(liveFile, liveStart, liveLines);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  delete process.env.CURSOR_TRANSCRIPTS;
  const port = await getFreePort();
  const bridgeOpts = {
    port,
    quiet: true,
    projectsRoot: path.join(SCRATCH, "no-cursor-projects"),
    eventLogDir: LOG_DIR,
    saltDir: SALT_DIR,
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: HOME }
  };
  let live = bridge1;
  await live.startBridge(bridgeOpts);
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

    // ---- (a) cold start, nothing picked by the user: the first catch-up is silent ----
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page);
    const a0 = await snap(page);
    const linesA = await logLines(page);
    if (linesA < 4) fail(`(a) state not applied: ${linesA} log lines`);
    if (a0.cues.length) fail("(a) cues at cold start: " + JSON.stringify(a0.cues));
    if (a0.osc) fail("(a) oscillators at cold start: " + a0.osc);
    if (a0.spawns.length) fail("(a) animation nodes at cold start: " + JSON.stringify(a0.spawns));
    if (a0.toasts) fail("(a) toast at cold start: " + a0.toasts);
    const tokensA = await page.evaluate(() => window.__cursorAgentsDashTest.demoUsageTokenTotal());
    if (!(tokensA > 0)) fail("(a) the Bill did not get the backfill: " + tokensA);

    // ---- (a) then one new live row after the live edge: it sounds and animates ----
    fs.appendFileSync(liveFile, read("l3", "z.js", Date.now()) + "\n");
    await page.waitForFunction(
      (n) => document.querySelectorAll("#sessionLog .log-line").length > n,
      linesA,
      { timeout: 20000 }
    );
    await page.waitForTimeout(1500);
    const a1 = await snap(page);
    const tickCount = a1.cues.filter((c) => c === "tick").length;
    if (tickCount !== 1)
      fail("(a) live row: want exactly 1 tick cue, got " + JSON.stringify(a1.cues));
    if (a1.cues.filter((c) => c === "spark").length !== 1)
      fail("(a) live row: want exactly 1 spark cue, got " + JSON.stringify(a1.cues));
    if (!a1.spawns.includes("crate")) fail("(a) live row: no crate: " + JSON.stringify(a1.spawns));
    if (!a1.osc) fail("(a) live row: no oscillator");

    // ---- (b) a second page while the session is live: the connect backlog is silent ----
    const page2 = await ctx.newPage();
    page2.on("pageerror", (e) => errors.push("page error: " + e.message));
    await page2.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page2);
    const b0 = await snap(page2);
    const linesB = await logLines(page2);
    if (linesB < 5) fail(`(b) state not applied: ${linesB} log lines`);
    if (b0.cues.length) fail("(b) cues from the connect backlog: " + JSON.stringify(b0.cues));
    if (b0.osc) fail("(b) oscillators from the connect backlog: " + b0.osc);
    if (b0.spawns.length)
      fail("(b) animation nodes from the backlog: " + JSON.stringify(b0.spawns));
    if (b0.toasts) fail("(b) toast from the backlog: " + b0.toasts);
    const activeB = await page2.evaluate(
      () => document.querySelectorAll("#cratesLayer .crate, .route-token").length
    );
    if (activeB) fail("(b) crates or route tokens on the stage: " + activeB);
    const tokensB = await page2.evaluate(() => window.__cursorAgentsDashTest.demoUsageTokenTotal());
    if (!(tokensB > 0)) fail("(b) the Bill did not get the backlog: " + tokensB);
    await page2.close();

    // ---- (c) replay Play: one event at a time ----
    await page.click("#viewHistory");
    await page.waitForFunction(
      () => document.getElementById("claudeHistorySession").options.length >= 3,
      null,
      { timeout: 15000 }
    );
    const optVals = await page.evaluate(() =>
      [...document.getElementById("claudeHistorySession").options].map((o) => o.value)
    );
    /* Newest first: the live session, then the older one planted above. */
    const oldId = optVals[2] || null;
    if (!oldId) fail("(c) the older session is not listed");
    else {
      const events = await page.evaluate(
        async (id) =>
          (await (await fetch("/api/claude/session?id=" + encodeURIComponent(id))).json()).events,
        oldId
      );
      if (events.length < 6) fail("(c) want a session of 6 or more events, got " + events.length);
      // deterministic: scrub to the start, then step one event at a time
      await page.evaluate(() => {
        window.__rec.cues.length = 0;
        window.__rec.spawns.length = 0;
      });
      await page.evaluate(
        (evs) => window.__cursorAgentsDashTest.replaySeek(evs, 0, "play-start"),
        events
      );
      const afterStart = await snap(page);
      const startNoisy = afterStart.cues.filter((c) => c !== "scrub");
      if (startNoisy.length || afterStart.spawns.length)
        fail("(c) replay start burst: " + JSON.stringify({ c: startNoisy, s: afterStart.spawns }));
      // a scrub to the last event rebuilds everything silently
      await page.evaluate(
        (evs) => window.__cursorAgentsDashTest.replaySeek(evs, evs.length - 1, "scrub"),
        events
      );
      const afterScrub = await snap(page);
      const scrubNoisy = afterScrub.cues.filter((c) => c !== "scrub");
      if (scrubNoisy.length || afterScrub.spawns.length)
        fail("(c) scrub rebuild burst: " + JSON.stringify({ c: scrubNoisy, s: afterScrub.spawns }));
      await page.evaluate(
        (evs) => window.__cursorAgentsDashTest.replaySeek(evs, 0, "scrub"),
        events
      );
      await page.evaluate(() => {
        window.__rec.cues.length = 0;
      });
      let prev = 0;
      let stepsWithCues = 0;
      for (let i = 1; i < events.length; i++) {
        await page.evaluate(
          (args) => window.__cursorAgentsDashTest.replaySeek(args.evs, args.i, "play"),
          { evs: events, i }
        );
        await page.waitForTimeout(1300);
        const total = (await snap(page)).cues.length;
        const added = total - prev;
        // one event: at most a spark, a route cue and a crate's tick and pop
        if (added > 4) fail(`(c) step ${i} added ${added} cues`);
        if (added > 0) stepsWithCues += 1;
        prev = total;
      }
      if (stepsWithCues < 3)
        fail("(c) Play steps animate too rarely: " + stepsWithCues + " steps raised cues");

      // the real transport: Play from the start spreads its cues over time
      await page.evaluate(
        (evs) => window.__cursorAgentsDashTest.replaySeek(evs, 0, "scrub"),
        events
      );
      await page.evaluate(() => {
        window.__rec.cues.length = 0;
      });
      await page.evaluate(() => {
        const s = document.getElementById("claudeHistorySession");
        s.value = "";
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.selectOption("#claudeHistorySession", oldId);
      await page.waitForFunction(
        () => /\d+ events?$/.test(document.getElementById("claudeHistoryStatus").textContent),
        null,
        { timeout: 15000 }
      );
      await page.evaluate(() => {
        window.__rec.cues.length = 0;
      });
      const heard = () =>
        page.evaluate(
          () => window.__rec.cues.filter((c) => c.name !== "scrub" && c.name !== "click").length
        );
      await page.click("#historyReplayHost [data-replay-play]");
      const first = await heard();
      // the cues keep coming on later ticks (state wait, no fixed delay)
      await page.waitForFunction(
        (n) => window.__rec.cues.filter((c) => c.name !== "scrub" && c.name !== "click").length > n,
        first,
        { timeout: 30000 }
      );
      await page.waitForFunction(
        () =>
          /Play$/.test(document.querySelector("#historyReplayHost [data-replay-play]").textContent),
        null,
        { timeout: 30000 }
      );
      const total = await heard();
      // a burst would put everything in the first sample; spread cues leave most for later
      if (total < 4 || first > Math.floor(total / 2))
        fail(`(c) Play cues came in a burst: ${first} at the press of ${total}`);
      const fin = await page.evaluate(() => window.__rec.cues.map((c) => c.t));
      const distinct = new Set(fin.map((t) => Math.round(t / 100))).size;
      if (fin.length < 4 || distinct < 3)
        fail(`(c) transport Play: ${fin.length} cues, ${distinct} distinct 100 ms slots`);
    }

    // ---- (d) a bridge restarted under an open tab: row ids restart, a new row still animates ----
    const page4 = await ctx.newPage();
    page4.on("pageerror", (e) => errors.push("page error: " + e.message));
    await page4.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page4);
    const clients = () =>
      new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/status`, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve(JSON.parse(body).sseClients));
          })
          .on("error", reject);
      });
    // a second stream on the same page records every row id the bridge sends
    await page4.evaluate(() => {
      window.__ids = [];
      window.__es = new EventSource("/api/stream");
      window.__es.onmessage = (m) => {
        const o = JSON.parse(m.data);
        window.__ids.push({ id: o.id, backlog: !!o.sseBacklog, replay: o.replay === true });
      };
    });
    await page4.waitForFunction(() => window.__ids.length > 0, null, { timeout: 15000 });
    // one more live row so the old bridge has sent more ids than the restarted one will
    fs.appendFileSync(liveFile, read("l4", "w.js", Date.now()) + "\n");
    await page4.waitForFunction(() => window.__ids.some((r) => !r.backlog), null, {
      timeout: 20000
    });
    const oldIds = await page4.evaluate(() => window.__ids.map((r) => r.id));
    const clientsBefore = await clients();
    await live.stopBridge();
    // the session is shorter now, so the new bridge's ids stop short of the old ones
    writeSession(liveFile, liveStart, liveLines.slice(0, 2));
    delete require.cache[require.resolve("../live-bridge.js")];
    live = require("../live-bridge.js");
    await live.startBridge(bridgeOpts);
    const deadline = Date.now() + 40000;
    while ((await clients()) < clientsBefore && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 250));
    if ((await clients()) < clientsBefore) fail("(d) the page did not reconnect to the new bridge");
    await page4.waitForFunction(() => !window.__cursorAgentsDashTest.isLiveBacklogReplay(), null, {
      timeout: 20000
    });
    await page4.waitForTimeout(800);
    const linesD = await logLines(page4);
    await page4.evaluate(() => {
      window.__rec.cues.length = 0;
      window.__rec.spawns.length = 0;
      window.__idsMark = window.__ids.length;
    });
    fs.appendFileSync(liveFile, read("l5", "v.js", Date.now()) + "\n");
    await page4.waitForFunction(
      (n) => document.querySelectorAll("#sessionLog .log-line").length > n,
      linesD,
      { timeout: 20000 }
    );
    await page4.waitForTimeout(1500);
    const newIds = await page4.evaluate(() =>
      window.__ids
        .slice(window.__idsMark)
        .filter((r) => !r.backlog && !r.replay)
        .map((r) => r.id)
    );
    if (newIds.length !== 1) fail("(d) want one live row after the restart, got " + newIds.length);
    else if (!oldIds.includes(newIds[0]))
      fail(`(d) the new row's id ${newIds[0]} did not collide with the old bridge's ids`);
    const d1 = await snap(page4);
    if (d1.cues.filter((c) => c === "tick").length !== 1)
      fail("(d) new row after a restart: want exactly 1 tick cue, got " + JSON.stringify(d1.cues));
    if (d1.cues.filter((c) => c === "spark").length !== 1)
      fail("(d) new row after a restart: want exactly 1 spark cue, got " + JSON.stringify(d1.cues));
    if (!d1.spawns.includes("crate"))
      fail("(d) new row after a restart: no crate: " + JSON.stringify(d1.spawns));
  } finally {
    try {
      await ctx.close();
    } catch (e) {
      closeErrors.push(e);
    }
    try {
      await live.stopBridge();
    } catch (e) {
      closeErrors.push(e);
    }
    const rmError = rmTmpAll([SCRATCH]);
    if (rmError) closeErrors.push(rmError);
  }
  if (closeErrors.length) throw closeErrors[0];
  if (errors.length) {
    console.error("silent-backfill-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("silent-backfill-smoke OK");
}

main().catch((e) => {
  rmTmpAll([SCRATCH]); // setup failed before the run's own cleanup
  console.error(e);
  process.exit(1);
});
