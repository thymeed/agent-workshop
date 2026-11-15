/**
 * Tests for scripts/mask-privacy-words.sh: the CI step that masks each privacy word.
 * Needs bash (present on every CI runner and in Git Bash); skipped when it is missing.
 */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "mask-privacy-words.sh");
const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const WARNING = "::warning::a privacy word shorter than 3 chars cannot be masked";

function run(words) {
  const env = { ...process.env };
  if (words === undefined) delete env.PRIVACY_WORDS;
  else env.PRIVACY_WORDS = words;
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  return { status: r.status, lines: r.stdout.split("\n").filter(Boolean), err: r.stderr };
}

test(
  "short word warns once and appears only inside ::add-mask:: lines",
  { skip: !HAS_BASH },
  () => {
    const r = run("ab,longword");
    assert.equal(r.err, "", "nothing may reach stderr");
    assert.equal(r.status, 0);
    // Whole output pinned: any extra line, such as a bare word, fails.
    assert.deepEqual(r.lines, ["::add-mask::ab", "::add-mask::longword", WARNING]);
  }
);

test("several short words still warn once", { skip: !HAS_BASH }, () => {
  const r = run("a,bc,longword");
  assert.equal(r.err, "", "nothing may reach stderr");
  assert.equal(r.lines.filter((l) => l === WARNING).length, 1);
});

test("3-character word masks with no warning", { skip: !HAS_BASH }, () => {
  const r = run("abc,longword");
  assert.equal(r.err, "", "nothing may reach stderr");
  assert.equal(r.status, 0);
  assert.deepEqual(r.lines, ["::add-mask::abc", "::add-mask::longword"]);
});

test("whitespace is trimmed and blank entries are skipped", { skip: !HAS_BASH }, () => {
  const r = run("  abc , ,longword  ");
  assert.equal(r.err, "", "nothing may reach stderr");
  assert.deepEqual(r.lines, ["::add-mask::abc", "::add-mask::longword"]);
});

test("empty or unset secret prints nothing and exits 0", { skip: !HAS_BASH }, () => {
  for (const v of ["", undefined]) {
    const r = run(v);
    assert.equal(r.err, "", "nothing may reach stderr");
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, []);
  }
});
