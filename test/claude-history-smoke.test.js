/**
 * Browser smoke for Claude Code History: a real bridge with a planted Claude Code home (two
 * projects; the first has an older session, a newer one, and one older than 14 days). The
 * History tab is open in Claude Code mode, the picker lists only the two sessions inside the
 * window with local-time labels, a session loads through the existing replay transport, Play
 * drives the stage, and no path, prompt text or opaque id reaches the page text, the
 * browser console or the page errors. A project pick keeps the Stage view, and a switch to
 * Cursor hides the picker. The browser profile, the planted home and the event log live
 * under .scratch/ (never system temp).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startBridge, stopBridge } = require("../live-bridge.js");
const { getFreePort } = require("./bridge-smoke-harness.js");
const L = require("./helpers/claude-lines");
const { buildForbidden } = require("./helpers/privacy-patterns");

const SCRATCH = path.join(__dirname, "..", ".scratch", "claude-history-smoke");
const HOME = path.join(SCRATCH, "home");
const PROFILE = path.join(SCRATCH, "profile");
const LOG_DIR = path.join(SCRATCH, "app-data");
const FORBIDDEN = buildForbidden([]);
const SECRET_PROMPT = "PROMPT-TEXT-MUST-NOT-APPEAR";
const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The label's time part, written independently of the dashboard code. */
function when(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** The same line with its own time, so labels do not depend on the helper's fixed clock. */
function at(line, ms) {
  const o = JSON.parse(line);
  o.timestamp = new Date(ms).toISOString();
  return JSON.stringify(o);
}

/** A session file: head, prompt, a delegation and its result and notification, `minutes` long. */
function plantSession(file, startMs, minutes, subagentType, cwd) {
  const lines = [
    JSON.stringify({
      type: "user",
      cwd,
      sessionId: L.SESSION,
      timestamp: new Date(startMs).toISOString()
    }),
    at(L.userTurn(SECRET_PROMPT), startMs + 1000),
    at(L.assistant([L.agentCall("toolu_1", subagentType, "sonnet")]), startMs + 2000),
    at(L.agentResult("toolu_1", "agent1"), startMs + 3000),
    at(L.notification("toolu_1", "agent1", "completed"), startMs + minutes * 60000)
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const t = (startMs + minutes * 60000) / 1000;
  fs.utimesSync(file, t, t);
}

/** A subagent file and its meta: one child spawn row when the parent session replays. */
function plantChild(dir, agentId, startMs, type) {
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
    JSON.stringify({ agentType: type || "worker", toolUseId: "toolu_1" })
  );
}

/** Everything a replay overwrites and a restore must give back, read from the page. */
function sig(page) {
  return page.evaluate(() => {
    const h = window.__cursorAgentsDashTest;
    const d = h.getDailyStats() || {};
    const clean = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim();
    const text = (id) =>
      clean(document.getElementById(id) && document.getElementById(id).textContent);
    return {
      tokens: h.demoUsageTokenTotal(),
      lines: h.getLogLineCount(),
      cost: h.getHudSessionCost(),
      bill: text("drawerBill"),
      status: ["opus", "advisor", "worker", "explorer", "researcher"].map((r) =>
        text("status-" + r)
      ),
      active: [...document.querySelectorAll(".card.active")].map((e) => e.id),
      hudActive: text("hudActiveRole"),
      hudSubs: text("hudSubs"),
      calls: text("advisorCalls"),
      advisorLast: text("advisorLast"),
      activity: ["activityRead", "activityEdit", "activityRun"].map(text),
      log: document.getElementById("sessionLog").textContent,
      runs: d.runs,
      dayTokens: d.tokens,
      fastest: d.fastestAgent,
      privacy: [...document.querySelectorAll(".privacy-meter")].map((e) => e.className),
      avatars: [...document.querySelectorAll(".card .agent-avatar")].map((e) => e.className),
      taken: h.isReplaySessionActive(),
      guard: h.replayGuardInfo()
    };
  });
}

/** The recorded start of a lit Live role (ms), or null. */
function liveRoleStart(page, role) {
  return page.evaluate((r) => window.AgentCards.getRoleActiveStarted(r), role);
}

/** Today's counters as a replay must leave them. */
function dayOf(x) {
  return JSON.stringify({ runs: x.runs, tokens: x.dayTokens, fastest: x.fastest });
}

/** After the replay is gone, today's counters count again (a freeze left on would swallow this). */
function countingResumed(page) {
  return page.evaluate(() => {
    const AC = window.AgentCards;
    const t0 = AC.getDailyStats().tokens;
    AC.addTokens(1);
    return AC.getDailyStats().tokens === t0 + 1;
  });
}

/** Scrub the open replay to its last event, so its subagent rows really run. */
function seekLast(page, events) {
  return page.evaluate(
    (evs) => window.__cursorAgentsDashTest.replaySeek(evs, evs.length - 1, "scrub"),
    events
  );
}

const SAME_KEYS = [
  "tokens",
  "lines",
  "cost",
  "bill",
  "status",
  "active",
  "hudActive",
  "hudSubs",
  "calls",
  "advisorLast",
  "activity",
  "log",
  "runs",
  "dayTokens",
  "fastest",
  "privacy",
  "avatars"
];

/** Messages for every stage value that differs between two readings (none: equal). */
function differ(name, a, b) {
  return SAME_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(
    (k) =>
      `${name}: ${k} changed: ${JSON.stringify(a[k]).slice(0, 900)} -> ${JSON.stringify(b[k]).slice(0, 900)}`
  );
}

/** Press Play and wait until the replay holds the stage, then pause it. */
async function play(page) {
  await page.click("#historyReplayHost [data-replay-play]");
  await page.waitForFunction(
    () => {
      const g = window.__cursorAgentsDashTest.replayGuardInfo();
      return !!g && g.holding && window.__cursorAgentsDashTest.isReplaySessionActive();
    },
    null,
    { timeout: 20000 }
  );
  await page.click("#historyReplayHost [data-replay-pause]");
}

async function waitList(page, count = 3) {
  await page.waitForFunction(
    (c) => document.getElementById("claudeHistorySession").options.length >= c,
    count,
    { timeout: 15000 }
  );
}

/** SMOKE_TRACE=1 prints the numbers at each step (for a hand check). */
function trace(label, s) {
  if (process.env.SMOKE_TRACE)
    console.log(
      label.padEnd(26),
      "tokens",
      s.tokens,
      "lines",
      s.lines,
      "hud",
      s.cost,
      "dayTokens",
      s.dayTokens,
      "taken",
      s.taken,
      "queued",
      s.guard && s.guard.queued
    );
}

async function main() {
  const errors = [];
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const proj = path.join(HOME, ".claude", "projects");
  const nowMs = Date.now();
  const minute = (ms) => Math.floor(ms / 60000) * 60000;
  const startNew = minute(nowMs - 2 * 3600 * 1000);
  const startOld = minute(nowMs - 3 * DAY);
  const startStale = minute(nowMs - 20 * DAY);
  plantSession(path.join(proj, "enc-new", "new.jsonl"), startNew, 5, "worker", "/srv/proj-new");
  plantSession(path.join(proj, "enc-new", "old.jsonl"), startOld, 4, "planner", "/srv/proj-new");
  /* Three child files: the replay raises today's sub count, so the restore has to lower it. */
  ["a1", "a2", "a3"].forEach((a, i) =>
    plantChild(path.join(proj, "enc-new", "old", "subagents"), a, startOld + 40000 + i * 20000)
  );
  plantSession(path.join(proj, "enc-new", "stale.jsonl"), startStale, 3, "worker", "/srv/proj-new");
  // a second, older project to pick
  plantSession(
    path.join(proj, "enc-other", "o.jsonl"),
    minute(nowMs - 5 * DAY),
    2,
    "worker",
    "/srv/proj-other"
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
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: HOME }
  });
  const tmp = path.join(SCRATCH, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    env: { ...process.env, TEMP: tmp, TMP: tmp }
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const consoleText = [];
    page.on("console", (m) => consoleText.push(m.text()));
    page.on("pageerror", (e) => errors.push("page error: " + e.message));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(
      () => {
        const p = document.getElementById("projectPicker");
        return !!p && !p.hidden && p.options.length === 2 && p.value;
      },
      null,
      { timeout: 20000 }
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#sessionLog .log-line").length > 1,
      null,
      { timeout: 15000 }
    );

    // ---- the History tab is there in Claude Code mode ----
    const histVisible = await page.evaluate(() => {
      const b = document.getElementById("viewHistory");
      return !b.hidden && getComputedStyle(b).display !== "none";
    });
    if (!histVisible) errors.push("History button is not visible in Claude Code mode");
    await page.click("#viewHistory");
    await page.waitForFunction(
      () => document.getElementById("claudeHistorySession").options.length === 3,
      null,
      { timeout: 15000 }
    );
    const opts = await page.evaluate(() =>
      [...document.getElementById("claudeHistorySession").options].map((o) => ({
        value: o.value,
        text: o.textContent
      }))
    );
    const listLabel = (start, minutes) => `${when(start)} · ${minutes} min`;
    const wantTexts = ["Choose a session…", listLabel(startNew, 5), listLabel(startOld, 4)];
    if (JSON.stringify(opts.map((o) => o.text)) !== JSON.stringify(wantTexts)) {
      errors.push(
        "picker labels: " +
          JSON.stringify(opts.map((o) => o.text)) +
          " want " +
          JSON.stringify(wantTexts)
      );
    }
    if (opts.slice(1).some((o) => !/^cs-[0-9a-f]{24}$/.test(o.value))) {
      errors.push("option values are not opaque ids");
    }
    const histOpen = await page.evaluate(() => document.getElementById("app").dataset.viewMode);
    if (histOpen !== "history") errors.push("view is " + histOpen);
    const status1 = await page.textContent("#claudeHistoryStatus");
    if (status1 !== "2 sessions from the last 14 days") errors.push("list status: " + status1);

    // ---- a big Live session: more rows than the 40 a reconnect backlog carries ----
    // Rows arrive while the page is connected, so every one reaches the stage and the Bill. A
    // restore that rebuilt Live from a reconnect would keep only the last 40 of them.
    const liveFile = path.join(proj, "enc-new", "new.jsonl");
    const ROWS = 120;
    const appendRows = (names, tokensEach, tag) =>
      fs.appendFileSync(
        liveFile,
        names
          .map((name, i) =>
            at(
              L.assistant(
                [L.toolUse(`toolu_${tag}${i}`, "Read", { file_path: `/srv/proj-new/${name}` })],
                {
                  id: `msg_${tag}${i}`,
                  usage: { input_tokens: tokensEach[0], output_tokens: tokensEach[1] }
                }
              ),
              Date.now() + i
            )
          )
          .join("\n") + "\n"
      );
    await page.evaluate(() =>
      window.__cursorAgentsDashTest.applyLiveEvent({
        role: "worker",
        active: ["worker"],
        message: "live work"
      })
    );
    const base = await sig(page);
    appendRows(
      Array.from({ length: ROWS }, (_, i) => `bulk-${i}.txt`),
      [10, 5],
      "b"
    );
    await page.waitForFunction(
      (t) => window.__cursorAgentsDashTest.demoUsageTokenTotal() === t,
      base.tokens + ROWS * 15,
      { timeout: 20000 }
    );
    const before = await sig(page);
    trace("Live before", before);
    if (!(before.lines >= base.lines + ROWS && before.tokens === base.tokens + ROWS * 15)) {
      errors.push("no big Live state to protect: " + JSON.stringify({ base, before }));
    }
    // a spy on the error sound for the whole run
    await page.evaluate(() => {
      window.__errPlays = 0;
      const real = window.WorkshopSound.play;
      window.WorkshopSound.play = function (name, opts) {
        // the stage row passes its role; the alert center plays its own cue without one
        if (name === "error" && opts && opts.role) window.__errPlays += 1;
        return real.apply(this, arguments);
      };
    });
    const errPlays = () => page.evaluate(() => window.__errPlays);
    const alertCount = async () =>
      (await (await fetch(`http://127.0.0.1:${port}/api/alerts`)).json()).alerts.length;

    // ---- pick the older session: the Live stage, Bill and log stay as they are ----
    const alertsBefore = await alertCount();
    await page.selectOption("#claudeHistorySession", opts[2].value);
    await page.waitForFunction(
      () => /\d+ events?$/.test(document.getElementById("claudeHistoryStatus").textContent),
      null,
      { timeout: 15000 }
    );
    const picked = await sig(page);
    trace("after choosing a session", picked);
    errors.push(...differ("choosing a session", before, picked));
    const hintPicked = await page.textContent("#historyHint");
    if (/driving/.test(hintPicked)) errors.push("hint claims the replay drives: " + hintPicked);
    const apiBody = await (
      await fetch(
        `http://127.0.0.1:${port}/api/claude/session?id=${encodeURIComponent(opts[2].value)}`
      )
    ).json();
    const n = apiBody.events.length;
    const loadedText = await page.evaluate(
      () => document.getElementById("claudeHistorySession").selectedOptions[0].textContent
    );
    const wantLoaded = `${when(startOld)} · ${n} ${n === 1 ? "event" : "events"} · 4 min`;
    if (loadedText !== wantLoaded)
      errors.push("loaded label: " + loadedText + " want " + wantLoaded);
    const meta0 = await page.textContent("#historyReplayHost [data-scrubber-meta]");
    if (meta0 !== `1 / ${n}`) errors.push("transport meta before Play: " + meta0);

    // ---- Play, a Live row arrives, Stage: Live is back exactly, plus that row ----
    const startBefore = await liveRoleStart(page, "worker");
    await play(page);
    const played = await sig(page);
    trace("after Play", played);
    if (!played.taken) errors.push("Play did not take the stage");
    if (played.log === before.log)
      errors.push(
        "the stage did not change after Play: " + JSON.stringify(before.log.slice(0, 300))
      );
    if (played.fastest) errors.push("a Claude replay start recorded fastest: " + played.fastest);
    if (!played.guard || !played.guard.holding)
      errors.push("no snapshot held: " + JSON.stringify(played.guard));
    appendRows(["during-1.txt", "during-2.txt"], [7, 3], "d");
    await page.waitForFunction(
      () => window.__cursorAgentsDashTest.replayGuardInfo().queued >= 2,
      null,
      { timeout: 20000 }
    );
    const mid = await sig(page);
    trace("Play + 2 live rows queued", mid);
    if (mid.tokens !== played.tokens || mid.lines !== played.lines) {
      errors.push("a Live row reached the stage during the replay");
    }
    // a cue log for the hand-back: the queued rows must play no crate or spark cue
    await page.evaluate(() => {
      window.__cues = [];
      const real = window.WorkshopSound.play;
      window.WorkshopSound.play = function (name) {
        window.__cues.push(String(name));
        return real.apply(this, arguments);
      };
    });
    await page.click("#viewStage");
    const cues = await page.evaluate(() => window.__cues || []);
    /* Only the cues a crate or spark plays as it starts: crates from the 120 Live rows
       before the replay pop while the hand-back runs, so "pop" is not counted here. */
    const noisy = cues.filter((c) => c === "spark" || c === "edit" || c === "tick");
    if (noisy.length) errors.push("the restore was not quiet: " + JSON.stringify(noisy));
    const back = await sig(page);
    trace("after Stage", back);
    if (back.taken || (back.guard && back.guard.holding))
      errors.push("Live did not get the stage back");
    if (back.tokens !== before.tokens + 20 || back.lines !== before.lines + 2) {
      errors.push("Bill or log after leaving History: " + JSON.stringify({ before, back }));
    }
    if (!back.log.startsWith(before.log)) errors.push("log lost its earlier lines");
    const tail2 = back.log.slice(before.log.length);
    if (!(
      tail2.indexOf("during-1.txt") >= 0 &&
      tail2.indexOf("during-1.txt") < tail2.indexOf("during-2.txt")
    )) {
      errors.push("the rows that arrived during the replay are missing or out of order: " + tail2);
    }
    if (back.runs !== before.runs || back.dayTokens !== before.dayTokens + 20 || back.fastest) {
      errors.push("restoring Live touched today's stats: " + JSON.stringify({ before, back }));
    }
    for (const key of ["calls", "hudSubs", "privacy"]) {
      if (JSON.stringify(back[key]) !== JSON.stringify(before[key]))
        errors.push(
          `${key} changed across the replay: ${JSON.stringify(before[key])} -> ${JSON.stringify(back[key])}`
        );
    }
    if ((await alertCount()) !== alertsBefore) errors.push("restoring Live raised alerts");
    if ((await errPlays()) !== 0) errors.push("restoring Live played the error sound");
    const startAfter = await liveRoleStart(page, "worker");
    if (!(startBefore > 0)) errors.push("no Live role start to check across the replay");
    else if (!(startAfter > startBefore)) {
      errors.push(
        "the replay's minutes were charged to a Live role: " +
          JSON.stringify({ startBefore, startAfter })
      );
    }

    // ---- the replay reaches its three subagent files: today's Runs must never move ----
    const runsBefore = back.runs;
    await page.click("#viewHistory");
    await waitList(page);
    await page.selectOption("#claudeHistorySession", opts[2].value);
    await play(page);
    await seekLast(page, apiBody.events);
    const withSubs = await sig(page);
    trace("replay at its last event", withSubs);
    if (!(withSubs.hudSubs !== back.hudSubs || withSubs.log !== back.log)) {
      errors.push("the replay did not reach its subagent rows");
    }
    if (dayOf(withSubs) !== dayOf(back)) {
      errors.push(
        "a replay changed today's counters while it owned the stage: " +
          JSON.stringify({ before: dayOf(back), during: dayOf(withSubs) })
      );
    }
    await page.click("#viewStage");
    const afterSubs = await sig(page);
    trace("after the subagent replay", afterSubs);
    if (afterSubs.runs !== runsBefore) {
      errors.push(
        "today's Runs stuck after a replay: " +
          JSON.stringify({ runsBefore, after: afterSubs.runs })
      );
    }

    // ---- Play, then Insights: Live is back, the flag is false, a later Stage changes nothing ----
    await page.click("#viewHistory");
    await waitList(page);
    const s2 = await sig(page);
    await play(page);
    await seekLast(page, apiBody.events);
    if (dayOf(await sig(page)) !== dayOf(s2))
      errors.push("Insights case: counters moved during the replay");
    await page.click("#viewInsights");
    const viaInsights = await sig(page);
    trace("after Insights", viaInsights);
    if (dayOf(viaInsights) !== dayOf(s2))
      errors.push("leaving for Insights left the replay's counters: " + dayOf(viaInsights));
    if (viaInsights.taken) errors.push("leaving History for Insights left the replay flag set");
    errors.push(...differ("Play then Insights", s2, viaInsights));
    await page.click("#viewStage");
    errors.push(...differ("Insights then Stage", s2, await sig(page)));

    // ---- three quick pick / Play / leave cycles ----
    for (let i = 0; i < 3; i++) {
      await page.click("#viewHistory");
      await waitList(page);
      await page.selectOption("#claudeHistorySession", opts[i % 2 === 0 ? 2 : 1].value);
      await play(page);
      await page.click(i === 1 ? "#viewInsights" : "#viewStage");
      errors.push(...differ("quick cycle " + i, s2, await sig(page)));
    }
    await page.click("#viewStage");

    // ---- privacy: page text, markup, console (History open, a session loaded) ----
    await page.click("#viewHistory");
    await waitList(page);
    await page.selectOption("#claudeHistorySession", opts[2].value);
    await play(page);
    const pageText = await page.evaluate(() => document.body.innerText);
    const pageHtml = await page.evaluate(() => document.documentElement.outerHTML);
    for (const [name, text] of [
      ["page text", pageText],
      ["console", consoleText.join("\n")]
    ]) {
      if (FORBIDDEN.test(text)) errors.push(name + " carries a path-like or secret-like value");
      if (/cs-[0-9a-f]{24}/.test(text)) errors.push(name + " carries an opaque session id");
      if (text.includes(SECRET_PROMPT)) errors.push(name + " carries prompt text");
      if (text.includes("/srv/")) errors.push(name + " carries a project path");
    }
    if (pageHtml.includes(SECRET_PROMPT)) errors.push("markup carries prompt text");
    if (FORBIDDEN.test(pageHtml)) errors.push("markup carries a path-like or secret-like value");
    if (/cs-[0-9a-f]{24}/.test(pageHtml.replace(/value="cs-[0-9a-f]{24}"/g, "")))
      errors.push("markup carries an opaque session id outside option values");
    if (pageHtml.includes("/srv/")) errors.push("markup carries a project path");
    if (opts.some((o) => /stale|\.jsonl/.test(o.text))) errors.push("a file name reached a label");

    // ---- a Live failure during Play: the alert arrives, no error sound for it, the row is there after ----
    const alerts0 = await alertCount();
    const plays0 = await errPlays();
    fs.appendFileSync(
      liveFile,
      at(L.notification("toolu_1", "agent1", "failed"), Date.now()) + "\n"
    );
    await page.evaluate(() =>
      window.__cursorAgentsDashTest.applyLiveEvent({
        id: 970001,
        role: "worker",
        type: "error",
        kind: "status",
        message: "Queued failure marker",
        failed: true,
        active: ["worker"]
      })
    );
    const deadline = Date.now() + 20000;
    while ((await alertCount()) <= alerts0 && Date.now() < deadline) await page.waitForTimeout(150);
    if ((await alertCount()) <= alerts0)
      errors.push("no alert for a Live failure during the replay");
    await page.waitForFunction(
      () => window.__cursorAgentsDashTest.replayGuardInfo().queued >= 2,
      null,
      { timeout: 20000 }
    );
    await page.click("#viewStage");
    const failedBack = await sig(page);
    trace("after failed-row Stage", failedBack);
    if ((await errPlays()) !== plays0)
      errors.push("a row queued during the replay played the error sound");
    if (!failedBack.log.includes("Queued failure marker"))
      errors.push("the queued failed row is missing");
    if (failedBack.taken) errors.push("the replay flag stayed set after a failed row");
    if (failedBack.fastest) errors.push("queued rows recorded fastest: " + failedBack.fastest);

    // ---- an SSE reset during Play (a newer session): the replay ends, Live is rebuilt, no stale snapshot ----
    await page.click("#viewHistory");
    await waitList(page);
    await page.selectOption("#claudeHistorySession", opts[2].value);
    await play(page);
    plantSession(
      path.join(proj, "enc-new", "newer.jsonl"),
      minute(Date.now()),
      1,
      "worker",
      "/srv/proj-new"
    );
    await page.waitForFunction(() => !window.__cursorAgentsDashTest.isReplaySessionActive(), null, {
      timeout: 30000
    });
    const afterReset = await sig(page);
    if (afterReset.guard.holding) errors.push("a reset left the snapshot held");
    await page.waitForFunction(
      () =>
        window.__cursorAgentsDashTest.demoUsageTokenTotal() > 0 &&
        window.__cursorAgentsDashTest.demoUsageTokenTotal() < 1000,
      null,
      { timeout: 20000 }
    );
    const rebuilt = await sig(page);
    trace("after SSE reset (rebuilt)", rebuilt);
    if (rebuilt.tokens >= failedBack.tokens)
      errors.push("Live was not rebuilt from the bridge after a reset");
    await page.click("#viewStage");
    const afterLeave = await sig(page);
    trace("after reset then Stage", afterLeave);
    if (afterLeave.tokens !== rebuilt.tokens || afterLeave.log !== rebuilt.log) {
      errors.push(
        "leaving History applied a stale snapshot after a reset: " +
          JSON.stringify({ rebuilt: rebuilt.tokens, afterLeave: afterLeave.tokens })
      );
    }

    // ---- a project pick while a replay owns the stage ----
    await page.click("#viewHistory");
    await waitList(page);
    const optsNow = await page.evaluate(() =>
      [...document.getElementById("claudeHistorySession").options].map((o) => o.value)
    );
    const liveBeforePick = await sig(page);
    await page.selectOption("#claudeHistorySession", optsNow[1]);
    await play(page);
    const preFail = await sig(page);
    if (!preFail.taken) errors.push("Play did not take the stage before the pick");
    // a pick that fails hands the stage back to Live
    await page.route("**/api/select", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "refused for the test" })
      })
    );
    await page.selectOption("#projectPicker", { index: 1 });
    await page.waitForFunction(
      () => /refused for the test/.test(document.getElementById("liveHint").textContent),
      null,
      { timeout: 10000 }
    );
    await page.unroute("**/api/select");
    const afterFail = await sig(page);
    trace("after failed pick", afterFail);
    if (afterFail.taken || afterFail.guard.holding)
      errors.push("a failed project pick left the replay on the stage");
    if (afterFail.guard.restored !== preFail.guard.restored + 1)
      errors.push(
        "a failed pick must restore once: " +
          JSON.stringify({ before: preFail.guard, after: afterFail.guard })
      );
    errors.push(...differ("failed pick", liveBeforePick, afterFail));
    // a real pick
    await page.click("#viewHistory");
    await waitList(page);
    await page.selectOption("#claudeHistorySession", optsNow[1]);
    const dayBeforePick = await sig(page);
    await play(page);
    await seekLast(page, apiBody.events);
    if (dayOf(await sig(page)) !== dayOf(dayBeforePick))
      errors.push("pick case: counters moved during the replay");
    const pickGuard0 = await page.evaluate(() => window.__cursorAgentsDashTest.replayGuardInfo());
    await page.selectOption("#projectPicker", { index: 1 });
    await page.waitForFunction(
      () => document.getElementById("footerProject").textContent === "proj-other",
      null,
      { timeout: 15000 }
    );
    await page.waitForFunction(
      () =>
        window.__cursorAgentsDashTest.demoUsageTokenTotal() > 0 &&
        !window.__cursorAgentsDashTest.isReplaySessionActive(),
      null,
      { timeout: 20000 }
    );
    const picked2 = await sig(page);
    trace("after real pick", picked2);
    if (picked2.guard.holding) errors.push("a project pick left the snapshot held");
    if (
      picked2.guard.restored !== pickGuard0.restored ||
      picked2.guard.applied !== pickGuard0.applied
    )
      errors.push(
        "a successful pick restored the old Live instead of dropping it: " +
          JSON.stringify({ before: pickGuard0, after: picked2.guard })
      );
    if (dayOf(picked2) !== dayOf(dayBeforePick))
      errors.push(
        "a project pick left the replay's counters: " +
          JSON.stringify({ before: dayOf(dayBeforePick), after: dayOf(picked2) })
      );
    if (!(await countingResumed(page)))
      errors.push("after a project pick today's counters stay frozen");
    if (/bulk-|during-|newer/.test(picked2.log))
      errors.push("the old Live leaked into the new project's stage");
    if (picked2.tokens >= before.tokens)
      errors.push("the new project's stage still carries the old Bill");
    const afterPick = await page.evaluate(() => document.getElementById("app").dataset.viewMode);
    if (afterPick !== "history") errors.push("a pick from History moved the view to " + afterPick);

    // History of the other project: its own list, no old replay
    await waitList(page, 2);
    const otherTexts = await page.evaluate(() =>
      [...document.getElementById("claudeHistorySession").options].map((o) => o.textContent)
    );
    if (otherTexts[1] !== listLabel(minute(nowMs - 5 * DAY), 2)) {
      errors.push("other project's list: " + JSON.stringify(otherTexts));
    }
    // a project pick from Stage keeps the Stage view
    await page.click("#viewStage");
    await page.selectOption("#projectPicker", { index: 0 });
    await page.waitForFunction(
      () => document.getElementById("footerProject").textContent === "proj-new",
      null,
      { timeout: 15000 }
    );
    const pickFromStage = await page.evaluate(
      () => document.getElementById("app").dataset.viewMode
    );
    if (pickFromStage !== "stage") errors.push("a project pick moved the view to " + pickFromStage);

    // ---- a switch to Cursor while a replay owns the stage ----
    await page.click("#viewHistory");
    await waitList(page);
    await page.selectOption("#claudeHistorySession", opts[2].value);
    const dayBeforeSwitch = await sig(page);
    await play(page);
    await seekLast(page, apiBody.events);
    if (dayOf(await sig(page)) !== dayOf(dayBeforeSwitch))
      errors.push("switch case: counters moved during the replay");
    await page.click("#sourceCursor", { force: true });
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Cursor",
      null,
      { timeout: 20000 }
    );
    await page.waitForFunction(() => !window.__cursorAgentsDashTest.isReplaySessionActive(), null, {
      timeout: 10000
    });
    const onCursor = await sig(page);
    trace("after switch to Cursor", onCursor);
    if (onCursor.guard.holding) errors.push("a source switch left the snapshot held");
    if (dayOf(onCursor) !== dayOf(dayBeforeSwitch))
      errors.push(
        "a source switch left the replay's counters: " +
          JSON.stringify({ before: dayOf(dayBeforeSwitch), after: dayOf(onCursor) })
      );
    if (!(await countingResumed(page)))
      errors.push("after a source switch today's counters stay frozen");
    if (onCursor.tokens !== 0)
      errors.push("Claude Code rows stayed on the Cursor stage: " + onCursor.tokens);
    const hiddenOnCursor = await page.evaluate(
      () => document.getElementById("claudeHistoryHost").hidden
    );
    if (!hiddenOnCursor) errors.push("the Claude Code picker is shown on the Cursor source");
    await page.screenshot({ path: path.join(SCRATCH, "claude-history.png") });
  } finally {
    await ctx.close();
    await stopBridge();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error("claude-history-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("claude-history-smoke OK · two in-window sessions listed, replayed, no leaks");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
