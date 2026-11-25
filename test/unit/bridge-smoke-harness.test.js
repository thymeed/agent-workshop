/**
 * stopBridgeForSmoke must never reject, must still delete its temp folders when stopBridge()
 * throws, and must fail the run through process.exitCode instead.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const assert = require("node:assert/strict");
const { test, after } = require("node:test");

// The harness destructures stopBridge when it is required, so wrap the export first.
const bridge = require("../../live-bridge.js");
const realStop = bridge.stopBridge;
let failStop = false;
bridge.stopBridge = async (...a) => {
  if (failStop) throw new Error("planted stop failure");
  return realStop(...a);
};
const { startBridgeForSmoke, stopBridgeForSmoke } = require("../bridge-smoke-harness.js");

const TEST_TIMEOUT_MS = 60000;

// An early failure must not leave a bridge running or temp folders behind. stopBridgeForSmoke
// never rejects and is safe to call again when everything is already stopped.
after(async () => {
  failStop = false;
  await stopBridgeForSmoke();
});

test(
  "stopBridgeForSmoke removes its folders and sets exitCode when stopBridge throws",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const info = await startBridgeForSmoke();
    const dirs = [info.transcriptsDir, info.eventLogDir];
    const prevExit = process.exitCode;
    const prevErr = console.error;
    const logged = [];
    let exitAfter;
    try {
      for (const d of dirs) assert.ok(fs.existsSync(d));
      console.error = (m) => logged.push(String(m));
      failStop = true;
      await stopBridgeForSmoke();
      exitAfter = process.exitCode;
    } finally {
      failStop = false;
      console.error = prevErr;
      process.exitCode = prevExit;
      await realStop();
    }
    assert.equal(exitAfter, 1);
    assert.deepEqual(logged, ["smoke stop failed: planted stop failure"]);
    assert.deepEqual(
      dirs.filter((d) => fs.existsSync(d)),
      []
    );
  }
);

test(
  "stopBridgeForSmoke leaves exitCode alone when stopping works",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const info = await startBridgeForSmoke();
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await stopBridgeForSmoke();
      assert.equal(process.exitCode, undefined);
      assert.equal(fs.existsSync(info.transcriptsDir), false);
    } finally {
      process.exitCode = prevExit;
    }
  }
);
