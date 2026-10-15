/**
 * Direct unit tests for lib/transcript-tail.js: newline byte accounting and capped reads.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const tail = require("../../lib/transcript-tail");

const MAX = tail.TRANSCRIPT_READ_MAX_PER_POLL;
const TRANSCRIPTS = path.join(__dirname, "..", "fixtures", "transcripts");

function tmpFile(label, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-tail-" + label + "-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, content);
  return file;
}

function collect(buf, baseFileOffset = 0) {
  const seen = [];
  tail.forEachCompleteLine(buf, baseFileOffset, (offset, line) => seen.push([offset, line]));
  return seen;
}

test("TRANSCRIPT_READ_MAX_PER_POLL stays 256 KiB", () => {
  assert.equal(MAX, 256 * 1024);
});

test("newlineByteLength counts LF as 1 and CRLF as 2", () => {
  assert.equal(tail.newlineByteLength(Buffer.from("a\nb"), 1), 1);
  assert.equal(tail.newlineByteLength(Buffer.from("a\r\nb"), 1), 2);
  assert.equal(tail.newlineByteLength(Buffer.from("a\rb"), 1), 1);
  assert.equal(tail.newlineByteLength(Buffer.from("a\r"), 1), 1);
  assert.equal(tail.newlineByteLength(Buffer.from("ab"), 0), 1);
});

test("findFirstNewlineByte finds LF and CRLF but ignores a lone CR", () => {
  const lf = Buffer.from("a\nb\nc");
  assert.equal(tail.findFirstNewlineByte(lf), 1);
  assert.equal(tail.findFirstNewlineByte(lf, 0), 1);
  assert.equal(tail.findFirstNewlineByte(lf, 2), 3);
  assert.equal(tail.findFirstNewlineByte(lf, 4), -1);
  assert.equal(tail.findFirstNewlineByte(Buffer.from("ab\r\ncd"), 0), 2);
  assert.equal(tail.findFirstNewlineByte(Buffer.from("a\rb"), 0), -1);
  assert.equal(tail.findFirstNewlineByte(Buffer.from("abc"), 0), -1);
});

test("completeLinesEndExclusive stops before a partial trailing line", () => {
  const cases = [
    ["a\nb\n", 4],
    ["a\nb", 2],
    ["a\r\nb\r\n", 6],
    ["a\r\nb", 3],
    ["a\n\n", 3],
    ["\n", 1],
    ["", -1],
    ["abc", -1]
  ];
  for (const [content, expected] of cases) {
    assert.equal(
      tail.completeLinesEndExclusive(Buffer.from(content)),
      expected,
      JSON.stringify(content)
    );
  }
});

test("forEachCompleteLine yields trimmed lines with byte offsets", () => {
  assert.deepEqual(collect(Buffer.from("  a  \n\r\nb\r\nc"), 100), [
    [100, "a"],
    [106, ""],
    [108, "b"]
  ]);
  assert.deepEqual(collect(Buffer.from("a\nb\n")), [
    [0, "a"],
    [2, "b"]
  ]);
});

test("forEachCompleteLine skips a partial trailing line", () => {
  const seen = [];
  tail.forEachCompleteLine(Buffer.from('{"a":1}\n{"b":2'), 0, (offset, line) =>
    seen.push([offset, line])
  );
  assert.deepEqual(seen, [[0, '{"a":1}']]);
});

test("readBytesAtSync reads a fixed-size window at an offset", () => {
  const file = tmpFile("window", "abcdefghij");
  assert.equal(tail.readBytesAtSync(file, 2, 4).toString("utf8"), "cdef");
  assert.equal(tail.readBytesAtSync(file, 0, 3).toString("utf8"), "abc");
  const past = tail.readBytesAtSync(file, 8, 5);
  assert.equal(past.length, 5);
  assert.equal(past.subarray(0, 2).toString("utf8"), "ij");
  assert.deepEqual([...past.subarray(2)], [0, 0, 0]);
});

test("readBytesAtSync throws for a missing file", () => {
  const missing = path.join(os.tmpdir(), "transcript-tail-absent-" + process.pid + ".jsonl");
  assert.throws(() => tail.readBytesAtSync(missing, 0, 16), { code: "ENOENT" });
});

test("isTransientReadError flags only sharing violations", () => {
  for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    assert.equal(tail.isTransientReadError({ code }), true, code);
  }
  for (const err of [{ code: "ENOENT" }, { code: "EISDIR" }, new Error("boom"), null, undefined]) {
    assert.equal(tail.isTransientReadError(err), false, String(err));
  }
});

test("sleepMsSync waits at least the requested backoff", () => {
  const start = Date.now();
  tail.sleepMsSync(5);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 5, "elapsed " + elapsed);
  assert.ok(elapsed < 500, "elapsed " + elapsed);
});

test("findNextNewlineOffset returns the offset just past the next newline", () => {
  const lf = tmpFile("lf", "aaa\nbbb\n");
  const lfSize = fs.statSync(lf).size;
  assert.equal(lfSize, 8);
  assert.equal(tail.findNextNewlineOffset(lf, 0, lfSize), 4);
  assert.equal(tail.findNextNewlineOffset(lf, 4, lfSize), 8);
  assert.equal(tail.findNextNewlineOffset(lf, lfSize, lfSize), -1);

  const crlf = tmpFile("crlf", "a\r\nb");
  const crlfSize = fs.statSync(crlf).size;
  assert.equal(crlfSize, 4);
  assert.equal(tail.findNextNewlineOffset(crlf, 0, crlfSize), 3);
  assert.equal(tail.findNextNewlineOffset(crlf, 3, crlfSize), -1);
});

test("findNextNewlineOffset returns -1 for a missing or newline-free file", () => {
  const missing = path.join(os.tmpdir(), "transcript-tail-absent-" + process.pid + "-flat.jsonl");
  assert.equal(tail.findNextNewlineOffset(missing, 0, 100), -1);
  const flat = tmpFile("flat", "abc");
  assert.equal(tail.findNextNewlineOffset(flat, 0, 3), -1);
});

test("findNextNewlineOffset skips an oversized line in capped chunks", () => {
  const huge = MAX + 1024;
  const oversize = tmpFile("oversize", "x".repeat(huge) + "\n" + "tail\n");
  const size = fs.statSync(oversize).size;
  assert.equal(size, huge + 6);
  assert.equal(tail.findNextNewlineOffset(oversize, 0, size), huge + 1);
  assert.equal(tail.findNextNewlineOffset(oversize, Math.floor(MAX / 2), size), huge + 1);
  assert.equal(tail.findNextNewlineOffset(oversize, huge + 1, size), huge + 6);
  assert.equal(tail.findNextNewlineOffset(oversize, size, size), -1);

  const boundary = tmpFile("boundary", "x".repeat(MAX) + "\nkeep\n");
  const boundarySize = fs.statSync(boundary).size;
  assert.equal(tail.findNextNewlineOffset(boundary, 0, boundarySize), MAX + 1);
});

test("findNextNewlineOffset spans a CRLF that straddles the chunk cap", () => {
  const file = tmpFile("crlf-span", "x".repeat(MAX - 1) + "\r\n" + "keep\n");
  const size = fs.statSync(file).size;
  assert.equal(tail.findNextNewlineOffset(file, 0, size), MAX + 1);
});

test("completeLinesEndExclusive agrees with a fixture transcript", () => {
  const file = path.join(TRANSCRIPTS, "parent-turn.jsonl");
  const raw = fs.readFileSync(file);
  const buf = tail.readBytesAtSync(file, 0, raw.length);
  assert.deepEqual(buf, raw);
  assert.equal(tail.completeLinesEndExclusive(buf), raw.length);

  const text = raw.toString("utf8");
  const expectedOffsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") expectedOffsets.push(i + 1);
  }
  expectedOffsets.pop();
  const lines = collect(buf);
  assert.deepEqual(
    lines.map((line) => line[0]),
    expectedOffsets
  );
  assert.deepEqual(
    lines.map((line) => line[1]),
    text
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
  );
});

test("completeLinesEndExclusive stops before the malformed fixture's partial tail", () => {
  const buf = fs.readFileSync(path.join(TRANSCRIPTS, "malformed.jsonl"));
  const end = tail.completeLinesEndExclusive(buf);
  assert.ok(end > 0 && end < buf.length, "end " + end + " of " + buf.length);
  assert.equal(buf.subarray(end).toString("utf8").includes("\n"), false);
  const lines = collect(buf);
  assert.equal(lines.length, 2);
  assert.throws(() => JSON.parse(lines[1]), SyntaxError);
});
