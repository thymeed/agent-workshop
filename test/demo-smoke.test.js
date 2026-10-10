/**
 * Demo + Live smoke tests.
 * - file:// Demo: Play must change UI (cost / log), no console errors
 * - http://127.0.0.1 (Electron path): Auto-Live, assets load, no console errors
 */
"use strict";

process.env.BRIDGE_TEST = "1";

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
  await page.waitForSelector("#viewStage.on", { timeout: 5000 });

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

  const chromeOk = await page.evaluate(() => {
    const app = document.getElementById("app");
    const viewMode = app && app.getAttribute("data-view-mode");
    const stageOn = !!(
      document.getElementById("viewStage") &&
      document.getElementById("viewStage").classList.contains("on")
    );
    const insightsBtn = document.getElementById("viewInsights");
    const historyBtn = document.getElementById("viewHistory");
    const noMount = !document.getElementById("insightsMount");
    const insightsInDrawers = !!document.querySelector("#drawers #drawerInsights");
    const historyInDrawers = !!document.querySelector("#drawers #drawerHistory");
    const hud = document.getElementById("hudSessionCost");
    const syncAge = document.getElementById("hudSyncAge");
    const billIllustrative = (
      (document.getElementById("billIllustrative") || {}).textContent || ""
    ).trim();
    const estimatesOk = /Estimates\s*·\s*not official invoices/i.test(billIllustrative);
    const noFooterCost = !document.getElementById("footerSessionCost");
    const noFooterSubs = !document.getElementById("footerSubs");
    return (
      viewMode === "stage" &&
      stageOn &&
      !!insightsBtn &&
      !!historyBtn &&
      noMount &&
      insightsInDrawers &&
      historyInDrawers &&
      !!hud &&
      !!syncAge &&
      estimatesOk &&
      noFooterCost &&
      noFooterSubs
    );
  });
  if (!chromeOk) {
    errors.push(
      "chrome unify missing: Stage|Insights|History modes, drawers host Insights/History, HUD-only session/subs, sync-age chip, Estimates disclaimer"
    );
  }

  const syncAgeDemo = await page.evaluate(() => {
    const el = document.getElementById("hudSyncAge");
    const t = window.__cursorAgentsDashTest;
    const age = t && typeof t.formatSyncAge === "function" ? t.formatSyncAge(null) : null;
    const just =
      t && typeof t.formatSyncAge === "function" ? t.formatSyncAge(new Date().toISOString()) : null;
    return {
      text: el ? el.textContent.trim() : "",
      nullAge: age,
      justNow: just,
      disclaimer: t && t.estimatesDisclaimer
    };
  });
  if (syncAgeDemo.text !== "n/a") {
    errors.push("Demo sync-age chip expected n/a, got " + JSON.stringify(syncAgeDemo.text));
  }
  if (syncAgeDemo.nullAge !== "n/a") {
    errors.push("formatSyncAge(null) expected n/a");
  }
  if (!/just now|0s ago/i.test(String(syncAgeDemo.justNow || ""))) {
    errors.push("formatSyncAge(now) expected just now / 0s ago, got " + syncAgeDemo.justNow);
  }
  if (!/Estimates\s*·\s*not official invoices/i.test(String(syncAgeDemo.disclaimer || ""))) {
    errors.push("estimatesDisclaimer trust wording missing");
  }

  await page.click("#viewHistory");
  await page.waitForSelector("#historyReplayHost [data-transport]", { timeout: 5000 });
  const historyReplayUiOk = await page.evaluate(() => {
    const app = document.getElementById("app");
    if (!app || app.getAttribute("data-view-mode") !== "history") return false;
    const host = document.getElementById("historyReplayHost");
    const historyDrawer = document.querySelector('.drawer[data-panel="history"]');
    const stationsDrawer = document.querySelector('.drawer[data-panel="stations"]');
    if (!host || !historyDrawer || !historyDrawer.open) return false;
    if (!host.querySelector("[data-transport]") || !host.querySelector("[data-scrubber]")) {
      return false;
    }
    const playBtn = host.querySelector(".insights-transport-btn");
    if (!playBtn || playBtn.offsetParent === null) return false;
    const ink = getComputedStyle(host).getPropertyValue("--insights-ink").trim();
    if (ink !== "#f2f6f4") return false;
    const btnBg = playBtn ? getComputedStyle(playBtn).backgroundColor : "";
    if (!btnBg || btnBg === "rgba(0, 0, 0, 0)") return false;
    if (!stationsDrawer) return true;
    return historyDrawer.getBoundingClientRect().top <= stationsDrawer.getBoundingClientRect().top;
  });
  if (!historyReplayUiOk) {
    errors.push(
      "History view: replay host missing transport/scrubber/play, insights tokens, or History drawer not focused above Stations"
    );
  }

  const stageBlocksOk = await page.evaluate(() => {
    const roles = ["opus", "advisor", "worker", "explorer", "researcher"];
    return roles.every((role) => {
      const g = document.getElementById("char-" + role);
      return (
        g &&
        g.querySelector(".block-agent-fill") &&
        g.querySelectorAll(".block-agent-eye").length >= 2
      );
    });
  });
  if (!stageBlocksOk) errors.push("stage chars missing pixel-cast block geometry");

  const replaySeekOk = await page.evaluate(() => {
    const t = window.__cursorAgentsDashTest;
    if (!t || typeof t.replaySeek !== "function" || !window.ReplayStage) return false;
    const events = [
      {
        ts: "2026-10-09T14:00:00.000Z",
        sessionId: "smoke",
        agentId: "agent-parent",
        parentId: null,
        name: "Parent",
        model: "opus",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      },
      {
        ts: "2026-10-09T14:00:05.000Z",
        sessionId: "smoke",
        agentId: "agent-worker",
        parentId: "agent-parent",
        name: "Worker",
        model: "sonnet",
        type: "spawn",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      }
    ];
    t.setViewMode("history");
    t.replaySeek(events, 1);
    const hud = ((document.getElementById("hudActiveRole") || {}).textContent || "").trim();
    const active = t.isReplaySessionActive && t.isReplaySessionActive();
    t.setViewMode("stage");
    return active && /Sonnet/i.test(hud);
  });
  if (!replaySeekOk) errors.push("replaySeek did not drive stage HUD active role");

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

    const liveHistorySessionOk = await page.evaluate(() => {
      const t = window.__cursorAgentsDashTest;
      if (
        !t ||
        typeof t.replaySeek !== "function" ||
        typeof t.applyLiveEvent !== "function" ||
        typeof t.isReplaySessionActive !== "function"
      ) {
        return false;
      }
      const events = [
        {
          ts: "2026-10-09T14:00:00.000Z",
          sessionId: "smoke-live-session",
          agentId: "agent-parent",
          parentId: null,
          name: "Parent",
          model: "opus",
          type: "spawn",
          role: "parent",
          message: "replay frame",
          inputTokens: 0,
          outputTokens: 0,
          files: []
        }
      ];
      t.setViewMode("history");
      t.replaySeek(events, 0, "session");
      if (t.isReplaySessionActive()) return false;
      const logsBefore = t.getLogLineCount();
      t.applyLiveEvent({
        ts: "2026-10-09T14:01:00.000Z",
        sessionId: "smoke-live-session",
        agentId: "agent-parent",
        name: "Parent",
        model: "opus",
        type: "message",
        role: "parent",
        message: "live after history session load",
        inputTokens: 0,
        outputTokens: 0,
        files: []
      });
      if (t.getLogLineCount() <= logsBefore) return false;
      t.replaySeek(events, 0, "scrub");
      return t.isReplaySessionActive();
    });
    if (!liveHistorySessionOk) {
      errors.push(
        "Live History session load must not block applyLiveEvent; scrub must arm replay session"
      );
    }

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
            transcripts: "/tmp/smoke-select-probe",
            latestSessionId: "smoke-latest-session"
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
        await page.waitForFunction(
          () => document.getElementById("app")?.getAttribute("data-view-mode") === "history",
          { timeout: 5000 }
        );
      } catch (historyModeErr) {
        errors.push(
          "project picker should switch to History view: " +
            (historyModeErr && historyModeErr.message ? historyModeErr.message : historyModeErr)
        );
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
