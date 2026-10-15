/**
 * Live SSE auto-reconnect smoke: load the dashboard from a real bridge, kill the
 * bridge, and assert the page notices, reports a bounded retry, and stops retrying.
 * This is the only test that exercises the reconnect loop (not just its backoff curve).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const { chromium } = require("playwright");
const { startBridgeForSmoke, stopBridgeForSmoke } = require("./bridge-smoke-harness.js");

const MAX_ATTEMPTS = 6;

async function waitFor(page, label, fn, timeoutMs) {
  try {
    await page.waitForFunction(fn, null, { timeout: timeoutMs });
    return null;
  } catch (_e) {
    return `${label} did not happen within ${timeoutMs}ms`;
  }
}

async function main() {
  const errors = [];
  const browser = await chromium.launch();

  try {
    const { port } = await startBridgeForSmoke();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(
      () => globalThis.__cursorAgentsDashTest && globalThis.__cursorAgentsDashTest.reconnectState,
      null,
      { timeout: 15000 }
    );

    /* Served from the bridge, so the page enters Live on its own. */
    const connected = await waitFor(
      page,
      "Live connect",
      () => {
        const app = document.getElementById("app");
        const s = app && app.getAttribute("data-live-presence");
        return s === "quiet-healthy" || s === "streaming" || s === "no-projects";
      },
      20000
    );
    if (connected) errors.push(connected);

    const before = await page.evaluate(() => globalThis.__cursorAgentsDashTest.reconnectState());
    if (before.attempts !== 0) {
      errors.push(`expected no retries while connected, got ${before.attempts}`);
    }
    if (before.max !== MAX_ATTEMPTS) {
      errors.push(`reconnect cap drifted: expected ${MAX_ATTEMPTS}, got ${before.max}`);
    }

    /* Kill the bridge underneath the page. */
    await stopBridgeForSmoke();

    const wentDown = await waitFor(
      page,
      "bridge-down presence",
      () => document.getElementById("app").getAttribute("data-live-presence") === "bridge-down",
      25000
    );
    if (wentDown) errors.push(wentDown);

    const retried = await waitFor(
      page,
      "a scheduled retry",
      () => globalThis.__cursorAgentsDashTest.reconnectState().attempts >= 1,
      25000
    );
    if (retried) errors.push(retried);

    const observed = await page.evaluate(() => {
      const t = globalThis.__cursorAgentsDashTest;
      const banner = document.getElementById("livePresenceBanner");
      return {
        state: t.reconnectState(),
        presence: document.getElementById("app").getAttribute("data-live-presence"),
        banner: banner ? String(banner.textContent || "") : ""
      };
    });

    if (observed.state.attempts < 1) errors.push("retry attempt was never recorded");
    if (!observed.state.pending) {
      errors.push(
        `a retry should be scheduled while backing off: ${JSON.stringify(observed.state)}`
      );
    }
    if (observed.state.attempts > MAX_ATTEMPTS) {
      errors.push(`attempts exceeded the cap: ${observed.state.attempts}`);
    }
    if (!/retry/i.test(observed.banner)) {
      errors.push(
        `bridge-down banner should mention the retry, got: ${JSON.stringify(observed.banner)}`
      );
    }
    if (observed.presence !== "bridge-down") {
      errors.push(`presence should be bridge-down, got ${observed.presence}`);
    }

    await page.close();
  } finally {
    await browser.close();
    await stopBridgeForSmoke().catch(() => {});
  }

  if (errors.length) {
    console.error("Reconnect smoke failed:\n- " + errors.join("\n- "));
    process.exit(1);
  }
  console.log("Reconnect smoke OK · SSE drop detected, bounded retry scheduled, cap respected");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
