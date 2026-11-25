/**
 * Unit tests for test/helpers/tmp.js: prefix checks, rmTmp bounds, and that the temp folders made
 * by event-log.test.js and transcript-tail.test.js are gone after those files run.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { tmpRoot, mkTmp, mkTmpAsync, rmTmp, rmTmpAll } = require("../helpers/tmp");

const REPO = path.join(__dirname, "..", "..");
const PRELOAD = path.join(__dirname, "..", "helpers", "record-mkdtemp.js");

// Counts mkdtemp calls made while fn runs. Other test files use tmpRoot() at the same time, so
// comparing folder listings would be flaky; this only sees this process.
function countMkdtemp(fn) {
  let calls = 0;
  const sync = fs.mkdtempSync;
  const async_ = fs.promises.mkdtemp;
  fs.mkdtempSync = (...a) => (calls++, sync(...a));
  fs.promises.mkdtemp = (...a) => (calls++, async_(...a));
  const restore = () => {
    fs.mkdtempSync = sync;
    fs.promises.mkdtemp = async_;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      () => (restore(), calls),
      (e) => (restore(), Promise.reject(e))
    );
}

test("mkTmp makes a folder under tmpRoot and rmTmp removes it", () => {
  const dir = mkTmp("x-");
  try {
    assert.ok(fs.statSync(dir).isDirectory());
    assert.ok(path.basename(dir).startsWith("x-"));
    assert.ok(
      path.dirname(dir) === path.resolve(tmpRoot()),
      "folder is not directly under the test temp root: " + path.basename(dir)
    );
  } finally {
    rmTmp(dir);
  }
  assert.equal(fs.existsSync(dir), false);
});

test("mkTmpAsync makes a folder under tmpRoot", async () => {
  const dir = await mkTmpAsync("y-");
  try {
    assert.ok(
      path.dirname(dir) === path.resolve(tmpRoot()),
      "folder is not directly under the test temp root: " + path.basename(dir)
    );
    assert.ok(fs.statSync(dir).isDirectory());
  } finally {
    rmTmp(dir);
  }
});

const outsideAbs = path.join(os.tmpdir(), "tmp-helper-never-" + process.pid + "-" + Date.now());
const BAD_PREFIXES = [
  ["parent segment with slash", "../"],
  ["forward slash", "foo/bar-"],
  ["backslash", "foo\\bar-"],
  ["dot dot", ".."],
  ["dot dot inside a name", "a..b-"],
  ["absolute path", outsideAbs],
  ["win32 drive path", "C:\\x-"],
  ["win32 unc path", "\\\\host\\x-"],
  ["empty", ""],
  ["not a string", 42],
  ["undefined", undefined]
];

// A TypeError from a dropped typeof check must not pass as a refusal.
const isBadPrefixError = (e) => e instanceof Error && e.message.startsWith("mkTmp: bad prefix");

for (const [label, prefix] of BAD_PREFIXES) {
  test("mkTmp refuses a bad prefix before creating anything: " + label, async () => {
    const calls = await countMkdtemp(() => assert.throws(() => mkTmp(prefix), isBadPrefixError));
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(outsideAbs), false);
  });

  test("mkTmpAsync refuses a bad prefix before creating anything: " + label, async () => {
    const calls = await countMkdtemp(() =>
      assert.rejects(async () => mkTmpAsync(prefix), isBadPrefixError)
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(outsideAbs), false);
  });
}

test("rmTmp refuses a folder outside tmpRoot and leaves it intact", () => {
  const outside = path.join(REPO, ".scratch", "tmp-helper-outside-" + process.pid);
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    assert.throws(() => rmTmp(outside));
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("rmTmp refuses tmpRoot itself and a .. escape", () => {
  const root = tmpRoot();
  assert.throws(() => rmTmp(root));
  assert.throws(() => rmTmp(root + path.sep));
  // Names that do not exist, so a broken rmTmp cannot delete anything real here.
  assert.throws(() => rmTmp(path.join(root, "..", "tmp-helper-absent-" + process.pid)));
  assert.ok(fs.existsSync(root));
});

test("rmTmp removes a nested tree under tmpRoot", () => {
  const dir = mkTmp("tree-");
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "b", "f.txt"), "x");
  rmTmp(dir);
  assert.equal(fs.existsSync(dir), false);
});

test("rmTmpAll removes every folder even when one is refused, and returns the first error", () => {
  // Names that do not exist and sit outside tmpRoot, so nothing real can be deleted by mistake.
  const bad1 = path.join(REPO, ".scratch", "tmp-helper-all-absent-1-" + process.pid);
  const bad2 = path.join(REPO, ".scratch", "tmp-helper-all-absent-2-" + process.pid);
  const a = mkTmp("all-a-");
  const b = mkTmp("all-b-");
  try {
    fs.writeFileSync(path.join(a, "f.txt"), "x");
    const err = rmTmpAll([bad1, a, bad2, b]);
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes(path.basename(bad1)), "first error, not a later one");
    assert.ok(!err.message.includes(path.basename(bad2)));
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("rmTmpAll returns undefined when every removal works, and for an empty list", () => {
  const a = mkTmp("all-ok-a-");
  const b = mkTmp("all-ok-b-");
  assert.equal(rmTmpAll([a, b]), undefined);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
  assert.equal(rmTmpAll([]), undefined);
});

// Runs one test file in a child node --test. A preload (set through NODE_OPTIONS so the files
// node --test spawns get it too) records each folder the child makes, so the check is exact even
// while other files use tmpRoot() at the same time.
for (const rel of ["test/event-log.test.js", "test/unit/transcript-tail.test.js"]) {
  test("no temp folders are left behind by " + rel, { timeout: 240000 }, () => {
    const logFile = path.join(
      REPO,
      ".scratch",
      "mkdtemp-" + process.pid + "-" + path.basename(rel)
    );
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.rmSync(logFile, { force: true });
    try {
      const env = { ...process.env };
      // Inside a parent node --test run this would make the child skip the runner.
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync(process.execPath, ["--test", path.join(REPO, rel)], {
        cwd: REPO,
        env: {
          ...env,
          NODE_OPTIONS: `--require "${PRELOAD.split(path.sep).join("/")}"`,
          RECORD_MKDTEMP_LOG: logFile
        },
        encoding: "utf8",
        timeout: 200000
      });
      assert.equal(res.status, 0, "child failed:\n" + res.stdout + res.stderr);
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
}
