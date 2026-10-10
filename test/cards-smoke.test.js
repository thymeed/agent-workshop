/**
 * Cards module smoke — file:// Demo fixtures, avatars, privacy meter, daily stats.
 * Does not modify demo-smoke.test.js (owned elsewhere).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const { pushEvent } = require("../live-bridge.js");
const { startBridgeForSmoke, stopBridgeForSmoke } = require("./bridge-smoke-harness.js");
const { attachErrorCollectors } = require("./smoke-http-collectors.js");

async function assertHermeticTranscripts(page, transcriptsDir) {
  const status = await page.evaluate(async () => {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  });
  if (!status.ok) {
    return ["live smoke expected GET /api/status 200, got " + (status.status || "?")];
  }
  const reported = status.body && status.body.transcripts;
  if (reported !== transcriptsDir) {
    return [
      "bridge transcripts dir must be smoke temp dir (got " +
        reported +
        ", expected " +
        transcriptsDir +
        ")"
    ];
  }
  const entries = await fs.promises.readdir(transcriptsDir).catch(() => null);
  if (!entries || entries.length !== 0) {
    return ["smoke transcripts dir must start empty"];
  }
  return [];
}

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const CARDS_CSS = path.resolve(__dirname, "..", "dashboard", "cards.css");
const FILE_URL = pathToFileURL(HTML).href;

async function smokeBrokenCardsAssetFails(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests, finalizeErrors } = attachErrorCollectors(page);
  await page.route("**/dashboard/cards.css", (route) => route.abort("failed"));
  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(400);
  finalizeErrors();
  await page.close();
  const sawCards =
    failedRequests.some((line) => /cards\.css/i.test(line)) ||
    errors.some((line) => /cards\.css|Failed to load resource/i.test(line));
  if (!sawCards) {
    return ["broken cards.css should surface in failedRequests or console errors"];
  }
  if (errors.length === 0 && failedRequests.length === 0) {
    return ["broken cards.css should fail the smoke collector"];
  }
  return [];
}

async function smokeDisallowedApiErrorFails(browser) {
  const { port } = await startBridgeForSmoke();
  const page = await browser.newPage();
  const { errors, finalizeErrors } = attachErrorCollectors(page);
  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.evaluate(() => fetch("/api/smoke-must-not-exist").catch(() => {}));
    await page.waitForTimeout(400);
    finalizeErrors();
  } finally {
    await page.close();
    await stopBridgeForSmoke();
  }
  if (!errors.some((e) => /api error:|\/api\/smoke-must-not-exist/i.test(e))) {
    return ["unexpected /api/* errors should fail the smoke collector"];
  }
  return [];
}

async function smokeLiveReconnectDedupe(browser) {
  const { port, transcriptsDir } = await startBridgeForSmoke();
  const page = await browser.newPage();
  const errors = [];
  const FIXTURE_MSG = "backlog fixture · session bill";
  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    errors.push(...(await assertHermeticTranscripts(page, transcriptsDir)));
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("demoBtn");
        return btn && btn.classList.contains("live-connected");
      },
      { timeout: 12000 }
    );

    pushEvent({
      role: "parent",
      message: FIXTURE_MSG,
      usage: { model: "opus", in: 5000, out: 1000 }
    });

    await page.waitForFunction(
      () => {
        const h = window.__cursorAgentsDashTest;
        if (!h) return false;
        const cost = h.getHudSessionCost();
        return cost && cost !== "$0.00" && h.getDailyStats().tokens >= 6000;
      },
      { timeout: 10000 }
    );

    const before = await page.evaluate(() => {
      const h = window.__cursorAgentsDashTest;
      return {
        daily: h.getDailyStats(),
        cost: h.getHudSessionCost(),
        logs: h.getLogLineCount()
      };
    });

    await page.click("#demoBtn");
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("demoBtn");
        return btn && btn.classList.contains("live-connected");
      },
      { timeout: 12000 }
    );

    await page.waitForFunction(
      (msg) => {
        const h = window.__cursorAgentsDashTest;
        if (!h) return false;
        const cost = h.getHudSessionCost();
        const logs = h.getLogLineCount();
        const hasFixture = Array.from(document.querySelectorAll("#sessionLog .log-line")).some(
          (el) => (el.textContent || "").indexOf(msg) !== -1
        );
        return cost && cost !== "$0.00" && logs > 0 && hasFixture;
      },
      FIXTURE_MSG,
      { timeout: 12000 }
    );

    const after = await page.evaluate(() => {
      const h = window.__cursorAgentsDashTest;
      return {
        daily: h.getDailyStats(),
        cost: h.getHudSessionCost(),
        logs: h.getLogLineCount()
      };
    });

    if (after.cost !== before.cost) {
      errors.push(
        "reconnect replay did not restore session bill: before=" +
          before.cost +
          " after=" +
          after.cost
      );
    }
    if (after.daily.tokens !== before.daily.tokens) {
      errors.push(
        "Live reconnect replay changed daily tokens: before=" +
          before.daily.tokens +
          " after=" +
          after.daily.tokens
      );
    }
    if (after.daily.runs !== before.daily.runs) {
      errors.push(
        "Live reconnect replay changed daily runs: before=" +
          before.daily.runs +
          " after=" +
          after.daily.runs
      );
    }
  } finally {
    await page.close();
    await stopBridgeForSmoke();
  }
  return errors;
}

async function smokeLiveDailyEventDedupe(browser) {
  const { port, transcriptsDir } = await startBridgeForSmoke();
  const page = await browser.newPage();
  const errors = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    errors.push(...(await assertHermeticTranscripts(page, transcriptsDir)));
    await page.waitForFunction(
      () => document.getElementById("demoBtn")?.classList.contains("live-connected"),
      { timeout: 12000 }
    );
    const dup = await page.evaluate(() => {
      const h = window.__cursorAgentsDashTest;
      if (!h) return { ok: false, reason: "missing hooks" };
      const ev = {
        id: 88001,
        role: "parent",
        message: "dedupe probe",
        usage: { model: "opus", in: 200000, out: 50000 }
      };
      h.applyLiveEvent(ev);
      const billAfterFirst = h.getHudSessionCost();
      const dailyAfterFirst = h.getDailyStats().tokens;
      h.applyLiveEvent(ev);
      return {
        ok: true,
        tokens: h.getDailyStats().tokens,
        dailyAfterFirst,
        billAfterFirst,
        billAfterSecond: h.getHudSessionCost(),
        seen: h.hasSeenLiveEvent(ev)
      };
    });
    if (!dup.ok) errors.push(dup.reason);
    if (dup.tokens !== dup.dailyAfterFirst || dup.tokens < 200000) {
      errors.push("replayed event id double-counted daily tokens: " + dup.tokens);
    }
    if (!(dup.billAfterSecond !== dup.billAfterFirst && dup.billAfterFirst !== "$0.00")) {
      errors.push("replayed event id should still refresh session bill UI");
    }
    if (!dup.seen) errors.push("dedupe did not mark event seen");
  } finally {
    await page.close();
    await stopBridgeForSmoke();
  }
  return errors;
}

async function smokeLiveReplaySkipsFastestTiming(browser) {
  const { port, transcriptsDir } = await startBridgeForSmoke();
  pushEvent({
    role: "explorer",
    message: "backlog · explore on",
    active: ["explorer"]
  });
  pushEvent({
    role: "parent",
    message: "backlog · explore off",
    active: ["opus"]
  });
  const page = await browser.newPage();
  const errors = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    errors.push(...(await assertHermeticTranscripts(page, transcriptsDir)));
    await page.waitForFunction(
      () => document.getElementById("demoBtn")?.classList.contains("live-connected"),
      { timeout: 12000 }
    );
    await page.waitForFunction(
      () =>
        window.__cursorAgentsDashTest &&
        typeof window.__cursorAgentsDashTest.isLiveBacklogReplay === "function" &&
        !window.__cursorAgentsDashTest.isLiveBacklogReplay(),
      { timeout: 5000 }
    );
    const stats = await page.evaluate(() => {
      const ac = window.AgentCards;
      if (!ac) return { ok: false, reason: "missing AgentCards" };
      const s = ac.getDailyStats();
      return {
        ok: true,
        fastestAgent: s.fastestAgent,
        fastestMs: s.fastestMs
      };
    });
    if (!stats.ok) errors.push(stats.reason);
    else if (stats.fastestAgent != null || stats.fastestMs != null) {
      errors.push(
        "SSE backlog on/off must not record fastest agent (got agent=" +
          stats.fastestAgent +
          " ms=" +
          stats.fastestMs +
          ")"
      );
    }

    pushEvent({
      role: "worker",
      message: "live · worker on",
      active: ["worker"]
    });
    await page.waitForFunction(
      () => {
        if (!window.__cursorAgentsDashTest || window.__cursorAgentsDashTest.isLiveBacklogReplay()) {
          return false;
        }
        return document.getElementById("card-worker")?.classList.contains("active");
      },
      { timeout: 15000 }
    );
    // Wait on the app's active-start clock (same Date.now used by setActive), not a
    // separate wall-clock probe — Windows timer/poll jitter made a 55ms+≥40 SLA flaky.
    const minActiveMs = process.platform === "win32" ? 200 : 150;
    await page.waitForFunction(
      (minMs) => {
        const h = window.__cursorAgentsDashTest;
        const ac = window.AgentCards;
        const getStart =
          (h && typeof h.getActiveStartMs === "function" && h.getActiveStartMs) ||
          (ac && typeof ac.getActiveStartMs === "function" && ac.getActiveStartMs);
        if (!getStart) return false;
        const start = getStart.call(h || ac, "worker");
        return start != null && Date.now() - start >= minMs;
      },
      minActiveMs,
      { timeout: 10000 }
    );
    pushEvent({
      role: "parent",
      message: "live · worker off",
      active: []
    });
    await page.waitForFunction(
      () => {
        const ac = window.AgentCards;
        if (!ac) return false;
        const s = ac.getDailyStats();
        return s.fastestAgent === "worker" && s.fastestMs != null && s.fastestMs > 0;
      },
      { timeout: 15000 }
    );
    const liveStats = await page.evaluate(() => {
      const h = window.__cursorAgentsDashTest;
      const ac = window.AgentCards;
      const s = ac.getDailyStats();
      return {
        fastestAgent: s.fastestAgent,
        fastestMs: s.fastestMs,
        daily: s,
        backlog: h && typeof h.isLiveBacklogReplay === "function" ? h.isLiveBacklogReplay() : null,
        workerActive: !!(
          document.getElementById("card-worker") &&
          document.getElementById("card-worker").classList.contains("active")
        )
      };
    });
    if (liveStats.fastestAgent !== "worker" || !(liveStats.fastestMs > 0)) {
      errors.push(
        "live on/off after backlog should set fastestAgent=worker and fastestMs>0 (got agent=" +
          liveStats.fastestAgent +
          " ms=" +
          liveStats.fastestMs +
          "); dump getDailyStats()=" +
          JSON.stringify(liveStats.daily) +
          " isLiveBacklogReplay()=" +
          liveStats.backlog +
          " #card-worker.active=" +
          liveStats.workerActive
      );
    }
  } finally {
    await page.close();
    await stopBridgeForSmoke();
  }
  return errors;
}

async function smokeDemoUsageGrandTotal(browser) {
  const page = await browser.newPage();
  const errors = [];
  try {
    await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(
      () => window.AgentCards && window.AgentCards.isReady && window.AgentCards.isReady(),
      { timeout: 8000 }
    );
    const usage = {
      opus: { in: 0, out: 0 },
      fable: { in: 0, out: 0 },
      sonnet: { in: 0, out: 0 },
      haiku: { in: 1000, out: 200 },
      explorer: { in: 400, out: 100 },
      researcher: { in: 300, out: 50 }
    };
    const result = await page.evaluate((sample) => {
      const h = window.__cursorAgentsDashTest;
      const ac = window.AgentCards;
      if (!h || !h.measureDemoUsageTokens || !h.setDemoUsageAndSyncDaily) {
        return { ok: false, reason: "missing demo usage hooks" };
      }
      const measured = h.measureDemoUsageTokens(sample);
      ac.onModeChange("live");
      ac.onModeChange("demo");
      const beforeDaily = ac.getDailyStats().tokens;
      h.setDemoUsageAndSyncDaily(sample);
      const afterDaily = ac.getDailyStats().tokens;
      return { ok: true, measured, delta: afterDaily - beforeDaily };
    }, usage);
    if (!result.ok) errors.push(result.reason);
    else if (result.measured !== 1200) {
      errors.push(
        "usageGrandTotal should exclude explorer/researcher (expected 1200, got " +
          result.measured +
          ")"
      );
    } else if (result.delta !== 1200) {
      errors.push(
        "Demo daily sync should add usageGrandTotal once (expected +1200, got +" +
          result.delta +
          ")"
      );
    }
  } finally {
    await page.close();
  }
  return errors;
}

async function smokeCardsDemo(browser) {
  const page = await browser.newPage();
  const { errors, failedRequests, finalizeErrors } = attachErrorCollectors(page);

  await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector("#card-opus", { state: "attached", timeout: 5000 });
  await page.waitForFunction(
    () => window.AgentCards && window.AgentCards.isReady && window.AgentCards.isReady(),
    { timeout: 5000 }
  );

  const assets = await page.evaluate(() => {
    const cardsJs = document.querySelector('script[src*="cards.js"]');
    const cardsCss = document.querySelector('link[href*="cards.css"]');
    const insightsJs = document.querySelector('script[src*="insights.js"]');
    const replayJs = document.querySelector('script[src*="replay-stage.js"]');
    const insightsCss = document.querySelector('link[href*="insights.css"]');
    return {
      hasAgentCards: !!(window.AgentCards && typeof window.AgentCards.init === "function"),
      cardsJs: !!(cardsJs && cardsJs.src),
      cardsCss: !!(cardsCss && cardsCss.sheet),
      insightsJsTag: !!(
        insightsJs && /dashboard\/insights\.js/i.test(insightsJs.getAttribute("src") || "")
      ),
      replayJsTag: !!(
        replayJs && /dashboard\/replay-stage\.js/i.test(replayJs.getAttribute("src") || "")
      ),
      insightsCssTag: !!(
        insightsCss && /dashboard\/insights\.css/i.test(insightsCss.getAttribute("href") || "")
      ),
      insightsGuarded:
        typeof window.Insights === "undefined" || typeof window.Insights.init === "function",
      replayStage:
        typeof window.ReplayStage === "undefined" ||
        typeof window.ReplayStage.mapHistoryEvent === "function"
    };
  });

  if (!assets.hasAgentCards) errors.push("window.AgentCards missing");
  if (!assets.cardsJs) errors.push("cards.js script tag missing");
  if (!assets.cardsCss) errors.push("cards.css did not load");
  if (!assets.insightsJsTag) errors.push("HTML missing dashboard/insights.js script tag");
  if (!assets.replayJsTag) errors.push("HTML missing dashboard/replay-stage.js script tag");
  if (!assets.insightsCssTag) errors.push("HTML missing dashboard/insights.css link tag");
  if (!assets.insightsGuarded) errors.push("Insights.init guard broken");
  if (!assets.replayStage) errors.push("ReplayStage API missing");

  const privacy = await page.evaluate(() => {
    const ac = window.AgentCards;
    const flagged = [
      ["certs/server.pem", "med"],
      ["secrets/api.key", "high"],
      ["bundle.p12", "med"],
      ["identity.pfx", "med"],
      ["home/.ssh/config", "med"],
      ["home/.aws/credentials", "high"],
      ["config/.env.local", "high"],
      ["deploy/credentials.json", "high"],
      ["keys/id_rsa", "high"],
      ["keys/id_ed25519", "high"],
      [".npmrc", "med"],
      [".netrc", "med"],
      ["C:\\Users\\x\\.ssh\\id_rsa", "high"],
      ["C:\\Users\\x\\.aws\\credentials", "high"],
      [".aws\\credentials", "high"]
    ];
    const excluded = [
      "config/.env.example",
      "config/.env.sample",
      "config/.env.template",
      "keys/id_rsa.pub",
      "keys/id_ed25519.pub",
      "src/billing/webhooks.ts"
    ];
    const failures = [];
    flagged.forEach(([p, level]) => {
      if (ac.detectPrivacyLevel(p) !== level) {
        failures.push("flag " + p + " expected " + level + " got " + ac.detectPrivacyLevel(p));
      }
    });
    excluded.forEach((p) => {
      if (ac.detectPrivacyLevel(p) !== "none") {
        failures.push("exclude " + p + " expected none got " + ac.detectPrivacyLevel(p));
      }
    });
    return { failures };
  });
  if (privacy.failures.length) {
    errors.push("privacy cases:\n  " + privacy.failures.join("\n  "));
  }

  const ui = await page.evaluate(() => {
    const avatars = document.querySelectorAll(".agent-avatar").length;
    const privacyMeters = document.querySelectorAll(".privacy-meter").length;
    const daily = document.getElementById("dailyStatsCard");
    const meters = Array.from(document.querySelectorAll(".privacy-meter"));
    const lit = meters.some((el) => /level-(low|med|high)/.test(el.className));
    const heuristicLabels = meters.every((el) => {
      const tip = el.getAttribute("data-tip") || "";
      const detail = el.getAttribute("data-tip-detail") || "";
      const title = el.getAttribute("title") || "";
      const aria = el.getAttribute("aria-label") || "";
      const corpus = [tip, detail, title, aria].join(" ");
      return (
        /heuristic/i.test(corpus) &&
        /path-based heuristic/i.test(corpus) &&
        /not ground truth/i.test(corpus) &&
        /nook/i.test(corpus)
      );
    });
    const runs = (document.getElementById("dailyRuns") || {}).textContent || "0";
    const tokens = (document.getElementById("dailyTokens") || {}).textContent || "0";
    const fastest = (document.getElementById("dailyFastest") || {}).textContent || "—";
    return {
      avatars,
      privacyMeters,
      hasDaily: !!daily,
      privacyLit: lit,
      heuristicLabels,
      runs,
      tokens,
      fastest
    };
  });

  if (ui.avatars < 5) errors.push("expected 5 agent avatars, got " + ui.avatars);
  if (ui.privacyMeters < 5) errors.push("expected 5 privacy meters, got " + ui.privacyMeters);

  const faces = await page.evaluate(() => {
    const roles = ["opus", "advisor", "worker", "explorer", "researcher"];
    const initials = document.querySelectorAll(".avatar-initials").length;
    const initialText = Array.from(document.querySelectorAll(".agent-avatar"))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);
    const perRole = roles.map((role) => {
      const el = document.querySelector('.agent-avatar[data-avatar="' + role + '"]');
      if (!el) return { role, ok: false, reason: "missing" };
      const blush = !!el.querySelector(".avatar-blush");
      const eyes = el.querySelectorAll(".avatar-eye").length;
      const mouth = !!el.querySelector(".avatar-mouth");
      const chrome = !!el.querySelector(".avatar-chrome");
      const idleAwake =
        el.classList.contains("state-idle") &&
        Array.from(el.querySelectorAll(".avatar-eye")).every((eye) => {
          const st = getComputedStyle(eye);
          const w = parseFloat(st.width);
          const h = parseFloat(st.height);
          return w >= 4 && h >= 4 && st.borderRadius !== "0px";
        });
      if (!blush) return { role, ok: false, reason: "no blush" };
      if (eyes < 2) return { role, ok: false, reason: "need 2 eye dots, got " + eyes };
      if (!mouth) return { role, ok: false, reason: "no mouth" };
      if (!chrome) return { role, ok: false, reason: "no chrome props" };
      if (!idleAwake) return { role, ok: false, reason: "idle must use open eye dots" };
      return { role, ok: true };
    });
    const faceMarkup =
      window.AgentCards && typeof window.AgentCards.faceMarkup === "function"
        ? window.AgentCards.faceMarkup("advisor", { size: "sm" })
        : "";
    return {
      initials,
      initialText,
      perRole,
      faceMarkupHasInitials: /avatar-initials|>\s*Fb\s*</.test(faceMarkup),
      faceMarkupHasEyes: /avatar-eye/.test(faceMarkup)
    };
  });
  if (faces.initials > 0) {
    errors.push("letter-circle initials must not render (found " + faces.initials + ")");
  }
  if (faces.initialText.length) {
    errors.push("avatar text content must be empty (got " + faces.initialText.join(",") + ")");
  }
  faces.perRole.forEach((r) => {
    if (!r.ok) errors.push("cute face " + r.role + ": " + r.reason);
  });
  if (faces.faceMarkupHasInitials) {
    errors.push("AgentCards.faceMarkup must not emit initials");
  }
  if (!faces.faceMarkupHasEyes) {
    errors.push("AgentCards.faceMarkup should emit avatar-eye dots");
  }
  if (!ui.hasDaily) errors.push("daily stats card missing");
  if (!ui.privacyLit) errors.push("Demo fixtures did not light any privacy meter");
  if (!ui.heuristicLabels) {
    errors.push("privacy meters missing heuristic / not-ground-truth labeling");
  }

  const tipCoverage = await page.evaluate(() => {
    const need = [
      ".agent-avatar[data-tip]",
      ".privacy-meter[data-tip]",
      ".card-name[data-tip]",
      ".card-role[data-tip]",
      ".status[data-tip]",
      ".effort[data-tip]",
      ".price[data-tip]",
      "#dailyStatsCard[data-tip]",
      ".daily-stat[data-tip]"
    ];
    const missing = need.filter((sel) => !document.querySelector(sel));
    const scout = document.querySelectorAll(".readonly-pill[data-tip]").length;
    const chips = document.querySelectorAll(".trigger-chips .chip[data-tip]").length;
    return { missing, scout, chips };
  });
  if (tipCoverage.missing.length) {
    errors.push("TipLayer gaps: " + tipCoverage.missing.join(", "));
  }
  if (tipCoverage.scout < 2) errors.push("scout pills missing data-tip");
  if (tipCoverage.chips < 3) errors.push("advisor chips missing data-tip");

  const pretty = await page.evaluate(() => {
    const h = window.AgentCards;
    if (!h || typeof h.prettyStatusText !== "function")
      return { ok: false, reason: "no prettyStatusText" };
    const worker = h.prettyStatusText(
      "working · **Commit:** 'ced9811405e4b9f01b2ee368cb3cc1fa45742696' **Message:** 'docs: note_hooks'"
    );
    const opus = h.prettyStatusText(
      "reply · Done - [Update stale comment headers](c35a2e43-1a3f-4538-8886-9c6f1fab3302) pushed"
    );
    const explorer = h.prettyStatusText("delegates · explore · Check commit and comments");
    const fails = [];
    if (/\*\*/.test(worker)) fails.push("worker still has markdown bold");
    if (/ced9811405e4b9f01b2ee368cb3cc1fa45742696/i.test(worker))
      fails.push("worker kept full SHA");
    if (!/ced9811/i.test(worker)) fails.push("worker missing short SHA");
    if (/c35a2e43-1a3f-4538-8886-9c6f1fab3302/i.test(opus)) fails.push("opus kept full UUID");
    if (/^\s*delegates/i.test(explorer)) fails.push("explorer kept delegates prefix");
    if (worker.length > 80) fails.push("worker status still too long: " + worker.length);
    return { ok: fails.length === 0, fails, worker, opus, explorer };
  });
  if (!pretty.ok) {
    errors.push(
      "prettyStatusText: " +
        ((pretty.fails && pretty.fails.join("; ")) || pretty.reason || "failed")
    );
  }
  if (ui.runs === "0") errors.push("Demo daily runs still 0");
  if (ui.tokens === "0") errors.push("Demo daily tokens still 0");
  if (!ui.fastest || ui.fastest === "—") errors.push("Demo fastest agent missing");

  const demoTokensBeforeLive = ui.tokens;

  await page.click("#modeLive");
  await page.waitForFunction(
    () => {
      const hint = document.getElementById("liveHint");
      return hint && !hint.hidden && /Live needs the bridge/i.test(hint.textContent || "");
    },
    { timeout: 4000 }
  );

  const afterLiveSwitch = await page.evaluate(() => {
    const tokens = (document.getElementById("dailyTokens") || {}).textContent || "0";
    const mode =
      window.AgentCards && window.AgentCards.getDailyMode ? window.AgentCards.getDailyMode() : "";
    return { tokens, mode };
  });
  if (afterLiveSwitch.mode !== "live") errors.push("expected daily mode live after Live click");
  if (afterLiveSwitch.tokens !== "0" && demoTokensBeforeLive !== "0") {
    errors.push(
      "Demo daily tokens carried into Live: before=" +
        demoTokensBeforeLive +
        " after=" +
        afterLiveSwitch.tokens
    );
  }

  const liveSum = await page.evaluate(() => {
    const ac = window.AgentCards;
    ac.onModeChange("live");
    ac.addTokens(100);
    ac.addTokens(50);
    var mid = ac.getDailyStats().tokens;
    ac.reset({ keepDaily: true, mode: "live" });
    var end = ac.getDailyStats().tokens;
    return { mid, end };
  });
  if (liveSum.mid !== 150 || liveSum.end !== 150) {
    errors.push(
      "Live daily tokens should sum across sessions (expected 150, got mid=" +
        liveSum.mid +
        " end=" +
        liveSum.end +
        ")"
    );
  }

  await page.click("#modeDemo");
  await page.waitForSelector("#modeDemo.on", { timeout: 3000 });

  await page.click("#demoBtn");
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("demoBtn");
      return btn && (btn.classList.contains("playing") || btn.textContent === "Stop");
    },
    { timeout: 3000 }
  );

  await page.waitForFunction(
    () => {
      const typing = document.querySelector(
        ".agent-avatar.state-typing, .agent-avatar.state-thinking"
      );
      const active = document.querySelector(".card.active");
      return !!(typing || active);
    },
    { timeout: 8000 }
  );

  const cardsCssSource = fs.readFileSync(CARDS_CSS, "utf8");
  if (!/prefers-reduced-motion:\s*reduce/.test(cardsCssSource)) {
    errors.push("cards.css missing prefers-reduced-motion rules");
  }

  const badgeLeaks = await page.evaluate(() => {
    const meters = Array.from(document.querySelectorAll(".privacy-meter"));
    return meters.some((el) => /\.env|id_rsa|credentials|secrets/i.test(el.textContent || ""));
  });
  if (badgeLeaks) errors.push("privacy meter leaked a sensitive path string");

  finalizeErrors();
  await page.close();

  if (failedRequests.length) {
    errors.push("failed requests:\n  " + failedRequests.join("\n  "));
  }
  return errors;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const all = [];
  try {
    all.push(...(await smokeCardsDemo(browser)).map((e) => "[demo file] " + e));
    all.push(...(await smokeBrokenCardsAssetFails(browser)).map((e) => "[cards 404] " + e));
    all.push(...(await smokeDisallowedApiErrorFails(browser)).map((e) => "[api error] " + e));
    all.push(...(await smokeLiveReconnectDedupe(browser)).map((e) => "[live dedupe] " + e));
    all.push(...(await smokeLiveDailyEventDedupe(browser)).map((e) => "[daily dedupe] " + e));
    all.push(
      ...(await smokeLiveReplaySkipsFastestTiming(browser)).map((e) => "[fastest replay] " + e)
    );
    all.push(...(await smokeDemoUsageGrandTotal(browser)).map((e) => "[demo usage total] " + e));
  } finally {
    await browser.close();
  }

  if (all.length) {
    console.error("Cards smoke failed:\n- " + all.join("\n- "));
    process.exit(1);
  }
  console.log(
    "Cards smoke OK · privacy, daily stats, Live dedupe, fastest replay, demo usage total, Insights guard"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
