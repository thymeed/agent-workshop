/**
 * A bridge started with an explicit Cursor folder wins for the run. The page, with no stored
 * source choice and again with a stored Claude Code choice, must show Cursor without any
 * POST /api/source and leave `ca.source.v1` as it was; a click on Claude Code then switches the
 * bridge and stores the choice. The browser profiles, the planted Claude Code home and the
 * event log live under .scratch/ (never system temp).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startBridge, stopBridge } = require("../live-bridge.js");
const { getFreePort } = require("./bridge-smoke-harness.js");

const SCRATCH = path.join(__dirname, "..", ".scratch", "explicit-cursor-smoke");
const HOME = path.join(SCRATCH, "home");
const CURSOR_DIR = path.join(SCRATCH, "cursor-transcripts");
const LOG_DIR = path.join(SCRATCH, "app-data");
const KEY = "ca.source.v1";

function plant() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const file = path.join(HOME, ".claude", "projects", "enc-new", "s.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "user", cwd: "/srv/proj-demo", sessionId: "s1" }) + "\n"
  );
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

async function runCase(port, name, seed, errors) {
  const profile = path.join(SCRATCH, "profile-" + name);
  const tmp = path.join(SCRATCH, "tmp-" + name);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    env: { ...process.env, TEMP: tmp, TMP: tmp }
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (seed) {
      await page.addInitScript(
        ([k, v]) => {
          try {
            window.localStorage.setItem(k, v);
          } catch (_e) {
            /* storage blocked */
          }
        },
        [KEY, seed]
      );
    }
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Cursor",
      null,
      { timeout: 20000 }
    );
    // give a wrong switch time to show up before asserting it did not happen
    await page.waitForTimeout(1500);
    const stored = () => page.evaluate((k) => window.localStorage.getItem(k), KEY);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    if (status.source !== "cursor") errors.push(name + ": bridge left Cursor: " + status.source);
    if (posts.includes("/api/source")) errors.push(name + ": page posted /api/source");
    if ((await stored()) !== seed)
      errors.push(name + ": stored choice changed to " + (await stored()));
    const cursorPressed = await page.evaluate(() =>
      document.getElementById("sourceCursor").getAttribute("aria-pressed")
    );
    if (cursorPressed !== "true") errors.push(name + ": Cursor button not pressed");

    await page.click("#sourceClaude", { force: true });
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Claude Code",
      null,
      { timeout: 20000 }
    );
    if ((await stored()) !== "claude-code") errors.push(name + ": click did not store claude-code");
    const count = posts.filter((p) => p === "/api/source").length;
    if (count !== 1)
      errors.push(name + ": expected one POST /api/source after the click, got " + count);
    const after = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    if (after.source !== "claude-code")
      errors.push(name + ": bridge did not switch: " + after.source);
    if (after.explicitDir !== true) errors.push(name + ": explicitDir lost after the switch");

    // the stream restarted on Claude Code: it must not flip back to Cursor
    await page.waitForTimeout(1500);
    const chip = await page.evaluate(() => document.getElementById("hudSourceValue").textContent);
    if (chip !== "Claude Code") errors.push(name + ": chip flipped back to " + chip);
    await page.screenshot({ path: path.join(SCRATCH, name + ".png") });
  } finally {
    await ctx.close();
  }
}

async function main() {
  const errors = [];
  plant();
  delete process.env.CURSOR_TRANSCRIPTS;
  try {
    for (const [name, seed] of [
      ["nostore", null],
      ["storedclaude", "claude-code"]
    ]) {
      // a fresh bridge per case: the click switches it to Claude Code
      const port = await getFreePort();
      await startBridge({
        port,
        quiet: true,
        dir: CURSOR_DIR,
        projectsRoot: path.join(SCRATCH, "no-cursor-projects"),
        eventLogDir: LOG_DIR,
        reuseExisting: false,
        claudeCode: { platform: "linux", homedir: HOME }
      });
      try {
        await runCase(port, name, seed, errors);
      } finally {
        await stopBridge();
      }
    }
  } finally {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error("explicit-cursor-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("explicit-cursor-smoke OK · explicit Cursor folder wins, click still switches");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
