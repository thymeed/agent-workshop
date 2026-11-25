/**
 * Temp folders for tests. Everything lives under <repo>/.scratch/test-tmp (gitignored), never in
 * system temp.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Absolute <repo root>/.scratch/test-tmp, created on demand. */
function tmpRoot() {
  const root = path.join(__dirname, "..", "..", ".scratch", "test-tmp");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Like fs.mkdtempSync(os.tmpdir() + prefix), but inside the project. */
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

/** Promise version of mkTmp. */
function mkTmpAsync(prefix) {
  return fs.promises.mkdtemp(path.join(tmpRoot(), prefix));
}

module.exports = { tmpRoot, mkTmp, mkTmpAsync };
