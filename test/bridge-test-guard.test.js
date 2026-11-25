/**
 * BRIDGE_TEST=1 safety: startBridge must refuse missing isolation opts.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const net = require("net");
const { mkTmp, rmTmpAll } = require("./helpers/tmp");
const path = require("path");
const { startBridge, stopBridge } = require("../live-bridge.js");

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

function expectStartBridgeThrows(opts, fragment) {
  let threw = false;
  try {
    startBridge(opts);
  } catch (e) {
    threw = true;
    if (!String(e && e.message ? e.message : e).includes(fragment)) {
      throw e;
    }
  }
  if (!threw) {
    throw new Error("startBridge expected to throw containing: " + fragment);
  }
}

function isolatedOpts() {
  const logDir = mkTmp("bridge-guard-log-");
  const projectsRoot = mkTmp("bridge-guard-projects-");
  return { logDir, projectsRoot };
}

async function main() {
  const port = await getFreePort();
  const { logDir, projectsRoot } = isolatedOpts();

  expectStartBridgeThrows({ port, projectsRoot }, "eventLogDir");

  expectStartBridgeThrows({ port, eventLogDir: logDir }, "projectsRoot");

  expectStartBridgeThrows({ projectsRoot, eventLogDir: logDir }, "explicit nonzero port");

  const envLogDir = mkTmp("bridge-guard-env-log-");
  const envLogFile = path.join(envLogDir, "must-not-use.jsonl");
  const prevEventLog = process.env.CURSOR_EVENT_LOG;
  const prevEventLogDir = process.env.CURSOR_EVENT_LOG_DIR;
  process.env.CURSOR_EVENT_LOG = envLogFile;
  process.env.CURSOR_EVENT_LOG_DIR = envLogDir;

  let bridgeStarted = false;
  let cleanupErr;
  try {
    const info = await startBridge({
      port,
      quiet: true,
      eventLogDir: logDir,
      projectsRoot,
      reuseExisting: false
    });
    bridgeStarted = true;
    const bridgeLog = path.resolve(info.eventLogPath || "");
    if (bridgeLog === path.resolve(envLogFile)) {
      throw new Error("eventLogDir must win over CURSOR_EVENT_LOG under BRIDGE_TEST");
    }
    const resolvedLogDir = path.resolve(logDir);
    if (bridgeLog !== path.join(resolvedLogDir, "event-log.jsonl")) {
      throw new Error("event log path must be under explicit eventLogDir, got " + bridgeLog);
    }
  } finally {
    let stopErr;
    try {
      if (bridgeStarted) await stopBridge();
    } catch (e) {
      stopErr = e;
    }
    if (prevEventLog === undefined) delete process.env.CURSOR_EVENT_LOG;
    else process.env.CURSOR_EVENT_LOG = prevEventLog;
    if (prevEventLogDir === undefined) delete process.env.CURSOR_EVENT_LOG_DIR;
    else process.env.CURSOR_EVENT_LOG_DIR = prevEventLogDir;
    const err = rmTmpAll([logDir, projectsRoot, envLogDir]);
    cleanupErr = stopErr || err;
  }
  if (cleanupErr) throw cleanupErr;

  console.log("bridge-test-guard OK · BRIDGE_TEST isolation throws and eventLogDir precedence");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
