/**
 * Demo + Live smoke tests.
 * - file:// Demo: Play must change UI (cost / log), no console errors
 * - http://127.0.0.1 (Electron path): Auto-Live, assets load, no console errors
 */
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const { startBridgeForSmoke, stopBridgeForSmoke } = require("./bridge-smoke-harness.js");
const { attachErrorCollectors } = require("./smoke-http-collectors.js");

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const FILE_URL = pathToFileURL(HTML).href;

async function smokeDemoFile(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests, finalizeErrors } = attachErrorCollectors(page);

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

  // file:// Live should explain the default bridge URL (always :3847 from client BRIDGE)
  await page.click("#modeLive");
  await page.waitForFunction(
    () => {
      const hint = document.getElementById("liveHint");
      const text = (hint && hint.textContent) || "";
      return (
        hint &&
        !hint.hidden &&
        /Live needs the bridge/i.test(text) &&
        /http:\/\/127\.0\.0\.1:3847\/?/i.test(text)
      );
    },
    { timeout: 4000 }
  );

  finalizeErrors();
  await page.close();

  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

async function smokeLiveHttp(browser) {
  const { port } = await startBridgeForSmoke();
  const page = await browser.newPage();
  const { errors, failedRequests, finalizeErrors } = attachErrorCollectors(page);

  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.waitForSelector("#workshop", { timeout: 5000 });
    await page.waitForSelector("#modeLive.on", { timeout: 5000 });

    // Must reach a real connected state (not "Connecting…") so a 403/offline fails the test
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("demoBtn");
        const hint = document.getElementById("liveHint");
        const hintText = ((hint && hint.textContent) || "").trim();
        if (/Connecting/i.test(hintText)) return false;
        const connectedBtn =
          btn &&
          btn.classList.contains("live-connected") &&
          /Connected/i.test(btn.textContent || "");
        const streamingHint = /^Streaming\b/i.test(hintText);
        return !!(connectedBtn || streamingHint);
      },
      { timeout: 10000 }
    );

    const cssOk = await page.evaluate(() => {
      const link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
      return !!(link && link.sheet);
    });
    if (!cssOk) errors.push("Live http:// styles.css did not load");

    await page.click("#modeDemo");
    await page.waitForSelector("#modeDemo.on", { timeout: 5000 });
    const insightsDemoOk = await page
      .waitForFunction(
        () => {
          const pill = document.querySelector(".insights-mode-pill");
          const status = document.querySelector(".insights-status");
          const session = document.querySelector(".insights-session");
          if (!pill || !status || !session) return false;
          const pillText = (pill.textContent || "").trim();
          const statusText = (status.textContent || "").trim();
          const sessionText = (session.options[session.selectedIndex] || {}).text || "";
          const demoPill = /^Demo$/i.test(pillText);
          const demoStatus = /^Demo ·/i.test(statusText);
          const eventMatch = /(\d+)\s+events/i.exec(statusText);
          const eventCount = eventMatch ? Number(eventMatch[1]) : 0;
          const liveEmpty =
            /^Live ·/i.test(statusText) && /No sessions/i.test(sessionText || statusText);
          return demoPill && demoStatus && eventCount > 0 && !liveEmpty;
        },
        { timeout: 12000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!insightsDemoOk) {
      errors.push(
        "Insights must follow Demo toggle on localhost (demo pill, demo events, not LIVE · No sessions)"
      );
    }

    await page.click("#modeLive");
    await page.waitForSelector("#modeLive.on", { timeout: 5000 });

    const acao = await page.evaluate(async () => {
      const r = await fetch("/api/status");
      return r.headers.get("access-control-allow-origin");
    });
    if (acao != null) errors.push("unexpected ACAO on /api/status: " + acao);

    // Project picker must POST /api/select with X-Cursor-Bridge (browser path).
    // Fulfill locally so an unknown id does not emit a console 400.
    let selectSettled = false;
    let resolveSelect;
    let rejectSelect;
    const selectHit = new Promise((resolve, reject) => {
      resolveSelect = (value) => {
        if (selectSettled) return;
        selectSettled = true;
        resolve(value);
      };
      rejectSelect = (err) => {
        if (selectSettled) return;
        selectSettled = true;
        reject(err);
      };
    });
    const selectTimer = setTimeout(
      () => rejectSelect(new Error("timed out waiting for /api/select")),
      5000
    );
    let projectsReload = null;
    let selectRouteHit = false;
    try {
      await page.route("**/api/select*", async (route) => {
        const req = route.request();
        selectRouteHit = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            ok: true,
            projectId: "smoke-select-probe",
            projectLabel: "smoke-select-probe",
            transcripts: "/tmp/smoke-select-probe"
          })
        });
        resolveSelect(req);
      });
      // Register before change: only match projects reload after mocked select was hit
      // (ignore a slow initial /api/projects from the first Live connect).
      projectsReload = page.waitForResponse(
        (res) => {
          if (!selectRouteHit) return false;
          try {
            const u = new URL(res.url());
            return u.pathname === "/api/projects" && res.request().method() === "GET";
          } catch (_) {
            return false;
          }
        },
        { timeout: 10000 }
      );
      await page.evaluate(() => {
        const sel = document.getElementById("projectPicker");
        if (!sel) throw new Error("projectPicker missing");
        sel.hidden = false;
        sel.disabled = false;
        const opt = document.createElement("option");
        opt.value = "smoke-select-probe";
        opt.textContent = "smoke-select-probe";
        sel.appendChild(opt);
        sel.value = "smoke-select-probe";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const selectReq = await selectHit;
      if (selectReq.method() !== "POST") {
        errors.push("project picker /api/select method expected POST, got " + selectReq.method());
      }
      const hdr = selectReq.headers()["x-cursor-bridge"];
      if (hdr !== "1") {
        errors.push("project picker POST /api/select missing X-Cursor-Bridge: 1 (got " + hdr + ")");
      }
      const post = selectReq.postData() || "";
      if (!/"id"\s*:\s*"smoke-select-probe"/.test(post)) {
        errors.push("project picker POST body missing id smoke-select-probe: " + post);
      }

      try {
        const projectsRes = await projectsReload;
        await projectsRes.finished();
        try {
          await page.waitForFunction(
            () => {
              const btn = document.getElementById("demoBtn");
              const hint = document.getElementById("liveHint");
              const hintText = ((hint && hint.textContent) || "").trim();
              if (/Connecting/i.test(hintText)) return false;
              const connectedBtn =
                btn &&
                btn.classList.contains("live-connected") &&
                /Connected/i.test(btn.textContent || "");
              const streamingHint = /^Streaming\b/i.test(hintText);
              return !!(connectedBtn || streamingHint);
            },
            { timeout: 10000 }
          );
        } catch (streamErr) {
          errors.push(
            "Live reconnect after select did not reach Connected/Streaming: " +
              (streamErr && streamErr.message ? streamErr.message : streamErr)
          );
        }
      } catch (reconnectErr) {
        errors.push(
          "Live reconnect after select timed out waiting for /api/projects: " +
            (reconnectErr && reconnectErr.message ? reconnectErr.message : reconnectErr)
        );
      }
    } catch (err) {
      if (projectsReload) projectsReload.catch(() => {});
      errors.push(
        "project picker /api/select probe failed: " + (err && err.message ? err.message : err)
      );
    } finally {
      clearTimeout(selectTimer);
      await page.unroute("**/api/select*").catch(() => {});
    }
  } finally {
    finalizeErrors();
    await page.close();
    await stopBridgeForSmoke();
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
  console.log(
    "Smoke OK · Demo Play; Live Connected; project picker POSTs /api/select with X-Cursor-Bridge"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
