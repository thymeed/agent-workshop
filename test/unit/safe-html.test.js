/**
 * Direct unit tests for dashboard/safe-html.js, the single HTML escaper.
 * Loaded in a vm sandbox: a browser IIFE with no DOM dependency.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.resolve(__dirname, "..", "..", "dashboard", "safe-html.js");

function load() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: SOURCE });
  assert.ok(sandbox.window.SafeHtml, "safe-html.js must expose window.SafeHtml");
  return sandbox.window.SafeHtml.escapeHtml;
}

const esc = load();

test("escapes every HTML-significant character", () => {
  assert.equal(esc("<"), "&lt;");
  assert.equal(esc(">"), "&gt;");
  assert.equal(esc("&"), "&amp;");
  assert.equal(esc('"'), "&quot;");
  assert.equal(esc("'"), "&#39;");
});

test("escapes a script tag so it cannot execute", () => {
  const out = esc("<script>alert(1)</script>");
  assert.ok(!out.includes("<"), "no raw angle bracket may survive");
  assert.ok(!out.includes(">"), "no raw angle bracket may survive");
  assert.equal(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("closing an attribute early is impossible", () => {
  const hostile = '"onmouseover="alert(1)';
  const out = esc(hostile);
  assert.ok(!out.includes('"'), "a raw double quote must not survive");
  assert.equal(out, "&quot;onmouseover=&quot;alert(1)");
  const single = "' onmouseover='alert(1)";
  assert.ok(!esc(single).includes("'"), "a raw single quote must not survive");
});

test("ampersands are escaped first, not double-escaped", () => {
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc("&amp;"), "&amp;amp;");
  assert.equal(esc("&lt;"), "&amp;lt;");
});

test("null and undefined render empty, not the literal text", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("falsy but meaningful values are preserved", () => {
  // The cards.js copy used `s || ""`, which rendered 0 and false as empty.
  assert.equal(esc(0), "0");
  assert.equal(esc(false), "false");
  assert.equal(esc(""), "");
});

test("numbers and ordinary text pass through", () => {
  assert.equal(esc(42), "42");
  assert.equal(esc("C:\\Users\\dev\\a.js"), "C:\\Users\\dev\\a.js");
  assert.equal(esc("worker · edit"), "worker · edit");
});

test("the escaped output is idempotent under a second pass", () => {
  const once = esc('<a href="x">&</a>');
  const twice = esc(once);
  assert.ok(!twice.includes("<"), "second pass must not reintroduce markup");
  assert.ok(!twice.includes(">"), "second pass must not reintroduce markup");
});

test("transcript-like payloads stay inert", () => {
  const payloads = [
    '{"role":"assistant","text":"<img src=x onerror=alert(1)>"}',
    "'; DROP TABLE events; --",
    "<svg/onload=alert(document.domain)>",
    "javascript:alert(1)",
    "</textarea><script>fetch('http://evil')</script>"
  ];
  for (const p of payloads) {
    const out = esc(p);
    assert.ok(!out.includes("<"), `raw < survived in: ${p}`);
    assert.ok(!out.includes(">"), `raw > survived in: ${p}`);
    assert.ok(!out.includes('"'), `raw " survived in: ${p}`);
    assert.ok(!out.includes("'"), `raw ' survived in: ${p}`);
  }
});
