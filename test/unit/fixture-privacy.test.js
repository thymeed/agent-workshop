/**
 * Privacy gate for Claude Code fixtures. Walks test/fixtures/claude-code/ recursively
 * and fails if any file CONTENT or any file/folder NAME carries a real username, home
 * path, cloud-sync folder or WSL path. Anything added under that tree later is
 * covered automatically. The neutral names `-home-user-demo` and `/home/user` pass.
 *
 * .json/.jsonl files are scanned twice: as raw text, and again line by line after
 * JSON.parse, testing every decoded key and string value, so \uXXXX escapes cannot
 * hide a path. Unparseable lines (a cut-off tail) are covered by the raw scan.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..", "fixtures", "claude-code");

// Owner-specific words (username, cloud-sync folder name, ...) are never committed.
// They come from the PRIVACY_WORDS env var (comma-separated) or a gitignored
// .privacy-words file at the repo root (one per line, # starts a comment).
function loadWords() {
  const file = path.join(__dirname, "..", "..", ".privacy-words");
  const fromFile = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const fromEnv = (process.env.PRIVACY_WORDS || "").split(",");
  return [...fromFile, ...fromEnv].map((w) => w.trim()).filter((w) => w && !w.startsWith("#"));
}

const GENERIC = [
  "[A-Za-z]:[\\\\/]+Users", // any drive: C:\Users, C:\\Users, D:/Users
  "[A-Za-z]--Users-", // Claude Code's own Windows project-folder naming
  "/mnt/[a-z]/", // WSL view of a drive
  "-mnt-[a-z]-",
  "(^|[^\\w])/Users/", // macOS home
  "-Users-",
  "/home/(?!user\\b)",
  "-home-(?!user\\b)",
  "\\\\+wsl"
];

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildForbidden = (words) => new RegExp([...words.map(escapeRe), ...GENERIC].join("|"), "i");

const WORDS = loadWords();
const FORBIDDEN = buildForbidden(WORDS);

/** Every decoded key and string value of a parsed JSON value. */
function decodedStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => decodedStrings(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      decodedStrings(x, out);
    }
  }
  return out;
}

/** First forbidden hit in a file's text, or null. */
function findHit(fileName, text) {
  const raw = FORBIDDEN.exec(text);
  if (raw) return raw[0];
  if (!/\.jsonl?$/.test(fileName)) return null;
  const chunks = fileName.endsWith(".jsonl") ? text.split("\n") : [text];
  for (const chunk of chunks) {
    if (!chunk) continue;
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue; // unparseable (cut-off) line: the raw scan above already covered it
    }
    for (const str of decodedStrings(parsed)) {
      const m = FORBIDDEN.exec(str);
      if (m) return m[0];
    }
  }
  return null;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push({ full, name: entry.name, dir: entry.isDirectory() });
    if (entry.isDirectory()) walk(full, out);
  }
  return out;
}

const NO_WORDS_MSG =
  "SKIPPED: no owner words configured (set PRIVACY_WORDS or create .privacy-words); " +
  "only the generic path patterns were checked";
if (!WORDS.length) console.warn(`[fixture-privacy] ${NO_WORDS_MSG}`);

test(
  "owner name words are configured and checked",
  { skip: WORDS.length ? false : NO_WORDS_MSG },
  () => {
    const re = buildForbidden(WORDS);
    for (const w of WORDS) assert.ok(re.test(`x/${w.toUpperCase()}/y`), `word not matched: ${w}`);
  }
);

test("fixture tree exists and is non-trivial", () => {
  assert.ok(walk(ROOT).filter((e) => !e.dir).length >= 5);
});

test("no fixture file or folder NAME matches the forbidden patterns", () => {
  for (const e of walk(ROOT)) {
    assert.ok(!FORBIDDEN.test(e.name), `forbidden name: ${path.relative(ROOT, e.full)}`);
  }
});

test("no fixture file CONTENT matches the forbidden patterns", () => {
  for (const e of walk(ROOT).filter((x) => !x.dir)) {
    const hit = findHit(e.name, fs.readFileSync(e.full, "utf8"));
    assert.ok(!hit, `forbidden text "${hit}" in ${path.relative(ROOT, e.full)}`);
  }
});

const uEscape = (str) =>
  [...str].map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");

test("the forbidden-pattern matcher itself catches what it should", () => {
  const withWord = buildForbidden(["sample.owner"]);
  assert.ok(withWord.test("a/SAMPLE.OWNER/b"), "configured word, case-insensitive");
  assert.ok(!withWord.test("a/sampleXowner/b"), "word is matched literally, not as a regex");
  for (const bad of [
    "C:\\Users\\x",
    "C:\\\\Users\\\\x",
    "C:/Users/x",
    "D:\\Users\\x",
    "E:/Users/x",
    "/home/bob/x",
    "-home-bob-proj",
    "\\\\wsl$\\Ubuntu",
    "C--Users-bob-proj",
    "D--Users-bob-proj",
    "/mnt/c/Users/bob",
    "/mnt/d/work",
    "-mnt-c-Users-bob",
    "-mnt-d-work",
    "/Users/bob",
    "cwd=/Users/bob/x",
    "-Users-bob"
  ]) {
    assert.ok(FORBIDDEN.test(bad), bad);
  }
  for (const ok of ["-home-user-demo", "/home/user/demo", "C--proj-demo", "S1", "toolu_ab12"]) {
    assert.ok(!FORBIDDEN.test(ok), ok);
  }
});

test("the content scan decodes JSON escapes and checks keys", () => {
  const esc = uEscape("C:\\Users\\someone");
  assert.ok(!FORBIDDEN.test(esc), "the raw text really hides it");
  assert.ok(findHit("x.jsonl", `{"cwd":"${esc}"}`), "escaped value");
  assert.ok(findHit("x.jsonl", `{"${uEscape("/mnt/c/x")}":1}`), "escaped key");
  assert.ok(findHit("x.json", `{"a":{"b":["${uEscape("/Users/bob")}"]}}`), "nested");
  assert.ok(findHit("x.jsonl", `{"ok":1}\n{"cwd":"${esc}"}\n`), "second line");
  assert.ok(findHit("x.jsonl", '{"ok":1}\n{"cwd":"/Users/b'), "unparseable line scanned raw");
  assert.equal(findHit("x.jsonl", '{"cwd":"S1","k":["toolu_1"]}\n'), null);
});

/** Every object key in a parsed JSON value. */
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

test("every fixture object key is a KNOWN_KEYS key, a hashed k_<12 hex>, or a hashed id", () => {
  const { KNOWN_KEYS } = require("../../scripts/sanitize-claude-transcript.js");
  const files = walk(ROOT).filter((e) => !e.dir && /\.jsonl?$/.test(e.name));
  assert.ok(files.length >= 5);
  const bad = [];
  for (const e of files) {
    const text = fs.readFileSync(e.full, "utf8");
    for (const chunk of e.name.endsWith(".jsonl") ? text.split("\n") : [text]) {
      if (!chunk) continue;
      let parsed;
      try {
        parsed = JSON.parse(chunk);
      } catch {
        continue; // the deliberately cut-off tail
      }
      for (const k of allKeys(parsed)) {
        if (KNOWN_KEYS.has(k) || /^k_[0-9a-f]{12}$/.test(k) || /^(toolu|msg)_[0-9a-f]+$/.test(k)) {
          continue;
        }
        bad.push(`${path.relative(ROOT, e.full)}: ${k}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// A cut-off last line does not parse, so the JSON checks skip it; scan every line raw for
// epoch-millisecond numbers, which would undo the shifted timestamps.
const EPOCH_MS = /[:,[]\s*-?1[0-9]{12}(?![0-9.])/;

test("no fixture line holds an epoch-millisecond number, even a cut-off one", () => {
  assert.ok(EPOCH_MS.test('{"k_1":1794106525129,'), "matcher flags a bare epoch-ms value");
  assert.ok(EPOCH_MS.test('{"a":[1,1794106525129]}'), "matcher flags one inside an array");
  assert.ok(!EPOCH_MS.test('{"a":"k_1794106525129ab","b":1234}'), "ids and small numbers pass");
  for (const e of walk(ROOT).filter((x) => !x.dir)) {
    const m = EPOCH_MS.exec(fs.readFileSync(e.full, "utf8"));
    assert.ok(!m, `epoch-ms number "${m && m[0]}" in ${path.relative(ROOT, e.full)}`);
  }
});
