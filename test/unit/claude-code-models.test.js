/**
 * Unit tests for lib/claude-code-models.js: Claude Code model aliases to full ids.
 * The price check loads dashboard/role-profiles.js in a vm sandbox (no DOM), the same way
 * test/unit/role-profiles.test.js does, so the list-price rule is the real one.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..", "..");
const MATH_SRC = path.join(ROOT, "dashboard", "bill-math.js");
const PROFILES_SRC = path.join(ROOT, "dashboard", "role-profiles.js");
const { resolveModelAlias, MODEL_ALIASES } = require(
  path.join(ROOT, "lib", "claude-code-models.js")
);

const BACKSLASH = String.fromCharCode(92);

function loadProfiles() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MATH_SRC, "utf8"), sandbox, { filename: MATH_SRC });
  vm.runInContext(fs.readFileSync(PROFILES_SRC, "utf8"), sandbox, { filename: PROFILES_SRC });
  assert.ok(sandbox.window.RoleProfiles, "role-profiles.js must expose window.RoleProfiles");
  return sandbox.window.RoleProfiles;
}

test("each bare alias resolves to its latest full id", () => {
  assert.equal(resolveModelAlias("opus"), "claude-opus-5-5");
  assert.equal(resolveModelAlias("sonnet"), "claude-sonnet-5-5");
  assert.equal(resolveModelAlias("haiku"), "claude-haiku-5-5");
});

test("alias table is frozen and lists the three aliases", () => {
  assert.ok(Object.isFrozen(MODEL_ALIASES));
  assert.deepEqual(Object.keys(MODEL_ALIASES).sort(), ["haiku", "opus", "sonnet"]);
});

test("aliases ignore case and surrounding whitespace", () => {
  assert.equal(resolveModelAlias("OPUS"), "claude-opus-5-5");
  assert.equal(resolveModelAlias("  Sonnet\t"), "claude-sonnet-5-5");
  assert.equal(resolveModelAlias(" HAIKU "), "claude-haiku-5-5");
});

test("a [1m] context suffix resolves to the same id as the bare alias", () => {
  assert.equal(resolveModelAlias("opus[1m]"), "claude-opus-5-5");
  assert.equal(resolveModelAlias("sonnet[1m]"), "claude-sonnet-5-5");
  assert.equal(resolveModelAlias("Opus[1M]"), "claude-opus-5-5");
});

test("inherit resolves to the parent's full id", () => {
  assert.equal(
    resolveModelAlias("inherit", "claude-sonnet-4-5"),
    "claude-sonnet-4-5",
    "full parent id passes through"
  );
});

test("inherit resolves an alias parent once", () => {
  assert.equal(resolveModelAlias("inherit", "opus"), "claude-opus-5-5");
  assert.equal(resolveModelAlias("inherit", "Haiku[1m]"), "claude-haiku-5-5");
});

test("inherit with a parent of inherit is unset", () => {
  assert.equal(resolveModelAlias("inherit", "inherit"), "");
  assert.equal(resolveModelAlias("inherit", " INHERIT "), "");
});

test("inherit without a usable parent is unset", () => {
  assert.equal(resolveModelAlias("inherit"), "");
  assert.equal(resolveModelAlias("inherit", undefined), "");
  assert.equal(resolveModelAlias("inherit", ""), "");
  assert.equal(resolveModelAlias("inherit", null), "");
  assert.equal(resolveModelAlias("inherit", 5), "");
  assert.equal(resolveModelAlias("inherit", "fable"), "", "unknown parent word stays unset");
  assert.equal(
    resolveModelAlias("inherit", "claude-opus-5-5/../x"),
    "",
    "bad parent id stays unset"
  );
});

test("an unknown bare alias stays unset", () => {
  assert.equal(resolveModelAlias("fable"), "");
  assert.equal(resolveModelAlias("default"), "");
  assert.equal(resolveModelAlias("gpt"), "");
});

test("full ids pass through unchanged", () => {
  assert.equal(resolveModelAlias("claude-opus-4-1@20250805"), "claude-opus-4-1@20250805");
  assert.equal(resolveModelAlias("anthropic/claude-sonnet-4"), "anthropic/claude-sonnet-4");
  assert.equal(resolveModelAlias("claude-haiku-4-5"), "claude-haiku-4-5");
});

test("path-like values with a .. segment are refused", () => {
  assert.equal(resolveModelAlias("a/../b"), "", "no claude token, refused");
  assert.equal(resolveModelAlias("claude/../b"), "", "claude token but a .. segment");
  assert.equal(resolveModelAlias("anthropic/../claude-opus-4"), "");
  assert.equal(resolveModelAlias("../x"), "");
  assert.equal(resolveModelAlias("claude-opus-4" + BACKSLASH + ".." + BACKSLASH + "b"), "");
  assert.equal(resolveModelAlias("claude" + BACKSLASH + "x"), "", "backslash refused");
  assert.equal(resolveModelAlias("claude@..@x"), "", ".. between @ separators refused");
  assert.equal(resolveModelAlias("claude:..:x"), "", ".. between : separators refused");
});

test("a [1m] suffix on a full id is dropped after the rest is validated", () => {
  assert.equal(resolveModelAlias("claude-opus-4-1[1m]"), "claude-opus-4-1");
  assert.equal(resolveModelAlias("anthropic/claude-sonnet-4[1M]"), "anthropic/claude-sonnet-4");
  assert.equal(resolveModelAlias(" claude-opus-4-1@20250805[1m] "), "claude-opus-4-1@20250805");
  assert.equal(resolveModelAlias("inherit", "claude-opus-4-1[1m]"), "claude-opus-4-1");
  assert.equal(resolveModelAlias("a/../b[1m]"), "", "still refused");
  assert.equal(resolveModelAlias("claude/../b[1m]"), "");
  assert.equal(resolveModelAlias("[1m]"), "");
  assert.equal(resolveModelAlias("claude-opus-4[1m][1m]"), "", "only one suffix is dropped");
  assert.equal(resolveModelAlias("claude-opus-4[2m]"), "");
});

test("empty and . segments in a full id are refused", () => {
  assert.equal(resolveModelAlias("claude//x"), "");
  assert.equal(resolveModelAlias("claude/./x"), "");
  assert.equal(resolveModelAlias("claude/x/"), "");
  assert.equal(resolveModelAlias("claude@@x"), "");
  assert.equal(resolveModelAlias("claude::x"), "");
  assert.equal(resolveModelAlias("claude/x"), "claude/x", "a normal two-segment id still passes");
});

test("a dot run inside a segment is not a .. segment", () => {
  // Decision: the rule is segment-based, so "x.." (no empty or ".." segment) is accepted.
  assert.equal(resolveModelAlias("claude-opus-4.."), "claude-opus-4..");
});

test("a leading underscore is refused", () => {
  assert.equal(resolveModelAlias("_claude-opus-4"), "");
});

test("ids at the 128-character limit pass and 129 characters are refused", () => {
  const id128 = "claude-" + "a".repeat(121);
  assert.equal(id128.length, 128);
  assert.equal(resolveModelAlias(id128), id128);
  const id129 = id128 + "a";
  assert.equal(resolveModelAlias(id129), "");
});

test("non-strings are unset", () => {
  assert.equal(resolveModelAlias(undefined), "");
  assert.equal(resolveModelAlias(null), "");
  assert.equal(resolveModelAlias(5), "");
  assert.equal(resolveModelAlias({ model: "opus" }), "");
  assert.equal(resolveModelAlias(["opus"]), "");
});

test("empty and whitespace-only values are unset", () => {
  assert.equal(resolveModelAlias(""), "");
  assert.equal(resolveModelAlias("   "), "");
  assert.equal(resolveModelAlias("\t\n"), "");
});

test("prototype-ish keys are unset", () => {
  assert.equal(resolveModelAlias("__proto__"), "");
  assert.equal(resolveModelAlias("constructor"), "");
  assert.equal(resolveModelAlias("toString"), "");
  assert.equal(resolveModelAlias("hasOwnProperty"), "");
});

test("each resolved id is accepted by RoleProfiles.setModels and gets a list price", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const cases = [
    ["opus", "Opus 5.5"],
    ["sonnet", "Sonnet 5.5"],
    ["haiku", "Haiku 5.5"]
  ];
  for (const [alias, family] of cases) {
    const id = resolveModelAlias(alias);
    assert.equal(RP.setModels({ worker: id }), true, `setModels accepts ${alias} -> ${id}`);
    const row = RP.priceRow("worker");
    assert.notEqual(row[1], "list price", `${alias} must not show no list price`);
    assert.equal(row[0], `list price (${family}):`, `${alias} prices as ${family}`);
  }
});

test("inherit with a known parent sets a priced model through setModels", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const id = resolveModelAlias("inherit", "sonnet");
  assert.equal(RP.setModels({ worker: id }), true);
  assert.equal(RP.priceRow("worker")[0], "list price (Sonnet 5.5):");
});

test("an unknown alias stays unset and shows model not set", () => {
  const RP = loadProfiles();
  RP.apply("claude-code");
  const id = resolveModelAlias("fable");
  assert.equal(id, "");
  assert.equal(RP.setModels({ worker: id }), true, "empty string clears a slot");
  assert.deepEqual([...RP.priceRow("worker")], ["", "model not set"]);
});
