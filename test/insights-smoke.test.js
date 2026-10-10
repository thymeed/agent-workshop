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

  /* Suggestions. ranked by savings, jump event, honesty hint */
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
}

async function smokeFile(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);
  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await assertInsightsUi(page, "file://", errors);
  await page.close();
  /* file:// fixture fetch may fail; inlined demo fallback is OK. ignore those */
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
