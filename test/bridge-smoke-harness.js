"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
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
  const projectsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cursor-agents-projects-"));
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cursor-agents-smoke-"));
  await fs.promises.mkdir(tempDir, { recursive: true });
  tempDirs.push(projectsRoot);
  tempDirs.push(tempDir);
  const eventLogDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cursor-agents-eventlog-"));
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

async function stopBridgeForSmoke() {
  try {
    resetWatchState();
  } catch (_) {
    /* ignore */
  }
  await stopBridge();
  while (tempEventLogDirs.length) {
    const dir = tempEventLogDirs.pop();
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  getFreePort,
  startBridgeForSmoke,
  stopBridgeForSmoke
};
