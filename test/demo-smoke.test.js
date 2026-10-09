/**
 * Lightweight Demo-mode smoke test.
 * Loads the dashboard via file:// (stays in Demo; no Live auto-switch),
 * asserts the workshop mounts, Play starts without page/console errors.
 */
"use strict";

const path = require("path");
const { chromium } = require("playwright");

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const FILE_URL = "file://" + HTML;

async function main() {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on("pageerror", (err) => {
    errors.push("pageerror: " + (err && err.message ? err.message : String(err)));
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push("console: " + msg.text());
    }
  });

  const failedRequests = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(req.url() + " · " + (req.failure() && req.failure().errorText));
  });

  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });

  await page.waitForSelector("#workshop", { timeout: 5000 });
  await page.waitForSelector("#modeDemo.on", { timeout: 5000 });
  await page.waitForSelector("#demoBtn", { timeout: 5000 });

  const title = await page.title();
  if (!/Model Routing/i.test(title)) {
    errors.push("unexpected title: " + title);
  }

  // CSS + JS must resolve under file://
  const cssOk = await page.evaluate(() => {
    const link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!link || !link.sheet) return false;
    try {
      return link.sheet.cssRules.length > 0;
    } catch (_) {
      // Some browsers restrict cssRules on file://; presence of sheet is enough
      return !!link.sheet;
    }
  });
  if (!cssOk) errors.push("styles.css did not load");

  await page.click("#demoBtn");
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("demoBtn");
      return btn && (btn.classList.contains("playing") || btn.textContent === "Stop");
    },
    { timeout: 3000 }
  );

  // Let a couple of demo steps run
  await page.waitForTimeout(2200);

  const hud = await page.textContent("#hudSessionCost");
  if (!hud || !/^\$/.test(hud.trim())) {
    errors.push("hud session cost missing after Play: " + hud);
  }

  await browser.close();

  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }

  if (errors.length) {
    console.error("Demo smoke failed:\n- " + errors.join("\n- "));
    process.exit(1);
  }

  console.log("Demo smoke OK · file:// Dashboard loaded, Play started, no console errors");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
