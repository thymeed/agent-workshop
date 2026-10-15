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
        }
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

    console.log("dashboard units OK · formatters, avatar invariants, role mapping");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
