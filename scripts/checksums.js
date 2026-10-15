/**
 * Write SHA256SUMS.txt for a build output directory (default: dist/, override: argv[1]).
 * Manifest is `shasum -a 256` compatible: "<64-hex>  <name>", sorted, LF-terminated.
 * Top-level files only, so every line names a file the release workflow actually uploads;
 * nested unpacked app trees are never published and would only add noise.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SUMS_NAME = "SHA256SUMS.txt";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildLines(dir) {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== SUMS_NAME)
    .map((entry) => entry.name)
    .sort();

  return names.map((name) => `${sha256(path.join(dir, name))}  ${name}`);
}

function main(argv) {
  const dir = path.resolve(argv[0] || "dist");

  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    console.error(`checksums: not a directory: ${dir}`);
    return 1;
  }

  const lines = buildLines(dir);
  if (lines.length === 0) {
    console.error(`checksums: no files to hash in ${dir}`);
    return 1;
  }

  const out = path.join(dir, SUMS_NAME);
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`checksums: ${lines.length} file(s) → ${out}`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { SUMS_NAME, buildLines, main, sha256 };
