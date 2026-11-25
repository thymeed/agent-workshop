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

/** Throws unless prefix is a plain name part: no separators, no "..", not absolute. */
function checkPrefix(prefix) {
  if (
    typeof prefix !== "string" ||
    prefix === "" ||
    prefix.includes("..") ||
    prefix.includes("/") ||
    prefix.includes("\\") ||
    path.isAbsolute(prefix) ||
    path.win32.isAbsolute(prefix)
  ) {
    throw new Error("mkTmp: bad prefix " + JSON.stringify(prefix));
  }
}

/** Like fs.mkdtempSync(os.tmpdir() + prefix), but inside the project. */
function mkTmp(prefix) {
  checkPrefix(prefix);
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

/** Promise version of mkTmp. */
async function mkTmpAsync(prefix) {
  checkPrefix(prefix);
  return fs.promises.mkdtemp(path.join(tmpRoot(), prefix));
}

/**
 * Removes a folder made by mkTmp/mkTmpAsync. Throws, and removes nothing, unless dir is strictly
 * inside tmpRoot() (so never tmpRoot() itself or anything outside it).
 * Lexical check only; paths through symlinks or junctions inside tmpRoot() are not covered.
 */
function rmTmp(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(path.resolve(tmpRoot()), resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("rmTmp: not inside the test temp root: " + resolved);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Removes every folder, even if one removal fails. Returns the first error (or undefined) so the
 * caller decides whether to throw; a finally must not let it replace a test error.
 */
function rmTmpAll(dirs) {
  let first;
  for (const dir of dirs) {
    try {
      rmTmp(dir);
    } catch (err) {
      if (first === undefined) first = err;
    }
  }
  return first;
}

module.exports = { tmpRoot, mkTmp, mkTmpAsync, rmTmp, rmTmpAll };
