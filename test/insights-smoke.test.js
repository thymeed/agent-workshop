/**
 * Insights panel smoke (Demo mode).
 * Loads test/insights-harness.html which mounts window.Insights.init(el, { demo: true }).
 */
"use strict";

const path = require("path");
const http = require("http");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const HARNESS = path.resolve(__dirname, "insights-harness.html");
const FIXTURE = path.resolve(__dirname, "fixtures", "history-demo.json");
const FILE_URL = pathToFileURL(HARNESS).href;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function attachErrorCollectors(page) {
  const errors = [];
  const failedRequests = [];
  page.on("pageerror", (err) => {
    errors.push("pageerror: " + (err && err.message ? err.message : String(err)));
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console: " + msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(req.url() + " · " + (req.failure() && req.failure().errorText));
  });
  return { errors, failedRequests };
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let rel = urlPath === "/" ? "/test/insights-harness.html" : urlPath;
      const abs = path.normalize(path.join(ROOT, rel));
      if (!abs.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(abs, (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

async function assertInsightsUi(page, label, errors) {
  await page.waitForSelector(".insights-root", { timeout: 8000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector(".insights-status");
      return status && /events/i.test(status.textContent || "");
    },
    { timeout: 8000 }
  );

  const hasApi = await page.evaluate(() => {
    return !!(window.Insights && typeof window.Insights.init === "function");
  });
  if (!hasApi) errors.push(label + ": window.Insights.init missing");

  /* Forecast */
  const forecastOk = await page.evaluate(() => {
    const spend = document.querySelector("[data-forecast-spend]");
    const table = document.querySelector("[data-forecast-table]");
    const hit = document.querySelector("[data-forecast-hit]");
    const pace = document.querySelector("[data-forecast-pace]");
    const scope = hit && hit.getAttribute("data-forecast-scope");
    const paceText = pace && pace.textContent ? pace.textContent : "";
    return !!(
      spend &&
      /\$/.test(spend.textContent || "") &&
      table &&
      hit &&
      scope === "all-sessions" &&
      /\/day/i.test(paceText) &&
      /All sessions/i.test(hit.textContent || "") &&
      (hit.textContent || "").length > 8
    );
  });
  if (!forecastOk) errors.push(label + ": forecast panel incomplete");

  const forecastStableAcrossSessions = await page.evaluate(async () => {
    const select = document.querySelector(".insights-session");
    if (!select || select.options.length < 2) return true;
    const pace = () => (document.querySelector("[data-forecast-pace]") || {}).textContent || "";
    const spend = () => (document.querySelector("[data-forecast-spend]") || {}).textContent || "";
    const hit = () => (document.querySelector("[data-forecast-hit]") || {}).textContent || "";
    select.selectedIndex = 0;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const p0 = pace();
    const s0 = spend();
    const h0 = hit();
    select.selectedIndex = 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const p1 = pace();
    const s1 = spend();
    const h1 = hit();
    return p0 === p1 && s0 === s1 && h0 === h1;
  });
  if (!forecastStableAcrossSessions) {
    errors.push(label + ": forecast pace/spend should use all sessions, not selected session");
  }

  /* Suggestions. Ranked by savings, jump event, honesty hint */
  await page.click('.insights-tab[data-tab="suggestions"]');
  await page.waitForSelector('[data-panel="suggestions"].on', { timeout: 3000 });
  const suggestOk = await page.evaluate(() => {
    const honesty = document.querySelector("[data-suggestions-honesty]");
    const honestyText = honesty && honesty.textContent ? honesty.textContent : "";
    if (!/does not change Cursor routing/i.test(honestyText)) return false;

    const empty = document.querySelector("[data-suggestions-empty]");
    if (empty) return true;

    const list = document.querySelector("[data-suggestions-list]");
    if (!list) return false;
    const items = list.querySelectorAll("li[data-agent-id]");
    if (!items.length) return false;

    const savingsEls = list.querySelectorAll("[data-suggest-savings]");
    if (savingsEls.length !== items.length) return false;
    const amounts = [];
    for (let i = 0; i < savingsEls.length; i++) {
      const m = (savingsEls[i].textContent || "").match(/\$[\d.]+/);
      if (!m) return false;
      amounts.push(parseFloat(m[0].slice(1)));
    }
    for (let i = 1; i < amounts.length; i++) {
      if (amounts[i] > amounts[i - 1] + 1e-9) return false;
    }

    if (!document.querySelector("[data-suggestions-copy]")) return false;

    const reason = items[0].querySelector(".insights-suggest-reason");
    if (!(reason && reason.textContent.trim().length > 10)) return false;

    const row = items[0];
    if (row.getAttribute("tabindex") !== "0") return false;
    let jumped = null;
    function onJump(ev) {
      jumped = ev && ev.detail ? ev.detail : null;
    }
    window.addEventListener("cursor-agents:jump-to-agent", onJump);
    row.click();
    window.removeEventListener("cursor-agents:jump-to-agent", onJump);
    if (
      !jumped ||
      jumped.agentId !== row.getAttribute("data-agent-id") ||
      typeof jumped.name !== "string" ||
      typeof jumped.model !== "string" ||
      typeof jumped.suggestion !== "string" ||
      typeof jumped.savings !== "number"
    ) {
      return false;
    }
    return true;
  });
  if (!suggestOk) errors.push(label + ": suggestions panel empty/incomplete");

  const suggestSortApiOk = await page.evaluate(() => {
    const events = [
      {
        ts: "2026-10-09T14:00:00.000Z",
        sessionId: "sort",
        agentId: "agent-a",
        parentId: "p",
        name: "Zebra scan",
        model: "fable",
        type: "turn",
        inputTokens: 8000,
        outputTokens: 400,
        files: ["a.js"]
      },
      {
        ts: "2026-10-09T14:00:01.000Z",
        sessionId: "sort",
        agentId: "agent-a",
        parentId: "p",
        name: "Zebra scan",
        model: "fable",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:00:02.000Z",
        sessionId: "sort",
        agentId: "agent-b",
        parentId: "p",
        name: "Alpha scan",
        model: "fable",
        type: "turn",
        inputTokens: 60000,
        outputTokens: 800,
        files: ["b.js"]
      },
      {
        ts: "2026-10-09T14:00:03.000Z",
        sessionId: "sort",
        agentId: "agent-b",
        parentId: "p",
        name: "Alpha scan",
        model: "fable",
        type: "done",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      }
    ];
    const list = window.Insights.analyze.routingSuggestions(events);
    if (!list || list.length < 2) return false;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.savings > prev.savings + 1e-9) return false;
      if (Math.abs(cur.savings - prev.savings) < 1e-9 && cur.name.localeCompare(prev.name) < 0) {
        return false;
      }
    }
    return list[0].savings >= list[1].savings;
  });
  if (!suggestSortApiOk) errors.push(label + ": routingSuggestions not sorted by savings/name");

  /* Replay scrubber */
  await page.click('.insights-tab[data-tab="replay"]');
  await page.waitForSelector('[data-panel="replay"].on', { timeout: 3000 });
  const treeNodes = await page.locator(".insights-tree-node").count();
  if (!treeNodes) errors.push(label + ": replay tree missing nodes");
  const scrubOk = await page.evaluate(() => {
    const scrubber = document.querySelector(".insights-scrubber");
    const meta = document.querySelector("[data-scrubber-meta]");
    const eventEl = document.querySelector("[data-replay-event]");
    const tree = document.querySelector("[data-replay-tree]");
    if (!scrubber || !meta || !eventEl || !tree) return false;
    const max = Number(scrubber.max || 0);
    if (max < 1) return false;

    function snapshot() {
      return {
        meta: meta.textContent || "",
        event: eventEl.textContent || "",
        nodes: tree.querySelectorAll(".insights-tree-node").length
      };
    }

    scrubber.value = "0";
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    const atStart = snapshot();

    scrubber.value = String(max);
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    const atEnd = snapshot();

    const changed =
      atStart.meta !== atEnd.meta || atStart.event !== atEnd.event || atStart.nodes !== atEnd.nodes;
    return changed && atEnd.nodes > 0;
  });
  if (!scrubOk) errors.push(label + ": replay scrubber did not change rendered state");

  /* Replay transport API: scrub notifies, play advances index */
  const transportOk = await page.evaluate(async () => {
    const handle = window.__insightsHandle;
    if (
      !handle ||
      typeof handle.play !== "function" ||
      typeof handle.pause !== "function" ||
      typeof handle.setSpeed !== "function" ||
      typeof handle.getTransportState !== "function" ||
      typeof handle.onReplayIndex !== "function" ||
      typeof handle.setReplayIndex !== "function" ||
      typeof handle.showTab !== "function" ||
      typeof handle.mountReplay !== "function" ||
      typeof handle.getReplayController !== "function"
    ) {
      return { ok: false, reason: "api" };
    }

    const seen = [];
    const off = handle.onReplayIndex(function (payload) {
      if (payload && typeof payload.index === "number") {
        seen.push({ index: payload.index, source: payload.source });
      }
    });

    handle.showTab("replay");
    handle.setReplayIndex(0, { source: "test", forceNotify: true });
    const scrubber = document.querySelector(".insights-scrubber");
    if (!scrubber) return { ok: false, reason: "scrubber" };
    const max = Number(scrubber.max || 0);
    if (max < 2) return { ok: false, reason: "short" };

    scrubber.value = String(Math.min(2, max));
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    const afterScrub = handle.getTransportState();
    const scrubNotified = seen.some(function (s) {
      return s.source === "scrub" && s.index === afterScrub.index;
    });

    handle.setReplayIndex(0, { source: "test" });
    const start = handle.getTransportState().index;
    handle.setSpeed(2);
    handle.play();
    await new Promise(function (r) {
      setTimeout(r, 700);
    });
    const mid = handle.getTransportState();
    handle.pause();
    const afterPause = handle.getTransportState();
    const ctrl = handle.getReplayController();
    const ctrlOk =
      ctrl &&
      typeof ctrl.play === "function" &&
      typeof ctrl.getTransportState === "function" &&
      ctrl.getTransportState().playing === false;
    if (typeof off === "function") off();

    if (!scrubNotified) return { ok: false, reason: "scrub-notify" };
    if (!mid || !(mid.index > start)) return { ok: false, reason: "play" };
    if (mid.speed !== 2) return { ok: false, reason: "speed" };
    if (afterPause.playing) return { ok: false, reason: "still-playing" };
    if (seen.length < 2) return { ok: false, reason: "callbacks" };
    if (!ctrlOk) return { ok: false, reason: "controller" };
    return { ok: true, reason: "ok" };
  });
  if (!transportOk || !transportOk.ok) {
    errors.push(
      label +
        ": replay transport API failed (" +
        ((transportOk && transportOk.reason) || "unknown") +
        ")"
    );
  }

  /* What-if */
  await page.click('.insights-tab[data-tab="whatif"]');
  await page.waitForSelector('[data-panel="whatif"].on', { timeout: 3000 });
  const whatIfOk = await page.evaluate(() => {
    const disclaimer = document.querySelector("[data-whatif-disclaimer]");
    const list = document.querySelector("[data-whatif-list]");
    const text = disclaimer && disclaimer.textContent ? disclaimer.textContent : "";
    return (
      /Estimates\s*·\s*not official invoices/i.test(text) &&
      /same tokens,\s*different prices;\s*real behavior may differ\./i.test(text) &&
      list &&
      list.querySelectorAll("li").length >= 3
    );
  });
  if (!whatIfOk) errors.push(label + ": what-if panel missing disclaimer or scenarios");

  const glossaryOk = await page.evaluate(() => {
    const g = document.querySelector("[data-estimates-glossary]");
    const text = g && g.textContent ? g.textContent : "";
    return /Estimates\s*·\s*not official invoices/i.test(text);
  });
  if (!glossaryOk) errors.push(label + ": Insights Estimates glossary missing");

  /* Pure analyze helpers */
  const analyzeOk = await page.evaluate(() => {
    const sample = [
      {
        ts: "2026-10-09T14:00:00.000Z",
        sessionId: "s",
        agentId: "a",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "turn",
        inputTokens: 1000000,
        outputTokens: 0,
        files: []
      }
    ];
    const f = window.Insights.analyze.forecast(sample, 10);
    const c = window.Insights.analyze.costFor("opus", 1e6, 0);

    const burst = [
      {
        ts: "2026-10-09T14:00:00.000Z",
        sessionId: "burst",
        agentId: "a",
        parentId: null,
        name: "A",
        model: "opus",
        type: "turn",
        inputTokens: 1e6,
        outputTokens: 0,
        files: []
      }
    ];
    const slow = [
      {
        ts: "2026-10-01T00:00:00.000Z",
        sessionId: "slow",
        agentId: "b",
        parentId: null,
        name: "B",
        model: "opus",
        type: "turn",
        inputTokens: 1e6,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T00:00:00.000Z",
        sessionId: "slow",
        agentId: "b",
        parentId: null,
        name: "B",
        model: "opus",
        type: "turn",
        inputTokens: 1e6,
        outputTokens: 0,
        files: []
      }
    ];
    const fb = window.Insights.analyze.forecast(burst, 100);
    const fs = window.Insights.analyze.forecast(slow, 100);
    const dailyUsesSpan = fs.spanDays >= 7 && fs.usdPerDay < fb.usdPerDay && fs.usdPerDay > 0;

    return (
      f.limit === 10 && Math.abs(c - 4) < 0.001 && f.spend > 0 && f.usdPerDay > 0 && dailyUsesSpan
    );
  });
  if (!analyzeOk) errors.push(label + ": analyze.forecast/costFor failed");

  /* Claude Code replay events (setReplayEvents) feed the replay only, never forecast,
     suggestions or what-if (owner decision). Session change re-renders all three panels. */
  const replayOnly = await page.evaluate(() => {
    const h = window.__insightsHandle;
    const select = document.querySelector(".insights-session");
    const rerender = () => select.dispatchEvent(new Event("change", { bubbles: true }));
    const snap = () =>
      ["forecast", "suggestions", "whatif"]
        .map((p) => document.querySelector('[data-panel="' + p + '"]').innerHTML)
        .join("|#|");
    const ctl = h.getReplayController();
    rerender();
    const base = snap();
    const baseCount = ctl.getEvents().length;
    const baseIds = JSON.stringify(ctl.getEvents().map((e) => e.agentId));
    const claude = [0, 1, 2].map((i) => ({
      ts: "09:0" + i + ":00",
      iso: "2026-11-18T09:0" + i + ":00.000Z",
      replay: true,
      agentId: "session",
      name: "parent",
      model: "claude-opus-4-1",
      parentId: null,
      type: "message",
      inputTokens: 9000000,
      outputTokens: 9000000,
      files: []
    }));
    h.setReplayEvents(claude);
    rerender();
    const during = {
      same: snap() === base,
      count: h.getTransportState().count,
      listed: ctl.getEvents().length,
      first: ctl.getEvents()[0] && ctl.getEvents()[0].agentId
    };
    h.setReplayEvents(null);
    rerender();
    return {
      baseCount,
      during,
      restoredCount: h.getTransportState().count,
      restoredSame: JSON.stringify(ctl.getEvents().map((e) => e.agentId)) === baseIds,
      panelsSame: snap() === base
    };
  });
  if (!replayOnly.during.same)
    errors.push(label + ": Claude replay events changed forecast, suggestions or what-if");
  if (
    replayOnly.during.count !== 3 ||
    replayOnly.during.listed !== 3 ||
    replayOnly.during.first !== "session"
  )
    errors.push(
      label + ": replay did not show the Claude events: " + JSON.stringify(replayOnly.during)
    );
  if (replayOnly.baseCount === 3)
    errors.push(label + ": replay test needs a history that is not 3 events");
  if (
    replayOnly.restoredCount !== replayOnly.baseCount ||
    !replayOnly.restoredSame ||
    !replayOnly.panelsSame
  )
    errors.push(label + ": setReplayEvents(null) did not restore the history replay");

  /* Claude Code wording: no Cursor copy in an empty tree while the Claude picker owns the sheet.
     A second panel whose history is empty (fetch stubbed for its load). */
  const emptyCopy = await page.evaluate(async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const realFetch = window.fetch;
    window.fetch = async () => ({ ok: true, json: async () => ({ events: [] }) });
    const h = window.Insights.init(mount, { demo: false });
    await new Promise((r) => h.onReady(r));
    window.fetch = realFetch;
    const host = () => (mount.querySelector("[data-tree-empty]") || {}).textContent || "";
    const cursor = host();
    h.setReplayEmptyText("Choose a session above to replay it.");
    const claudeIdle = host();
    h.setReplayEvents([]);
    const claudeLoaded = host();
    h.setReplayEvents(null);
    h.setReplayEmptyText(null);
    const back = host();
    h.destroy();
    mount.remove();
    return { cursor, claudeIdle, claudeLoaded, back };
  });
  if (!/Spawn a subagent in Cursor/.test(emptyCopy.cursor + emptyCopy.back))
    errors.push(label + ": Cursor copy lost: " + JSON.stringify(emptyCopy));
  if (/cursor/i.test(emptyCopy.claudeIdle) || !/Choose a session/.test(emptyCopy.claudeIdle))
    errors.push(label + ": idle Claude picker copy: " + emptyCopy.claudeIdle);
  if (/cursor/i.test(emptyCopy.claudeLoaded) || !/Nothing to show/.test(emptyCopy.claudeLoaded))
    errors.push(label + ": empty Claude session copy: " + emptyCopy.claudeLoaded);
}

async function smokeFile(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);
  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await assertInsightsUi(page, "file://", errors);
  await page.close();
  /* file:// fixture fetch may fail; inlined demo fallback is OK. Ignore those */
  const ignored = failedRequests.filter(
    (u) => !/history-demo\.json/i.test(u) && !/fixtures\//i.test(u)
  );
  if (ignored.length) errors.push("failed requests:\n  " + ignored.join("\n  "));
  return errors;
}

async function smokeHttp(browser) {
  const { server, port } = await startStaticServer();
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);
  try {
    await page.goto(`http://127.0.0.1:${port}/test/insights-harness.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await assertInsightsUi(page, "http", errors);

    /* Fixture should be reachable over http */
    const fixtureStatus = await page.evaluate(async () => {
      const r = await fetch("../test/fixtures/history-demo.json");
      return r.status;
    });
    /* harness is under /test/, so relative fixture path from page is fixtures/history-demo.json */
    const fixtureOk = await page.evaluate(async () => {
      const paths = [
        "fixtures/history-demo.json",
        "../test/fixtures/history-demo.json",
        "/test/fixtures/history-demo.json"
      ];
      for (const p of paths) {
        try {
          const r = await fetch(p);
          if (r.ok) {
            const j = await r.json();
            if (j && Array.isArray(j.events) && j.events.length > 0) return true;
          }
        } catch (_) {}
      }
      return false;
    });
    if (!fixtureOk) errors.push("http: history-demo.json not loadable");
    void fixtureStatus;
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

function assertFixtureOnDisk() {
  const errors = [];
  if (!fs.existsSync(FIXTURE)) {
    errors.push("missing test/fixtures/history-demo.json");
    return errors;
  }
  const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  if (!data || !Array.isArray(data.events) || data.events.length < 5) {
    errors.push("history-demo.json must include events[]");
  } else {
    const ev = data.events[0];
    const need = [
      "ts",
      "sessionId",
      "agentId",
      "name",
      "model",
      "type",
      "inputTokens",
      "outputTokens",
      "files"
    ];
    for (const k of need) {
      if (!(k in ev) && k !== "parentId") errors.push("fixture event missing " + k);
    }
    if (!("parentId" in ev)) errors.push("fixture event missing parentId");
  }
  if (!fs.existsSync(path.join(ROOT, "dashboard", "insights.js"))) {
    errors.push("missing dashboard/insights.js");
  }
  if (!fs.existsSync(path.join(ROOT, "dashboard", "insights.css"))) {
    errors.push("missing dashboard/insights.css");
  }
  return errors;
}

/** Live mode with an empty history: Suggestions shows the empty state, honesty chip stays a short line. */
async function smokeEmptySuggestions(browser) {
  const { server, port } = await startStaticServer();
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);
  try {
    await page.route("**/api/history**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"events":[]}' })
    );
    await page.goto(`http://127.0.0.1:${port}/test/insights-harness.html?live=1`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.waitForSelector(".insights-root", { timeout: 8000 });
    await page.click('.insights-tab[data-tab="suggestions"]');
    await page.waitForSelector('[data-panel="suggestions"].on [data-suggestions-empty]', {
      timeout: 5000
    });
    const honesty = await page.locator("[data-suggestions-honesty]").boundingBox();
    if (!honesty || honesty.height > 48) {
      errors.push(
        "empty suggestions: honesty chip height " +
          (honesty ? honesty.height : "missing") +
          "px (max 48)"
      );
    }
    const emptyVisible = await page.locator("[data-suggestions-empty]").isVisible();
    if (!emptyVisible) errors.push("empty suggestions: [data-suggestions-empty] not visible");
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

/**
 * Claude Code live rows: Insights keeps running totals, not the rows. Far more rows than any cap
 * keep the Forecast equal to the sum of every row, the status count equal to the row count, and
 * the page holding one total per model (not per row). The session picker is not rewritten while
 * the set of session ids is unchanged. Suggestions and What-if show a note for the live session,
 * and an older (history-loaded) session in the same picker still gets them.
 */
async function smokeLiveRows(browser) {
  const { server, port } = await startStaticServer();
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);
  const NOTE = "Not available for live sessions yet.";
  try {
    const hist = (extra) =>
      Object.assign(
        {
          ts: "2025-12-31T10:00:00.000Z",
          sessionId: "hist-1",
          agentId: "hist-helper",
          parentId: "hist-lead",
          name: "helper",
          model: "opus",
          type: "turn",
          inputTokens: 5000,
          outputTokens: 500,
          files: []
        },
        extra
      );
    await page.route("**/api/history**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: [hist({})] })
      })
    );
    await page.goto(`http://127.0.0.1:${port}/test/insights-harness.html?live=1`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.waitForSelector(".insights-root", { timeout: 8000 });
    const statusIs = (n) =>
      page.waitForFunction(
        (want) => {
          const e = document.querySelector("[data-status]");
          return !!e && e.textContent.indexOf("Live · " + want + " events") === 0;
        },
        n,
        { timeout: 30000 }
      );
    const row = (i) => ({
      type: "turn",
      iso: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      usage: i % 2 ? { model: "opus", in: 1000, out: 1000 } : { model: "haiku", in: 2000, out: 500 }
    });
    await statusIs(1); // the one history event

    // a few rows: the picker lists the live session next to the history one, same nodes after more rows
    await page.evaluate(
      (rows) => {
        rows.forEach((r) => window.__insightsHandle.addLiveRow(r));
      },
      [row(0), row(1), row(2)]
    );
    await statusIs(4);
    await page.selectOption(".insights-session", "live-session");
    await page.evaluate(() => {
      const sel = document.querySelector(".insights-session");
      window.__opts = Array.from(sel.options);
    });
    await page.evaluate(
      (rows) => {
        rows.forEach((r) => window.__insightsHandle.addLiveRow(r));
      },
      [row(3), row(4)]
    );
    await statusIs(6);
    const kept = await page.evaluate(() => {
      const sel = document.querySelector(".insights-session");
      const now = Array.from(sel.options);
      return {
        sameNodes:
          now.length === window.__opts.length && now.every((o, i) => o === window.__opts[i]),
        texts: now.map((o) => o.textContent)
      };
    });
    if (!kept.sameNodes) errors.push("live rows: the picker was rewritten with its ids unchanged");
    if (kept.texts.join("|") !== "hist-1|Live session")
      errors.push("live rows: picker options: " + JSON.stringify(kept.texts));

    // the live session (picked by default: it is the newest): a note, no suggestions, no what-if
    const picked = await page.evaluate(() => document.querySelector(".insights-session").value);
    if (picked !== "live-session") errors.push("live rows: session value " + picked);
    const notes = () =>
      page.evaluate(() => ({
        sg: Array.from(
          document.querySelectorAll('[data-panel="suggestions"] [data-live-unavailable]')
        ).map((e) => e.textContent.trim()),
        wi: Array.from(
          document.querySelectorAll('[data-panel="whatif"] [data-live-unavailable]')
        ).map((e) => e.textContent.trim()),
        sgRows: document.querySelectorAll(".insights-suggest-row, [data-suggestions-copy]").length,
        wiRows: document.querySelectorAll("[data-whatif-list], .insights-whatif-row").length
      }));
    const n0 = await notes();
    if (n0.sg.join() !== NOTE || n0.wi.join() !== NOTE || n0.sgRows !== 0 || n0.wiRows !== 0)
      errors.push("live rows: live session panels: " + JSON.stringify(n0));

    // the older session: Suggestions and What-if as they always were
    await page.selectOption(".insights-session", "hist-1");
    await page.waitForSelector('[data-suggestions-list] [data-agent-id="hist-helper"]', {
      state: "attached",
      timeout: 10000
    });
    const n1 = await notes();
    if (n1.sg.length || n1.wi.length || n1.wiRows < 4)
      errors.push("live rows: history session panels: " + JSON.stringify(n1));
    await page.selectOption(".insights-session", "live-session");
    await page.waitForSelector('[data-panel="whatif"] [data-live-unavailable]', {
      state: "attached",
      timeout: 10000
    });

    // far more rows than the old cap: the Forecast is the sum of every row, the page holds totals
    const result = await page.evaluate(
      (mk) => {
        const h = window.__insightsHandle;
        const total = 25000;
        const events = [
          { type: "turn", model: "opus", inputTokens: 5000, outputTokens: 500 } // the history event
        ];
        for (let i = 5; i < total; i++) {
          const u = i % 2 ? mk.opus : mk.haiku;
          h.addLiveRow({
            type: "turn",
            iso: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
            usage: u
          });
        }
        for (let i = 0; i < total; i++) {
          const u = i % 2 ? mk.opus : mk.haiku;
          events.push({ type: "turn", model: u.model, inputTokens: u.in, outputTokens: u.out });
        }
        return { total, expected: window.Insights.analyze.totalCost(events) };
      },
      {
        opus: { model: "opus", in: 1000, out: 1000 },
        haiku: { model: "haiku", in: 2000, out: 500 }
      }
    );
    await statusIs(result.total + 1);
    await page
      .waitForFunction(
        (want) => document.querySelector("[data-forecast-spend]").textContent === want,
        "$" + result.expected.toFixed(2),
        { timeout: 30000 }
      )
      .catch(() => {}); // the comparison below names the figures
    const spend = await page.textContent("[data-forecast-spend]");
    if (spend !== "$" + result.expected.toFixed(2))
      errors.push(
        `live rows: Forecast ${spend}, the sum of every row is $${result.expected.toFixed(2)}`
      );
    const state = await page.evaluate(() => window.__insightsHandle.__testLiveState());
    if (state.rows !== result.total) errors.push("live rows: rows counted " + state.rows);
    if (state.models !== 2) errors.push("live rows: totals held for " + state.models + " models");

    // a reset forgets them
    await page.evaluate(() => window.__insightsHandle.clearLiveRows());
    await statusIs(1);
    const after = await page.evaluate(() => ({
      sel: document.querySelector(".insights-session").value,
      held: window.__insightsHandle.__testLiveState()
    }));
    if (after.sel !== "hist-1" || after.held.rows !== 0 || after.held.models !== 0)
      errors.push("live rows: after clearLiveRows: " + JSON.stringify(after));
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

/** A live harness page with the given history events; resolves once Insights is mounted. */
async function openLiveHarness(browser, port, events, opts) {
  const page = await browser.newPage();
  const collected = attachErrorCollectors(page);
  if (opts && opts.clock) await page.clock.install();
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: events || [] })
    })
  );
  await page.goto(`http://127.0.0.1:${port}/test/insights-harness.html?live=1`, {
    waitUntil: "domcontentloaded",
    timeout: 15000
  });
  await page.waitForSelector(".insights-root", { timeout: 8000 });
  await page.waitForFunction(
    () => /^Live · \d+ events/.test(document.querySelector("[data-status]").textContent),
    null,
    { timeout: 10000 }
  );
  return Object.assign({ page }, collected);
}

const waitStatus = (page, n) =>
  page.waitForFunction(
    (want) =>
      document.querySelector("[data-status]").textContent.indexOf("Live · " + want + " events") ===
      0,
    n,
    { timeout: 10000 }
  );

/** The forecast's model rows and money figures, as the page shows them. */
const forecastView = (page) =>
  page.evaluate(() => ({
    spend: document.querySelector("[data-forecast-spend]").textContent,
    pace: document.querySelector("[data-forecast-pace]").textContent,
    hit: document.querySelector("[data-forecast-hit]").textContent,
    models: Array.from(
      document.querySelectorAll('[data-panel="forecast"] tbody tr[class^="model-"]')
    ).map((tr) => tr.className.replace(/^model-/, "").split(" ")[0]),
    held: window.__insightsHandle.__testLiveState()
  }));

/** One live row at `ms` that costs $1.00 at the Opus list price. */
const dollarRow = (ms) => ({
  type: "turn",
  iso: new Date(ms).toISOString(),
  usage: { model: "opus", in: 250000, out: 0 }
});

/**
 * Live rows against the Bill's math: Insights prices through whatever WorkshopBillMath is loaded
 * (a stub with its own rates here, so the Forecast must follow the stub, not Insights CONFIG),
 * and with the real bill-math a blank model with the explorer role is Haiku, a zero-token row
 * adds no model, a row without a time is stamped now (never NaN), and the span marker is never
 * a model row.
 */
async function smokeLiveRowPricing(browser) {
  const { server, port } = await startStaticServer();
  const errors = [];
  const DAY = 86400000;
  try {
    // (1) a stub Bill with rates unlike Insights CONFIG
    const a = await openLiveHarness(browser, port, []);
    try {
      const bill = await a.page.evaluate(() => {
        window.WorkshopBillMath = {
          RATES: { opus: { in: 100, out: 200 }, haiku: { in: 10, out: 20 } },
          normalizeModel: (m) => (m === "haiku" ? "haiku" : "opus"),
          modelCost: function (m, i, o) {
            const r = this.RATES[m];
            return (i / 1e6) * r.in + (o / 1e6) * r.out;
          }
        };
        const rows = [
          { model: "opus", in: 1000000, out: 0 },
          { model: "haiku", in: 0, out: 1000000 }
        ];
        const iso = new Date(Date.UTC(2026, 0, 1)).toISOString();
        rows.forEach((u) => window.__insightsHandle.addLiveRow({ type: "turn", iso, usage: u }));
        /* What the Bill shows for the same rows: the same stub, summed per model. */
        const bm = window.WorkshopBillMath;
        return rows.reduce((s, u) => s + bm.modelCost(bm.normalizeModel(u.model), u.in, u.out), 0);
      });
      await waitStatus(a.page, 2);
      const v = await forecastView(a.page);
      const want = "$" + bill.toFixed(2);
      if (want !== "$120.00") errors.push("stub bill: expected total " + want);
      if (v.spend !== want) errors.push(`stub bill: Forecast ${v.spend}, the Bill ${want}`);
      errors.push(...a.errors.map((e) => "stub bill: " + e));
    } finally {
      await a.page.close();
    }

    // (2) the real bill-math: role fallback, zero tokens, no time, the span marker
    const b = await openLiveHarness(browser, port, []);
    try {
      await b.page.addScriptTag({ path: path.join(ROOT, "dashboard", "bill-math.js") });
      await b.page.evaluate(() =>
        window.__insightsHandle.addLiveRow({
          type: "turn",
          iso: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          usage: { model: "", role: "explorer", in: 1000000, out: 0 }
        })
      );
      await waitStatus(b.page, 1);
      const v1 = await forecastView(b.page);
      if (v1.models.join() !== "haiku")
        errors.push("blank model, explorer role: model rows " + JSON.stringify(v1.models));
      if (v1.spend !== "$0.10") errors.push("blank model, explorer role: priced " + v1.spend);

      await b.page.evaluate(() =>
        window.__insightsHandle.addLiveRow({
          type: "turn",
          iso: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
          usage: { model: "sonnet", in: 0, out: 0 }
        })
      );
      await waitStatus(b.page, 2);
      const v2 = await forecastView(b.page);
      if (v2.held.models !== 1) errors.push("zero-token row: models held " + v2.held.models);
      if (v2.models.join() !== "haiku") errors.push("zero-token row: model rows " + v2.models);
      if (v2.models.includes("auto")) errors.push("the span marker is a model row");

      // a $1.00 row ten days back, then a row with no time: the span runs to now
      await b.page.evaluate(
        ([row]) => {
          const h = window.__insightsHandle;
          h.clearLiveRows();
          h.addLiveRow(row);
          h.addLiveRow({ type: "turn" });
        },
        [dollarRow(Date.now() - 10 * DAY)]
      );
      // the status already read 2 events before the clear: wait for the $1.00 repaint itself
      await b.page
        .waitForFunction(
          () => document.querySelector("[data-forecast-spend]").textContent === "$1.00",
          null,
          { timeout: 5000 }
        )
        .catch(() => errors.push("row without a time: the Forecast never showed the $1.00 row"));
      const v3 = await forecastView(b.page);
      if (/NaN|Invalid/.test(v3.hit + v3.pace))
        errors.push("row without a time: forecast " + JSON.stringify(v3));
      if (v3.pace !== "$0.10/day")
        errors.push("row without a time: pace " + v3.pace + " (want $1.00 over 10 days to now)");
      if (v3.models.includes("auto")) errors.push("the span marker is a model row: " + v3.models);
      errors.push(...b.errors.map((e) => "real bill-math: " + e));
    } finally {
      await b.page.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return errors;
}

/**
 * The live refresh is debounced: 50 rows inside 100 ms repaint the Forecast once, the next row
 * repaints again, and destroy() clears the pending timer so nothing repaints or throws after it.
 * Fake timers (page.clock) make the 100 ms exact.
 */
async function smokeLiveRowDebounce(browser) {
  const { server, port } = await startStaticServer();
  const errors = [];
  const c = await openLiveHarness(browser, port, [], { clock: true });
  const { page } = c;
  try {
    await page.clock.pauseAt(Date.now() + 1000);
    await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="forecast"]');
      window.__paints = 0;
      new MutationObserver((muts) => {
        window.__paints += muts.filter((m) => m.type === "childList").length;
      }).observe(panel, { childList: true });
      window.__timers = [];
      window.__cleared = [];
      const st = window.setTimeout;
      const ct = window.clearTimeout;
      window.setTimeout = function (fn, ms) {
        const id = st.apply(this, arguments);
        if (ms === 100) window.__timers.push(id);
        return id;
      };
      window.clearTimeout = function (id) {
        window.__cleared.push(id);
        return ct.apply(this, arguments);
      };
    });
    const add = (n, from) =>
      page.evaluate(
        ([count, base]) => {
          for (let i = 0; i < count; i++)
            window.__insightsHandle.addLiveRow({
              type: "turn",
              iso: new Date(Date.UTC(2026, 0, 1) + (base + i) * 1000).toISOString(),
              usage: { model: "opus", in: 1000, out: 0 }
            });
        },
        [n, from]
      );
    for (let k = 0; k < 5; k++) {
      await add(10, k * 10);
      await page.clock.runFor(19); // 5 batches of 10 rows inside 95 ms
    }
    const before = await page.evaluate(() => window.__paints);
    if (before !== 0) errors.push("debounce: repainted before 100 ms: " + before);
    await page.clock.runFor(10);
    const once = await page.evaluate(() => ({
      paints: window.__paints,
      timers: window.__timers.length,
      status: document.querySelector("[data-status]").textContent
    }));
    if (once.paints !== 1)
      errors.push("debounce: 50 rows in 100 ms painted " + once.paints + " times");
    if (once.timers !== 1) errors.push("debounce: " + once.timers + " refresh timers for 50 rows");
    if (once.status.indexOf("Live · 50 events") !== 0)
      errors.push("debounce: status " + once.status);

    // the next row schedules a new refresh
    await add(1, 50);
    await page.clock.runFor(150);
    const twice = await page.evaluate(() => window.__paints);
    if (twice !== 2)
      errors.push("debounce: a later row brought the paints to " + twice + ", want 2");

    // destroy with a refresh pending: the timer is cleared, no repaint, no error
    await add(1, 51);
    const pending = await page.evaluate(() => window.__timers[window.__timers.length - 1]);
    await page.evaluate(() => window.__insightsHandle.destroy());
    await page.clock.runFor(500);
    const after = await page.evaluate(() => ({
      paints: window.__paints,
      cleared: window.__cleared
    }));
    if (!after.cleared.includes(pending))
      errors.push("destroy: the pending refresh timer was not cleared");
    if (after.paints !== 2) errors.push("destroy: repainted after destroy: " + after.paints);

    // after destroy a new row or a clear (which schedules a refresh) still repaints nothing
    await page.evaluate(() => {
      window.__insightsHandle.addLiveRow({ type: "turn", iso: new Date().toISOString() });
      window.__insightsHandle.clearLiveRows();
    });
    await page.clock.runFor(500);
    const late = await page.evaluate(() => window.__paints);
    if (late !== 2) errors.push("destroy: a row or clear after destroy repainted: " + late);
    errors.push(...c.errors.map((e) => "debounce: " + e));
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
  return errors;
}

/**
 * clearLiveRows forgets the span: a new row after a clear spans ~0 (one day at the clamp) even
 * when it falls inside the old first..last range, and a picked live session falls back to the
 * history session.
 */
async function smokeLiveRowClear(browser) {
  const { server, port } = await startStaticServer();
  const errors = [];
  const DAY = 86400000;
  const T0 = Date.UTC(2026, 0, 1);
  try {
    const a = await openLiveHarness(browser, port, []);
    try {
      await a.page.evaluate(
        (rows) => rows.forEach((r) => window.__insightsHandle.addLiveRow(r)),
        [dollarRow(T0), dollarRow(T0 + 10 * DAY)]
      );
      await waitStatus(a.page, 2);
      const v0 = await forecastView(a.page);
      if (v0.pace !== "$0.20/day")
        errors.push("clear: before, pace " + v0.pace + " (want $2.00 over 10 days)");
      await a.page.evaluate(
        (r) => {
          window.__insightsHandle.clearLiveRows();
          window.__insightsHandle.addLiveRow(r);
        },
        dollarRow(T0 + 5 * DAY)
      );
      await waitStatus(a.page, 1);
      const v1 = await forecastView(a.page);
      if (v1.pace !== "$1.00/day")
        errors.push(
          "clear: a row after a clear has pace " + v1.pace + " (want $1.00/day, span ~0)"
        );
      errors.push(...a.errors.map((e) => "clear: " + e));
    } finally {
      await a.page.close();
    }

    const hist = {
      ts: "2025-12-31T10:00:00.000Z",
      sessionId: "hist-1",
      agentId: "hist-helper",
      parentId: "hist-lead",
      name: "helper",
      model: "opus",
      type: "turn",
      inputTokens: 5000,
      outputTokens: 500,
      files: []
    };
    const b = await openLiveHarness(browser, port, [hist]);
    try {
      await b.page.evaluate((r) => window.__insightsHandle.addLiveRow(r), dollarRow(T0));
      await waitStatus(b.page, 2);
      await b.page.selectOption(".insights-session", "live-session");
      const picker = () =>
        b.page.evaluate(() => ({
          value: document.querySelector(".insights-session").value,
          options: Array.from(document.querySelectorAll(".insights-session option")).map(
            (o) => o.value
          ),
          notes: ["suggestions", "whatif"].filter((p) =>
            document.querySelector('[data-panel="' + p + '"] [data-live-unavailable]')
          )
        }));
      const before = await picker();
      if (before.value !== "live-session" || before.notes.join() !== "suggestions,whatif")
        errors.push(
          "clear: setup, the live session is not picked with its note: " + JSON.stringify(before)
        );
      await b.page.evaluate(() => window.__insightsHandle.clearLiveRows());
      await waitStatus(b.page, 1);
      const sel = await picker();
      if (sel.value !== "hist-1" || sel.options.includes("live-session"))
        errors.push("clear: the picked live session did not revert: " + JSON.stringify(sel));
      if (sel.notes.length)
        errors.push("clear: the live note is still shown after the clear: " + sel.notes.join());
      errors.push(...b.errors.map((e) => "clear (picker): " + e));
    } finally {
      await b.page.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return errors;
}

async function main() {
  const all = assertFixtureOnDisk().map((e) => "[fixture] " + e);
  if (all.length) {
    console.error("Insights smoke failed:\n- " + all.join("\n- "));
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    all.push(...(await smokeFile(browser)).map((e) => "[demo file] " + e));
    all.push(...(await smokeHttp(browser)).map((e) => "[demo http] " + e));
    all.push(...(await smokeEmptySuggestions(browser)).map((e) => "[empty http] " + e));
    all.push(...(await smokeLiveRows(browser)).map((e) => "[live rows] " + e));
    all.push(...(await smokeLiveRowPricing(browser)).map((e) => "[live pricing] " + e));
    all.push(...(await smokeLiveRowDebounce(browser)).map((e) => "[live debounce] " + e));
    all.push(...(await smokeLiveRowClear(browser)).map((e) => "[live clear] " + e));
  } finally {
    await browser.close();
  }

  if (all.length) {
    console.error("Insights smoke failed:\n- " + all.join("\n- "));
    process.exit(1);
  }
  console.log("Insights smoke OK · Demo forecast/suggestions/replay/what-if");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
