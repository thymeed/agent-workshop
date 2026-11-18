/**
 * First run on the Claude Code default: no stored source choice, a bridge started with no
 * Cursor folder and a planted Claude Code home with two projects. The page must follow the
 * bridge without any POST /api/source or /api/select: the chip reads Claude Code, History is
 * hidden, the picker shows the project the bridge selected (the newest), and that project's
 * rows reach the stage. The browser profile, the planted home and the event log live under
 * .scratch/ (never system temp).
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startBridge, stopBridge } = require("../live-bridge.js");
const { getFreePort } = require("./bridge-smoke-harness.js");
const L = require("./helpers/claude-lines");

const SCRATCH = path.join(__dirname, "..", ".scratch", "claude-default-smoke");
const HOME = path.join(SCRATCH, "home");
const PROFILE = path.join(SCRATCH, "profile");
const LOG_DIR = path.join(SCRATCH, "app-data");

function plant() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const proj = path.join(HOME, ".claude", "projects");
  const base = Math.floor(Date.now() / 1000) - 500;
  const head = (cwd) => JSON.stringify({ type: "user", cwd, sessionId: L.SESSION });
  const newest = path.join(proj, "enc-new", L.SESSION + ".jsonl");
  fs.mkdirSync(path.dirname(newest), { recursive: true });
  fs.writeFileSync(
    newest,
    [
      head("/srv/proj-new"),
      L.userTurn("start"),
      L.assistant([L.agentCall("toolu_1", "worker", "sonnet")]),
      L.agentResult("toolu_1", "agent1"),
      L.notification("toolu_1", "agent1", "completed")
    ].join("\n") + "\n"
  );
  fs.utimesSync(newest, base + 50, base + 50);
  const oldest = path.join(proj, "enc-old", "o.jsonl");
  fs.mkdirSync(path.dirname(oldest), { recursive: true });
  fs.writeFileSync(oldest, head("/srv/proj-old") + "\n");
  fs.utimesSync(oldest, base + 40, base + 40);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
}

async function main() {
  const errors = [];
  plant();
  delete process.env.CURSOR_TRANSCRIPTS;
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: path.join(SCRATCH, "no-cursor-projects"),
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: HOME }
  });
  const tmp = path.join(SCRATCH, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    env: { ...process.env, TEMP: tmp, TMP: tmp }
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const stored = await page.evaluate(() => window.localStorage.getItem("ca.source.v1"));
    if (stored !== null) errors.push("expected no stored source choice, got " + stored);

    await page.waitForFunction(
      () => {
        const p = document.getElementById("projectPicker");
        return !!p && !p.hidden && p.options.length === 2 && p.value;
      },
      null,
      { timeout: 20000 }
    );
    // the bridge's own view of the selection
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const newestId = projects.projects[0].id;
    if (projects.projects[0].label !== "proj-new") errors.push("newest is not listed first");
    if (status.projectId !== newestId) errors.push("bridge did not select the newest project");
    const picker = await page.evaluate(() => document.getElementById("projectPicker").value);
    if (picker !== status.projectId) errors.push("picker value differs from the bridge selection");

    const chip = await page.evaluate(() => {
      const chipEl = document.getElementById("hudSource");
      const hist = document.getElementById("viewHistory");
      return {
        chipHidden: chipEl.hidden,
        chipText: document.getElementById("hudSourceValue").textContent,
        historyHidden: hist.hidden || getComputedStyle(hist).display === "none",
        claudePressed: document.getElementById("sourceClaude").getAttribute("aria-pressed")
      };
    });
    if (chip.chipHidden || chip.chipText !== "Claude Code")
      errors.push("chip: " + JSON.stringify(chip));
    if (!chip.historyHidden) errors.push("History button is visible in Claude Code mode");
    if (chip.claudePressed !== "true") errors.push("Claude Code button is not pressed");

    // the newest project's rows reach the stage (replay rows fill the session log)
    try {
      await page.waitForFunction(
        () => document.querySelectorAll("#sessionLog .log-line").length > 1,
        null,
        { timeout: 15000 }
      );
    } catch (_e) {
      errors.push("no rows of the newest project reached the stage");
    }
    const footer = await page.evaluate(() => document.getElementById("footerProject").textContent);
    if (footer !== "proj-new") errors.push("footer names " + footer);
    const picker2 = await page.evaluate(() => document.getElementById("projectPicker").value);
    if (picker2 !== status.projectId) errors.push("picker value changed after the rows arrived");

    const bad = posts.filter((p) => p === "/api/source" || p === "/api/select");
    if (bad.length) errors.push("the page posted " + bad.join(", "));

    // station names follow the page: Claude Code roles in Live on Claude Code, Cursor names
    // after a switch to Cursor and in Demo
    const names = () =>
      page.evaluate(() =>
        ["opus", "advisor", "worker", "explorer", "researcher"].map(
          (s) => document.querySelector("#char-" + s + " .char-label").textContent
        )
      );
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const CC = ["Lead", "Planner", "Worker", "Researcher", "Reviewer"];
    const CURSOR = ["Opus", "Fable", "Sonnet", "Explore", "Research"];
    const got = await names();
    if (!same(got, CC)) errors.push("Claude Code labels: " + got.join(","));
    await page.click("#sourceCursor", { force: true });
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Cursor",
      null,
      { timeout: 20000 }
    );
    const gotCursor = await names();
    if (!same(gotCursor, CURSOR)) errors.push("Cursor labels: " + gotCursor.join(","));
    await page.click("#sourceClaude", { force: true });
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Claude Code",
      null,
      { timeout: 20000 }
    );
    const gotBack = await names();
    if (!same(gotBack, CC)) errors.push("labels after switching back: " + gotBack.join(","));
    await page.click("#modeDemo");
    const gotDemo = await names();
    if (!same(gotDemo, CURSOR)) errors.push("Demo labels: " + gotDemo.join(","));
    await page.click("#modeLive");
    await page.waitForFunction(
      () => document.getElementById("hudSourceValue").textContent === "Claude Code",
      null,
      { timeout: 20000 }
    );
    const gotLive = await names();
    if (!same(gotLive, CC)) errors.push("labels after Demo and back to Live: " + gotLive.join(","));
    await page.screenshot({ path: path.join(SCRATCH, "claude-default.png") });
  } finally {
    await ctx.close();
    await stopBridge();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
  if (errors.length) {
    console.error("claude-default-smoke FAILED:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("claude-default-smoke OK · default source, newest project selected, no posts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
