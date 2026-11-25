"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const net = require("net");
const { mkTmpAsync, rmTmpAll } = require("./helpers/tmp");
const { startBridge, stopBridge, resetWatchState } = require("../live-bridge.js");

const tempDirs = [];
const tempEventLogDirs = [];

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

/**
 * Start the live bridge against an empty temp transcripts dir so smokes never
 * read the developer's real ~/.cursor/projects agent-transcripts.
 */
async function startBridgeForSmoke(opts) {
  opts = opts || {};
  const projectsRoot = await mkTmpAsync("cursor-agents-projects-");
  const tempDir = await mkTmpAsync("cursor-agents-smoke-");
  await fs.promises.mkdir(tempDir, { recursive: true });
  tempDirs.push(projectsRoot);
  tempDirs.push(tempDir);
  const eventLogDir = await mkTmpAsync("cursor-agents-eventlog-");
  tempEventLogDirs.push(eventLogDir);
  const port = opts.port != null ? opts.port : await getFreePort();
  const info = await startBridge({
    ...opts,
    port,
    quiet: true,
    dir: tempDir,
    projectsRoot,
    eventLogDir,
    reuseExisting: false
  });
  return { ...info, port, transcriptsDir: tempDir, eventLogDir };
}

/**
 * Never rejects: callers run it inside their own finally, and a throw there would replace their
 * test error. A failed stop or cleanup is printed and fails the run through the exit code, and the
 * temp folders are removed either way.
 */
async function stopBridgeForSmoke() {
  try {
    resetWatchState();
  } catch (_) {
    /* ignore */
  }
  try {
    await stopBridge();
  } catch (e) {
    console.error("smoke stop failed: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  } finally {
    const all = [];
    while (tempEventLogDirs.length) all.push(tempEventLogDirs.pop());
    while (tempDirs.length) all.push(tempDirs.pop());
    const err = rmTmpAll(all);
    if (err) {
      console.error("smoke cleanup failed: " + (err && err.message ? err.message : err));
      process.exitCode = 1;
    }
  }
}

/**
 * A page whose stored data-source choice is "cursor". The harness bridge starts in Cursor mode
 * (it is given a dir), and the dashboard's own default is Claude Code: without a stored choice
 * the page would switch the bridge to Claude Code on connect.
 */
async function newCursorPage(browser) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("ca.source.v1", "cursor");
    } catch (_e) {
      /* storage blocked */
    }
  });
  return page;
}

module.exports = {
  newCursorPage,
  getFreePort,
  startBridgeForSmoke,
  stopBridgeForSmoke
};
