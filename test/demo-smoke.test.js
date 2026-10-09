/**
 * Demo + Live smoke tests.
 * - file:// Demo: Play must change UI (cost / log), no console errors
 * - http://127.0.0.1 (Electron path): Auto-Live, assets load, no console errors
 */
"use strict";

const path = require("path");
const net = require("net");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const { startBridge, stopBridge } = require("../live-bridge.js");

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const FILE_URL = pathToFileURL(HTML).href;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

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

async function smokeDemoFile(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);

  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector("#workshop", { timeout: 5000 });
  await page.waitForSelector("#modeDemo.on", { timeout: 5000 });

  const title = await page.title();
  if (!/Model Routing/i.test(title)) errors.push("unexpected title: " + title);

  const cssOk = await page.evaluate(() => {
    const link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!link || !link.sheet) return false;
    try {
      return link.sheet.cssRules.length > 0;
    } catch (_) {
      return !!link.sheet;
    }
  });
  if (!cssOk) errors.push("styles.css did not load");

  const costBefore = (await page.textContent("#hudSessionCost")) || "";

  await page.click("#demoBtn");
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("demoBtn");
      return btn && (btn.classList.contains("playing") || btn.textContent === "Stop");
    },
    { timeout: 3000 }
  );

  // Wait until Demo play actually advances the bill / log (not the idle $0.00)
  await page.waitForFunction(
    (before) => {
      const cost = document.getElementById("hudSessionCost");
      const text = cost && cost.textContent ? cost.textContent.trim() : "";
      const logs = document.querySelectorAll("#sessionLog .log-line").length;
      return (text && text !== "$0.00" && text !== before.trim()) || logs > 0;
    },
    costBefore,
    { timeout: 10000 }
  );

  const costAfter = ((await page.textContent("#hudSessionCost")) || "").trim();
  const logCount = await page.locator("#sessionLog .log-line").count();
  if (costAfter === "$0.00" && logCount === 0) {
    errors.push("Demo Play did not change session cost or log");
  }

  // file:// Live should explain bridge URL (not pretend the bridge is offline)
  await page.click("#modeLive");
  await page.waitForFunction(
    () => {
      const hint = document.getElementById("liveHint");
      return (
        hint && !hint.hidden && /open http:\/\/127\.0\.0\.1:3847/i.test(hint.textContent || "")
      );
    },
    { timeout: 4000 }
  );

  await page.close();

  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

async function smokeLiveHttp(browser) {
  const port = await getFreePort();
  await startBridge({ port, quiet: true });
  const page = await browser.newPage();
  const { errors, failedRequests } = attachErrorCollectors(page);

  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.waitForSelector("#workshop", { timeout: 5000 });
    await page.waitForSelector("#modeLive.on", { timeout: 5000 });

    await page.waitForFunction(
      () => {
        const btn = document.getElementById("demoBtn");
        const hint = document.getElementById("liveHint");
        return (
          (btn && btn.classList.contains("live-connected")) ||
          (hint && /Streaming|Connecting|Switched/i.test(hint.textContent || ""))
        );
      },
      { timeout: 8000 }
    );

    const cssOk = await page.evaluate(() => {
      const link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
      return !!(link && link.sheet);
    });
    if (!cssOk) errors.push("Live http:// styles.css did not load");

    const acao = await page.evaluate(async () => {
      const r = await fetch("/api/status");
      return r.headers.get("access-control-allow-origin");
    });
    if (acao != null) errors.push("unexpected ACAO on /api/status: " + acao);
  } finally {
    await page.close();
    await stopBridge();
  }

  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const all = [];
  try {
    all.push(...(await smokeDemoFile(browser)).map((e) => "[demo file] " + e));
    all.push(...(await smokeLiveHttp(browser)).map((e) => "[live http] " + e));
  } finally {
    await browser.close();
  }

  if (all.length) {
    console.error("Smoke failed:\n- " + all.join("\n- "));
    process.exit(1);
  }
  console.log("Smoke OK · file:// Demo Play advanced UI; Live http://127.0.0.1 path connected");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
