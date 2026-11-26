/**
 * Browser smoke for Insights on a live Claude Code session: a real bridge with a planted Claude
 * Code home and a real Chromium. The Insights session picker shows the live session (not "No
 * sessions") with its real event count, which grows by exactly one per appended row; the
 * Forecast spend is the Bill's figure (same cost function, same formatting); the spend pace
 * text says "No spend pace yet" only while nothing is spent; a History replay of an older
 * session is not mixed into the live session's numbers; and today's Runs counts subagent
 * spawns that arrive after the live edge (and not the catch-up, and not a finish).
 * Browser profile, planted home and event log live under .scratch/test-tmp (never system temp).
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

const SCRATCH = mkTmp("insights-live-smoke-");
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

/** One assistant row with real usage: opus bills 5000 in / 2000 out at $0.06. */
const spend = (tag, ms) =>
  at(
    L.assistant([L.toolUse(`toolu_${tag}`, "Read", { file_path: `${CWD}/${tag}.js` })], {
      id: `msg_${tag}`,
      usage: { input_tokens: 5000, output_tokens: 2000 }
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

/** A subagent file and its meta: one child spawn row. */
function plantChild(dir, agentId, startMs) {
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    type: "user",
    isSidechain: true,
    agentId,
    parentUuid: null,
    sessionId: L.SESSION,
    timestamp: new Date(startMs).toISOString(),
    message: { role: "user", content: "child " + agentId }
  };
  fs.writeFileSync(path.join(dir, "agent-" + agentId + ".jsonl"), JSON.stringify(line) + "\n");
  fs.writeFileSync(
    path.join(dir, "agent-" + agentId + ".meta.json"),
    JSON.stringify({ agentType: "worker", toolUseId: "toolu_d1" })
  );
}

/** What Insights and the Bill show right now. */
const read = (page) =>
  page.evaluate(() => {
    /* What the Suggestions and What-if panels hold (read from the DOM, shown or not). */
    const panels = () => {
      const sg = document.querySelector('#drawerInsights [data-panel="suggestions"]');
      const wi = document.querySelector('#drawerInsights [data-panel="whatif"]');
      const note = (p) => {
        const n = p && p.querySelector("[data-live-unavailable]");
        return n ? n.textContent.trim() : null;
      };
      return {
        sgNote: note(sg),
        sgRows: sg
          ? sg.querySelectorAll(".insights-suggest-row, [data-suggestions-copy]").length
          : -1,
        sgOther: sg
          ? sg.querySelectorAll(".insights-suggest-hero, [data-suggestions-empty]").length
          : -1,
        wiNote: note(wi),
        wiRows: wi ? wi.querySelectorAll("[data-whatif-list], .insights-whatif-row").length : -1
      };
    };
    const t = (sel) => {
      const e = document.querySelector(sel);
      return e ? e.textContent.trim() : null;
    };
    const sel = document.querySelector("#drawerInsights .insights-session");
    return {
      status: t("#drawerInsights [data-status]"),
      selValue: sel ? sel.value : null,
      selText: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null,
      forecast: t("#drawerInsights [data-forecast-spend]"),
      hit: t("#drawerInsights [data-forecast-hit]"),
      bill: t("#billSessionTotal"),
      hud: t("#hudSessionCost"),
      runs: window.__cursorAgentsDashTest.getDailyStats().runs,
      subs: t("#hudSubs"),
      ...panels()
    };
  });

/** A live session has no Suggestions and no What-if: a note stands where they were. */
const NOTE = "Not available for live sessions yet.";
const perAgentProblems = (s, where) => {
  const out = [];
  if (s.sgNote !== NOTE) out.push(`(${where}) suggestions note: ${JSON.stringify(s.sgNote)}`);
  if (s.wiNote !== NOTE) out.push(`(${where}) what-if note: ${JSON.stringify(s.wiNote)}`);
  if (s.sgRows !== 0 || s.sgOther !== 0)
    out.push(`(${where}) suggestions still rendered: ${JSON.stringify(s)}`);
  if (s.wiRows !== 0) out.push(`(${where}) what-if still rendered: ${JSON.stringify(s)}`);
  return out;
};

const eventsOf = (s) => {
  const m = /^Live · (\d+) events/.exec(s.status || "");
  return m ? Number(m[1]) : -1;
};

async function waitFor(page, pred, arg, what) {
  try {
    await page.waitForFunction(pred, arg, { timeout: 20000 });
  } catch (_e) {
    throw new Error("timed out waiting for " + what + ": " + JSON.stringify(await read(page)));
  }
}

const waitCount = (page, n, what) =>
  waitFor(
    page,
    (want) => {
      const e = document.querySelector("#drawerInsights [data-status]");
      const m = e && /^Live · (\d+) events/.exec(e.textContent);
      return !!m && Number(m[1]) === want;
    },
    n,
    what
  );

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

async function main() {
  const errors = [];
  const fail = (m) => errors.push(m);
  const proj = path.join(HOME, ".claude", "projects", "enc-demo");
  const nowMs = Date.now();
  const minute = (ms) => Math.floor(ms / 60000) * 60000;

  // an older session (one billable row) for the History replay
  const oldStart = minute(nowMs - 3 * DAY);
  writeSession(path.join(proj, "old.jsonl"), oldStart, [
    at(L.userTurn("task text"), oldStart + 1000),
    spend("o1", oldStart + 2000),
    spend("o2", oldStart + 3000),
    spend("o3", oldStart + 4000)
  ]);
  fs.utimesSync(path.join(proj, "old.jsonl"), (oldStart + 4000) / 1000, (oldStart + 4000) / 1000);

  // the live session starts with one row and no spend
  const liveFile = path.join(proj, "live.jsonl");
  // two days back: the pace span runs from the first row to the last time, so it is about 2 days
  const liveStart = minute(nowMs - 2 * DAY);
  writeSession(liveFile, liveStart, [at(L.userTurn("task text"), liveStart + 1000)]);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  delete process.env.CURSOR_TRANSCRIPTS;
  const start = async () => {
    const p = await getFreePort();
    await startBridge({
      port: p,
      quiet: true,
      projectsRoot: path.join(SCRATCH, "no-cursor-projects"),
      eventLogDir: LOG_DIR,
      reuseExisting: false,
      claudeCode: { platform: "linux", homedir: HOME }
    });
    return p;
  };
  const port = await start();
  const tmp = path.join(SCRATCH, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    env: { ...process.env, TEMP: tmp, TMP: tmp }
  });
  const closeErrors = [];
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("pageerror", (e) => errors.push("page error: " + e.message));
    const url = `http://127.0.0.1:${port}/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page);
    await page.click("#viewInsights");

    // ---- (i) the live session is listed, with its real event count ----
    await waitCount(page, 1, "the catch-up row in Insights");
    const s0 = await read(page);
    if (s0.selValue === "" || /No sessions/.test(s0.selText || ""))
      fail("(i) the Insights picker says no session: " + JSON.stringify(s0));
    if (s0.selText !== "Live session") fail("(i) picker text: " + JSON.stringify(s0.selText));
    if (eventsOf(s0) !== 1) fail("(i) event count after catch-up: " + s0.status);

    perAgentProblems(s0, "i, no spend").forEach(fail);

    // ---- (ii) no spend yet: the old wording; the Forecast and the Bill agree on $0.00 ----
    if (!/No spend pace yet/.test(s0.hit || "")) fail("(ii) pace text with no spend: " + s0.hit);
    if (s0.forecast !== "$0.00" || s0.bill !== "$0.00" || s0.hud !== "$0.00")
      fail("(ii) zero spend figures: " + JSON.stringify(s0));

    // ---- a row after the live edge: count +1, spend appears, Forecast == Bill ----
    fs.appendFileSync(liveFile, spend("l1", Date.now()) + "\n");
    await waitCount(page, 2, "one appended row");
    await waitFor(
      page,
      () => document.querySelector("#drawerInsights [data-forecast-spend]").textContent !== "$0.00",
      null,
      "the Forecast spend"
    );
    const s1 = await read(page);
    if (s1.forecast !== "$0.06") fail("(ii) forecast after one 5000/2000 opus row: " + s1.forecast);
    if (s1.forecast !== s1.bill || s1.bill !== s1.hud)
      fail("(ii) forecast and Bill differ: " + JSON.stringify(s1));
    if (/No spend pace yet/.test(s1.hit || "")) fail("(ii) still no pace with spend: " + s1.hit);
    // $0.06 over about 2 days is $0.03/day; with the last-time marker gone the span is 0 and it reads $0.06/day
    if (!/avg \$0\.03\/day/.test(s1.hit || "")) fail("(ii) pace text: " + s1.hit);

    perAgentProblems(s1, "ii, one row with spend").forEach(fail);

    fs.appendFileSync(liveFile, spend("l2", Date.now()) + "\n");
    await waitCount(page, 3, "a second appended row");
    await waitFor(
      page,
      () => document.querySelector("#drawerInsights [data-forecast-spend]").textContent === "$0.12",
      null,
      "the Forecast to reach $0.12"
    );
    const s2 = await read(page);
    if (s2.forecast !== s2.bill) fail("(ii) forecast and Bill differ: " + JSON.stringify(s2));
    if (s2.bill !== "$0.12") fail("(ii) Bill after two rows: " + s2.bill);

    // a delegation row carries usage too (type spawn, not turn): it bills the same way
    fs.appendFileSync(
      liveFile,
      at(
        L.assistant([L.agentCall("toolu_d1", "worker", "sonnet")], {
          id: "msg_d1",
          usage: { input_tokens: 5000, output_tokens: 2000 }
        }),
        Date.now()
      ) + "\n"
    );
    await waitCount(page, 4, "the delegation row");
    await waitFor(
      page,
      () => document.querySelector("#drawerInsights [data-forecast-spend]").textContent === "$0.18",
      null,
      "the Forecast to include the delegation row"
    );
    const s2b = await read(page);
    if (s2b.forecast !== s2b.bill) fail("(ii) forecast and Bill differ: " + JSON.stringify(s2b));
    perAgentProblems(s2b, "ii, with a delegation row").forEach(fail);

    // ---- (iii) Runs: a subagent spawn after the live edge is exactly one run ----
    const runs0 = s2b.runs;
    plantChild(path.join(proj, "live", "subagents"), "agentd1", Date.now());
    await waitFor(page, () => document.getElementById("hudSubs").textContent === "1", null, "subs");
    const s3 = await read(page);
    if (s3.runs !== runs0 + 1) fail(`(iii) Runs after one live spawn: ${runs0} -> ${s3.runs}`);
    await waitCount(page, 5, "the spawn row in Insights");

    // a finish does not count as a run
    fs.appendFileSync(
      liveFile,
      at(L.notification("toolu_d1", "agentd1", "completed"), Date.now()) + "\n"
    );
    await waitCount(page, 6, "the finish row in Insights");
    const s4 = await read(page);
    if (s4.runs !== s3.runs) fail(`(iii) a finish moved Runs: ${s3.runs} -> ${s4.runs}`);

    // ---- History replay of the older session is not mixed into the live numbers ----
    await page.click("#viewHistory");
    await page.waitForFunction(
      () => document.getElementById("claudeHistorySession").options.length >= 3,
      null,
      { timeout: 15000 }
    );
    const optVals = await page.evaluate(() =>
      [...document.getElementById("claudeHistorySession").options].map((o) => o.value)
    );
    const oldId = optVals[2];
    await page.selectOption("#claudeHistorySession", oldId);
    await page.waitForFunction(
      () => /\d+ events?$/.test(document.getElementById("claudeHistoryStatus").textContent),
      null,
      { timeout: 15000 }
    );
    const frames = () =>
      page.evaluate(() => {
        const m = document.querySelector("#historyReplayHost [data-scrubber-meta]");
        const r = m ? Number(m.textContent.trim().split("/ ").pop()) : NaN;
        return Number.isFinite(r) ? r : -1;
      });
    await page
      .waitForFunction(
        () =>
          document
            .querySelector("#historyReplayHost [data-scrubber-meta]")
            .textContent.endsWith("/ 4"),
        null,
        { timeout: 15000 }
      )
      .catch(() => {});
    const during = await frames();
    if (during !== 4) fail("(replay) the replay holds " + during + " events, want the old 4");
    const s5 = await read(page);
    if (s5.forecast !== s4.forecast || eventsOf(s5) !== 6 || s5.selValue !== s4.selValue)
      fail("(replay) the live numbers moved under a replay: " + JSON.stringify({ s4, s5 }));
    await page.selectOption("#claudeHistorySession", "");
    await page
      .waitForFunction(
        () =>
          document
            .querySelector("#historyReplayHost [data-scrubber-meta]")
            .textContent.endsWith("/ 0"),
        null,
        { timeout: 15000 }
      )
      .catch(() => {});
    const after = await frames();
    if (after !== 0) fail("(replay) the live session leaked into the replay: " + after);
    await page.click("#viewStage");

    // ---- a second page: the whole session arrives as backfill, same count, same $ ----
    const page2 = await ctx.newPage();
    page2.on("pageerror", (e) => errors.push("page error: " + e.message));
    await page2.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await settle(page2);
    await page2.click("#viewInsights");
    await waitCount(page2, 6, "the backfilled rows in Insights");
    await waitFor(
      page2,
      () => document.getElementById("billSessionTotal").textContent === "$0.18",
      null,
      "the backfilled Bill"
    );
    const b0 = await read(page2);
    if (b0.forecast !== b0.bill) fail("(backfill) forecast and Bill differ: " + JSON.stringify(b0));
    if (b0.forecast !== "$0.18") fail("(backfill) forecast: " + b0.forecast);
    if (b0.selText !== "Live session") fail("(backfill) picker: " + b0.selText);
    // a row after the live edge that the connect backlog hands over counts like its tokens do
    if (b0.runs !== 1) fail("(backfill) Runs from the connect backlog: " + b0.runs);
    await page2.close();

    // ---- a fresh bridge on the same home: everything is catch-up (replay-marked) ----
    await stopBridge();
    const port3 = await start();
    const page3 = await ctx.newPage();
    page3.on("pageerror", (e) => errors.push("page error: " + e.message));
    await page3.goto(`http://127.0.0.1:${port3}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await settle(page3);
    await page3.click("#viewInsights");
    await waitCount(page3, 6, "the catch-up rows in Insights");
    await waitFor(
      page3,
      () => document.getElementById("billSessionTotal").textContent === "$0.18",
      null,
      "the catch-up Bill"
    );
    const c0 = await read(page3);
    if (c0.forecast !== c0.bill) fail("(catch-up) forecast and Bill differ: " + JSON.stringify(c0));
    if (c0.subs !== "1") fail("(catch-up) the subagent is not in subs: " + c0.subs);
    if (c0.runs !== 0) fail("(catch-up) today's Runs from the catch-up: " + c0.runs);

    // ---- a newer session: the bridge resets the stage, Insights forgets the old rows ----
    const file2 = path.join(proj, "live2.jsonl");
    const start2 = minute(Date.now());
    writeSession(file2, start2, [
      at(L.userTurn("task text"), start2 + 1000),
      spend("n1", start2 + 2000)
    ]);
    await waitCount(page3, 2, "only the new session's rows after the reset");
    await waitFor(
      page3,
      () => document.querySelector("#drawerInsights [data-forecast-spend]").textContent === "$0.06",
      null,
      "the Forecast to restart at the new session"
    );
    const n0 = await read(page3);
    if (n0.forecast !== n0.bill) fail("(reset) forecast and Bill differ: " + JSON.stringify(n0));
    await page3.close();
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
    console.error("insights-live-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("insights-live-smoke OK");
}

main().catch((e) => {
  rmTmpAll([SCRATCH]); // setup failed before the run's own cleanup
  console.error(e);
  process.exit(1);
});
