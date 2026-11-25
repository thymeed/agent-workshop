/**
 * test/transcript-history.test.js is a plain script. A test that throws after tmpTranscripts() must
 * still leave no folder behind: run the real file with a planted throw and check the folders it made.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { tmpRoot } = require("../helpers/tmp");

const REPO = path.join(__dirname, "..", "..");
const PRELOAD = path.join(__dirname, "..", "helpers", "record-mkdtemp.js");
const SCRIPT = path.join(REPO, "test", "transcript-history.test.js");

test("a throw after tmpTranscripts() leaves no temp folders behind", { timeout: 120000 }, () => {
  const logFile = path.join(REPO, ".scratch", "mkdtemp-" + process.pid + "-transcript-history");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.rmSync(logFile, { force: true });
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      env: {
        ...env,
        NODE_OPTIONS: `--require "${PRELOAD.split(path.sep).join("/")}"`,
        RECORD_MKDTEMP_LOG: logFile,
        TRANSCRIPT_HISTORY_PLANT_THROW: "1"
      },
      encoding: "utf8",
      timeout: 100000
    });
    assert.equal(res.status, 1, "child exit code, stderr:\n" + res.stderr);
    assert.ok(res.stderr.includes("planted throw after tmpTranscripts"), "planted error missing");
    const made = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    assert.ok(made.length > 0, "preload recorded no folders, so this check proves nothing");
    const root = path.resolve(tmpRoot());
    const left = made.filter((d) => {
      assert.ok(
        path.dirname(path.resolve(d)) === root,
        "recorded folder is outside the test temp root: " + path.basename(d)
      );
      return fs.existsSync(d);
    });
    assert.deepEqual(
      left.map((d) => path.basename(d)),
      [],
      "temp folders left behind (names only)"
    );
  } finally {
    fs.rmSync(logFile, { force: true });
  }
});
