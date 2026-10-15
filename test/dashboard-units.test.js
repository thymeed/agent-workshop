/**
 * Dashboard unit layer: pure formatters and the pixel-cast avatar/brand invariants,
 * exercised directly against the module exports in a real page context.
 * Demo via file://, so no bridge is required.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const FILE_URL = pathToFileURL(HTML).href;

function assertFace(role, face) {
  assert.ok(face.hasRole, `${role}: faceMarkup must carry data-avatar="${role}"`);
  assert.ok(face.idle, `${role}: default faceMarkup must be state-idle`);
  assert.strictEqual(face.eyes, 2, `${role}: avatar must have exactly two square eyes`);
  assert.ok(!face.letters, `${role}: avatar must not use letter initials`);
  assert.ok(face.sm, `${role}: size sm must add avatar-sm`);
  assert.strictEqual(face.smRects, 3, `${role}: compact avatar must be fill + two eyes only`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(
      () => globalThis.__cursorAgentsDashTest && window.AgentCards && window.ReplayStage,
      null,
      { timeout: 20000 }
    );

    const data = await page.evaluate(() => {
      const T = globalThis.__cursorAgentsDashTest;
      const AC = window.AgentCards;
      const RS = window.ReplayStage;
      const rects = (s) => s.split("<rect").length - 1;

      const faces = {};
      for (const role of AC.ROLE_KEYS) {
        const markup = AC.faceMarkup(role);
        faces[role] = {
          hasRole: markup.includes('data-avatar="' + role + '"'),
          idle: markup.includes("state-idle"),
          eyes: markup.split("block-agent-eye").length - 1,
          letters: /<text/.test(markup),
          sm: AC.faceMarkup(role, { size: "sm" }).includes("avatar-sm"),
          smRects: rects(AC.faceMarkup(role, { size: "sm" }))
        };
      }

      return {
        syncAge: {
          empty: T.formatSyncAge(null),
          junk: T.formatSyncAge("not-a-date"),
          now: T.formatSyncAge(new Date().toISOString()),
          fiveSec: T.formatSyncAge(new Date(Date.now() - 5000).toISOString()),
          ninetySec: T.formatSyncAge(new Date(Date.now() - 90000).toISOString()),
          threeHour: T.formatSyncAge(new Date(Date.now() - 3 * 3600 * 1000).toISOString())
        },
        svg: {
          compact: rects(AC.blockAgentSvgInner({ compact: true })),
          plain: rects(AC.blockAgentSvgInner({})),
          limbs: rects(AC.blockAgentSvgInner({ limbs: true }))
        },
        faces,
        roleKeys: AC.ROLE_KEYS.slice(),
        unknownRole: AC.faceMarkup("not-a-role").includes('data-avatar="opus"'),
        hints: {
          advisor: AC.roleFromAgentHint("Advisor"),
          fable: AC.roleFromAgentHint({ model: "fable" }),
          worker: AC.roleFromAgentHint("Worker"),
          sonnet: AC.roleFromAgentHint({ model: "sonnet" }),
          researcher: AC.roleFromAgentHint("researcher"),
          explorer: AC.roleFromAgentHint("explore"),
          parent: AC.roleFromAgentHint("parent"),
          unknown: AC.roleFromAgentHint("something-else"),
          absent: AC.roleFromAgentHint(null)
        },
        invariants: {
          usageTotal: T.demoUsageTokenTotal(),
          disclaimer: typeof T.estimatesDisclaimer === "string" && T.estimatesDisclaimer.length > 0,
          snoozeKey: typeof T.snoozeKey === "string" && T.snoozeKey.length > 0,
          mapHistoryEvent: typeof RS.mapHistoryEvent === "function"
        },
        reconnect: (() => {
          const delays = [0, 1, 2, 3, 4, 5, 6, 10].map((n) => T.reconnectDelayMs(n));
          const state = T.reconnectState();
          T.scheduleLiveReconnect();
          return { delays, state, afterCallFromFileOrigin: T.reconnectState() };
        })(),
        focusFlow: (() => {
          const T = globalThis.__cursorAgentsDashTest;
          const out = {};
          const historyBtn = document.getElementById("viewHistory");
          const drawer = document.getElementById("drawerHistory");

          historyBtn.focus();
          historyBtn.click();
          out.viewMode = T.getViewMode();
          out.drawerOpen = !!drawer.open;
          /* Opening a non-modal sheet must NOT steal focus from its toggle.
             (focus() first: a synthetic .click() does not focus the button itself) */
          out.focusStayedOnToggle = document.activeElement === historyBtn;

          /* Now put focus inside the sheet, then switch away: focus must be reclaimed. */
          const summary = drawer.querySelector("summary");
          if (summary) summary.focus();
          out.focusInsideSheet = drawer.contains(document.activeElement);
          document.getElementById("viewStage").click();
          out.restoredToViewControl = !!(
            document.activeElement && document.activeElement.closest("#viewMode")
          );
          out.stageMode = T.getViewMode();
          out.historyDrawerClosed = !drawer.open;
          return out;
        })(),
        a11y: (() => {
          const chars = ["opus", "advisor", "worker", "explorer", "researcher"].map((r) => {
            const el = document.getElementById("char-" + r);
            return el
              ? {
                  role: el.getAttribute("role"),
                  tab: el.getAttribute("tabindex"),
                  label: !!el.getAttribute("aria-label")
                }
              : null;
          });
          const portal = document.getElementById("mergePortal");
          const banner = document.getElementById("livePresenceBanner");
          const log = document.getElementById("sessionLog");
          return {
            chars,
            portal: portal
              ? { role: portal.getAttribute("role"), tab: portal.getAttribute("tabindex") }
              : null,
            bannerLive: banner ? banner.getAttribute("aria-live") : null,
            logLive: log ? log.getAttribute("aria-live") : null,
            viewControls: ["viewStage", "viewInsights", "viewHistory"].map((id) => {
              const el = document.getElementById(id);
              return el
                ? { id, controls: el.getAttribute("aria-controls") }
                : { id, controls: null };
            }),
            volume: (() => {
              const el = document.getElementById("soundVolume");
              return el ? { label: !!el.getAttribute("aria-label"), type: el.type } : null;
            })()
          };
        })(),
        exportSummary: (() => {
          const s = T.buildSessionSummary();
          return {
            keys: Object.keys(s),
            modelNames: s.models.map((m) => m.model),
            totalsFinite:
              Number.isFinite(s.totals.estimatedCostUsd) &&
              Number.isFinite(s.totals.inputTokens) &&
              Number.isFinite(s.totals.outputTokens),
            everyCostFinite: s.models.every((m) => Number.isFinite(m.estimatedCostUsd)),
            csv: T.summaryToCsv(s),
            disclaimer: s.disclaimer
          };
        })()
      };
    });

    assert.strictEqual(data.syncAge.empty, "n/a", "formatSyncAge(null) must be n/a");
    assert.strictEqual(data.syncAge.junk, "n/a", "formatSyncAge(junk) must be n/a");
    assert.strictEqual(data.syncAge.now, "just now", "fresh timestamp must read just now");
    assert.strictEqual(data.syncAge.fiveSec, "5s ago", "5s must format in seconds");
    assert.strictEqual(data.syncAge.ninetySec, "1m ago", "90s must format in minutes");
    assert.strictEqual(data.syncAge.threeHour, "3h ago", "3h must format in hours");

    assert.strictEqual(data.svg.compact, 3, "compact avatar is fill plus two eyes");
    assert.strictEqual(data.svg.plain, 7, "default avatar adds four legs");
    assert.strictEqual(data.svg.limbs, 9, "limbs add two arms on top of legs");

    assert.deepStrictEqual(
      data.roleKeys,
      ["opus", "advisor", "worker", "explorer", "researcher"],
      "the five stage roles are pinned; a role dropped from this list must fail"
    );
    for (const role of Object.keys(data.faces)) assertFace(role, data.faces[role]);
    assert.ok(data.unknownRole, "unknown role must fall back to the opus face");

    assert.strictEqual(data.hints.advisor, "advisor");
    assert.strictEqual(data.hints.fable, "advisor");
    assert.strictEqual(data.hints.worker, "worker");
    assert.strictEqual(data.hints.sonnet, "worker");
    assert.strictEqual(data.hints.researcher, "researcher");
    assert.strictEqual(data.hints.explorer, "explorer");
    assert.strictEqual(data.hints.parent, "opus");
    assert.strictEqual(data.hints.unknown, "", "unmapped hint must return empty");
    assert.strictEqual(data.hints.absent, "", "absent hint must return empty");

    assert.ok(
      Number.isFinite(data.invariants.usageTotal) && data.invariants.usageTotal >= 0,
      "demo usage total must be a finite non-negative number"
    );
    assert.ok(data.invariants.disclaimer, "estimates disclaimer must be present");
    assert.ok(data.invariants.snoozeKey, "snooze storage key must be present");
    assert.ok(data.invariants.mapHistoryEvent, "ReplayStage.mapHistoryEvent must be exported");

    /* SSE auto-reconnect policy: doubling backoff, hard cap, bounded attempts. */
    assert.deepStrictEqual(
      data.reconnect.delays.slice(0, 6),
      [1000, 2000, 4000, 8000, 16000, 30000],
      "reconnect backoff must double from 1s and cap at 30s"
    );
    assert.strictEqual(
      data.reconnect.delays[6],
      30000,
      "backoff must stay capped past the max, not keep growing"
    );
    assert.ok(
      data.reconnect.state.max > 0 && data.reconnect.state.max <= 10,
      "reconnect must be bounded by a small max attempt count"
    );
    assert.strictEqual(data.reconnect.state.attempts, 0, "no reconnect attempts before a drop");
    /* file:// must never schedule a retry: the bridge rejects Origin "null" by design,
       so a retry loop there is pure noise. */
    assert.deepStrictEqual(
      data.reconnect.afterCallFromFileOrigin,
      { attempts: 0, max: 6, pending: false },
      "scheduleLiveReconnect must be a no-op off a bridge origin"
    );

    /* Session summary export: stable shape, finite numbers, well-formed CSV. */
    const ex = data.exportSummary;
    for (const key of [
      "generatedAt",
      "mode",
      "totals",
      "models",
      "advisorCalls",
      "subagents",
      "activity",
      "disclaimer"
    ]) {
      assert.ok(ex.keys.includes(key), `summary must include ${key}`);
    }
    assert.deepStrictEqual(
      ex.modelNames,
      ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"],
      "summary must report every model bucket"
    );
    assert.ok(ex.totalsFinite, "summary totals must be finite numbers, never NaN");
    assert.ok(ex.everyCostFinite, "every model cost must be finite, never NaN");
    const csvLines = ex.csv.trim().split("\n");
    assert.strictEqual(
      csvLines[0],
      "model,inputTokens,outputTokens,estimatedCostUsd",
      "CSV header must be stable"
    );
    assert.ok(
      csvLines.some((l) => l.startsWith("TOTAL,")),
      "CSV must carry a TOTAL row"
    );
    assert.strictEqual(csvLines[1].split(",").length, 4, "CSV data rows keep four columns");

    /* Accessibility invariants: these are a regression guard, not a WCAG claim. */
    const ff = data.focusFlow;
    assert.strictEqual(ff.viewMode, "history", "clicking History must switch the view mode");
    assert.ok(ff.drawerOpen, "History must open its drawer sheet");
    assert.ok(
      ff.focusStayedOnToggle,
      "opening a non-modal sheet must not steal focus from its toggle"
    );
    assert.ok(ff.focusInsideSheet, "the test must be able to put focus inside the sheet");
    assert.ok(
      ff.restoredToViewControl,
      "hiding the sheet that held focus must return focus to a view control"
    );
    assert.strictEqual(ff.stageMode, "stage", "Stage click must return to stage mode");
    assert.ok(ff.historyDrawerClosed, "leaving History must close its drawer");

    const a = data.a11y;
    for (const c of a.chars) {
      assert.strictEqual(c.role, "button", "each station must expose role=button");
      assert.strictEqual(c.tab, "0", "each station must be tab-reachable");
      assert.ok(c.label, "each station must have an accessible name");
    }
    assert.strictEqual(a.portal.role, "button", "merge portal must expose role=button");
    assert.strictEqual(a.portal.tab, "0", "merge portal must be tab-reachable");
    assert.strictEqual(a.bannerLive, "polite", "presence banner must announce politely");
    assert.strictEqual(a.logLive, "polite", "session log must announce politely");
    for (const v of a.viewControls) {
      assert.strictEqual(v.controls, "drawers", `${v.id} must declare what it controls`);
    }
    assert.ok(a.volume && a.volume.label, "volume control must have an accessible name");
    assert.strictEqual(a.volume.type, "range", "volume control must be a range input");

    console.log("dashboard units OK · formatters, avatar invariants, role mapping");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
