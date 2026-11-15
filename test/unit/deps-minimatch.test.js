/**
 * Pins the minimatch overrides in package.json. A blanket minimatch 11 under app-builder-lib
 * once reached glob@7 and @electron/asar, where glob.sync() threw and asar silently stopped
 * unpacking `*.node` files. Each copy must stay on the major its caller was written for.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..", "..");

function packageDir(name, fromDir) {
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [fromDir] }));
}

function versionOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

const builderDir = packageDir("app-builder-lib", ROOT);
const asarDir = packageDir("@electron/asar", builderDir);
const globDir = packageDir("glob", asarDir);
const filelistDir = packageDir("filelist", packageDir("jake", packageDir("ejs", builderDir)));

async function withTempDir(fn) {
  const scratch = path.join(ROOT, ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "deps-minimatch-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("minimatch resolves to 11.x for app-builder-lib, 3.x for @electron/asar and glob@7, 5.x for filelist", () => {
  assert.match(versionOf(packageDir("minimatch", builderDir)), /^11\./);
  assert.match(versionOf(globDir), /^7\./);
  assert.match(versionOf(packageDir("minimatch", asarDir)), /^3\./);
  assert.match(versionOf(packageDir("minimatch", globDir)), /^3\./);
  assert.match(versionOf(packageDir("minimatch", filelistDir)), /^5\./);
});

test("glob.sync works with the copy @electron/asar uses", async () => {
  const glob = require(globDir);
  await withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a.js"), "");
    fs.writeFileSync(path.join(dir, "sub", "b.js"), "");
    fs.writeFileSync(path.join(dir, "c.txt"), "");
    assert.deepEqual(glob.sync("**/*.js", { cwd: dir }).sort(), ["a.js", "sub/b.js"]);
  });
});

test("@electron/asar unpacks *.node files", async () => {
  const asar = require(asarDir);
  await withTempDir(async (dir) => {
    const src = path.join(dir, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.js"), "1");
    fs.writeFileSync(path.join(src, "sub", "x.node"), "bin");
    const out = path.join(dir, "out.asar");
    await asar.createPackageWithOptions(src, out, { unpack: "*.node" });
    assert.ok(fs.existsSync(path.join(`${out}.unpacked`, "sub", "x.node")));
  });
});
