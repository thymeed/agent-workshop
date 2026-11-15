/**
 * Privacy gate for Claude Code fixtures. Walks test/fixtures/claude-code/ recursively
 * and fails if any file CONTENT or any file/folder NAME carries a real username, home
 * path, cloud-sync folder or WSL path. Anything added under that tree later is
 * covered automatically. The neutral names `-home-user-demo` and `/home/user` pass.
 *
 * .json/.jsonl files are scanned twice: as raw text, and again line by line after
 * JSON.parse, testing every decoded key and string value, so \uXXXX escapes cannot
 * hide a path. A line that does not parse fails the check; the only exception is one
 * cut-off last line of a .jsonl with no trailing newline, whose complete "..." string
 * literals are still checked and the rest must be only JSON-prefix structure (TAIL_OK).
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
  "(^|[^\\w])/Users(?!\\w)", // macOS home, with or without a trailing slash
  "(^|[^\\w])/(cygdrive/[A-Za-z]|[A-Za-z])/Users(?!\\w)", // Git Bash /c/Users, Cygwin /cygdrive/c/Users
  "(^|[^\\w:])\\\\{1,2}Users\\\\", // drive-less \Users\x, also JSON-escaped \\Users\\x
  "-Users-",
  "/home/(?!user(?![\\w.-]))", // only the neutral /home/user (not user-bob, user.bob)
  "-home-(?!user-demo\\b)", // only the neutral -home-user-demo project folder
  "\\\\wsl", // \\wsl$ and \\wsl.localhost: one backslash then wsl, so linear (was \\+wsl)
  "[\\\\/]{2}wsl(\\$|\\.localhost)", // //wsl$/Ubuntu and //wsl.localhost/Ubuntu, any slash mix
  "(^|[^\\w:\\\\])(\\\\{2}|\\\\{4})[\\w.-]{2,}\\\\{1,2}[\\w$][\\w$.-]", // UNC \\server\share, \\localhost\C$ (raw or escaped)
  "(^|[^\\w])/root(?!\\w)", // root's home, with or without a trailing slash
  "(^|[^\\w])/Volumes/", // macOS mounted volumes
  "/private/var/folders(?!\\w)", // macOS per-user temp
  "(^|[^\\w])/var/folders(?!\\w)", // macOS per-user temp without the /private prefix
  "[A-Za-z]:[\\\\/]+Documents and Settings", // old Windows profile folder
  "%(2F|5C)(Users|home)%(2F|5C)", // URL-encoded home paths
  "[A-Za-z]%3A(%5C|%2F)+Users", // URL-encoded drive paths such as C%3A%5CUsers
  // The email pattern below also flags git@github.com and pkg@1.2.3, harmless on sanitized fixtures.
  "(?<![\\w.+-])[\\w.+-]+(?:@|%40)[\\w-]+\\.[\\w.-]+", // email addresses, @ or %40 (linear: the lookbehind stops rescans)
  "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", // GitHub tokens
  "(^|[^\\w])~([A-Za-z_][\\w.-]*)?[/\\\\]" // tilde home paths: ~/x, ~bob/x and ~\x
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

/**
 * Line of the first JSON string literal in `text` whose decoded value matches `re` (1 if none
 * is found). Lets a multi-line .json report where an escaped hit sits, not always line 1.
 */
function literalLine(text, re) {
  const lit = /"(?:[^"\\\n]|\\.)*"/g;
  let m;
  while ((m = lit.exec(text))) {
    let v;
    try {
      v = JSON.parse(m[0]);
    } catch {
      continue;
    }
    if (re.test(v)) return text.slice(0, m.index).split("\n").length;
  }
  return 1;
}

const BOM = String.fromCharCode(0xfeff);

/**
 * Complete "..." string literals of a cut-off line; isKey is true when a colon follows. One
 * pass: an open literal runs to the end of the chunk and stops the scan (linear time).
 */
function tailLiterals(chunk) {
  const out = [];
  const lit = /"(?:[^"\\\n]|\\.)*("|\\?$)/g;
  const colon = /\s*:/y;
  let m;
  while ((m = lit.exec(chunk)) && m[1] === '"') {
    let value = null;
    let valid = true;
    try {
      value = JSON.parse(m[0]);
    } catch {
      valid = false;
    }
    colon.lastIndex = m.index + m[0].length;
    out.push({ value, valid, isKey: colon.test(chunk) });
  }
  return out;
}

// What a cut-off tail may hold once its complete "..." literals are blanked to "" and one open
// string at the end is dropped: JSON structure, number/true/false/null tokens and at most one
// token cut short at the end. A bare word or an unquoted key is free text and fails. Every
// complete literal followed by a colon is a key and is checked first (tailKeysOk), so a key
// with odd spacing still has to be an allowed key. Numbers end at a non-digit (linear).
const TAIL_OK =
  /^(?:[\s{}[\]:,]|""|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\d)|true|false|null)*(?:-|-?\d+(?:\.\d*)?(?:[eE][+-]?\d*)?|t|tr|tru|f|fa|fal|fals|n|nu|nul)?$/;

/**
 * True if object key k is one the sanitizer can write: a KNOWN_KEYS key, a hashed k_<12 hex>, a
 * hashed id (toolu_/msg_ plus 8..24 hex, what hashId can emit) or a real model slug (accepted
 * under any parent). SAN is defined further down; this runs only after the module has loaded.
 */
function keyOk(k, knownKeys = SAN.KNOWN_KEYS) {
  return (
    knownKeys.has(k) ||
    /^k_[0-9a-f]{12}$/.test(k) ||
    /^(toolu|msg)_[0-9a-f]{8,24}$/.test(k) ||
    SAN.MODEL_RE.test(k)
  );
}

/** True if a cut-off tail chunk is only JSON-prefix structure (see TAIL_OK). */
function tailShapeOk(chunk) {
  const lit = /("(?:[^"\\\n]|\\.)*")|"(?:[^"\\\n]|\\.)*\\?$/g;
  return TAIL_OK.test(chunk.replace(lit, (m, done) => (done ? '""' : "")));
}

/**
 * Splits a .json/.jsonl file into parsed documents ({ line, value }), at most one cut-off
 * tail ({ line, literals }: only the last chunk of a .jsonl that does not end in a newline)
 * and bad lines (a BOM, or any other unparseable chunk). `line` is 1-based for .jsonl and 1
 * for .json. Every caller must fail on each bad line.
 */
function parseFile(name, text) {
  const out = { docs: [], tail: null, bad: [] };
  if (text.startsWith(BOM)) {
    out.bad.push(1);
    text = text.slice(1);
  }
  const isLines = name.endsWith(".jsonl");
  const chunks = isLines ? text.split("\n") : [text];
  chunks.forEach((chunk, i) => {
    if (!chunk) return;
    const line = isLines ? i + 1 : 1;
    try {
      out.docs.push({ line, value: JSON.parse(chunk) });
    } catch {
      if (!isLines || i !== chunks.length - 1) {
        out.bad.push(line);
        return;
      }
      const literals = tailLiterals(chunk);
      if (
        literals.some((l) => !l.valid) ||
        literals.some((l) => l.isKey && !keyOk(l.value)) ||
        !tailShapeOk(chunk)
      ) {
        out.bad.push(line);
      } else out.tail = { line, literals };
    }
  });
  return out;
}

/**
 * First forbidden hit in a file's text as { match, line } (1-based line), or null.
 * Failure messages must use `line` only: `match` can be an owner word and CI logs are public.
 * An unparseable line is a hit too (its `match` is the word "unparseable").
 */
function findHit(fileName, text, re = FORBIDDEN) {
  const raw = re.exec(text);
  if (raw) return { match: raw[0], line: text.slice(0, raw.index).split("\n").length };
  if (!/\.jsonl?$/.test(fileName)) return null;
  const isLines = fileName.endsWith(".jsonl");
  const f = parseFile(fileName, text);
  if (f.bad.length) return { match: "unparseable", line: f.bad[0] };
  for (const doc of f.docs) {
    for (const str of decodedStrings(doc.value)) {
      const m = re.exec(str);
      if (m) return { match: m[0], line: isLines ? doc.line : literalLine(text, re) };
    }
  }
  if (f.tail) {
    for (const l of f.tail.literals) {
      const m = re.exec(l.value);
      if (m) return { match: m[0], line: f.tail.line };
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

/** A path with every forbidden match masked, so a failure never prints an owner word. */
const safePath = (p, re = FORBIDDEN) => p.replace(new RegExp(re.source, "gi"), "[redacted]");

/** The real name check: throws an assertion error naming the masked path only. */
function checkNames(root, re) {
  for (const e of walk(root)) {
    assert.ok(!re.test(e.name), `forbidden name: ${safePath(path.relative(root, e.full), re)}`);
  }
}

/** The real content check: throws an assertion error naming the masked file and the line only. */
function checkContents(root, re) {
  for (const e of walk(root).filter((x) => !x.dir)) {
    const hit = findHit(e.name, fs.readFileSync(e.full, "utf8"), re);
    assert.ok(
      !hit,
      `forbidden text in ${safePath(path.relative(root, e.full), re)}:${hit && hit.line}`
    );
  }
}

const NO_WORDS_MSG =
  "privacy-words check SKIPPED: no secret (PRIVACY_WORDS env var is unset or empty and " +
  "there is no .privacy-words file; in CI add the PRIVACY_WORDS repository secret; fork " +
  "PRs never receive it); only the generic path patterns were checked";
if (!WORDS.length) console.warn(`[fixture-privacy] ${NO_WORDS_MSG}`);

test(
  "owner name words are configured and checked",
  { skip: WORDS.length ? false : NO_WORDS_MSG },
  () => {
    const re = buildForbidden(WORDS);
    WORDS.forEach((w, i) =>
      assert.ok(re.test(`x/${w.toUpperCase()}/y`), `configured word #${i + 1} not matched`)
    );
  }
);

test("fixture tree exists and is non-trivial", () => {
  assert.ok(walk(ROOT).filter((e) => !e.dir).length >= 5);
});

test("no fixture file or folder NAME matches the forbidden patterns", () => {
  checkNames(ROOT, FORBIDDEN);
});

test("no fixture file CONTENT matches the forbidden patterns", () => {
  checkContents(ROOT, FORBIDDEN);
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

test("a failure message names file and line but never the matched word", () => {
  const word = "zq-secret-owner";
  const re = buildForbidden([word]);
  // Inside the repo's gitignored .scratch, never the system temp folder.
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-msg-"));
  // Everything an assertion error can expose, as one string.
  const dump = (err) =>
    [err.message, String(err.actual), String(err.expected), String(err.generatedMessage)]
      .concat(JSON.stringify(err), String(err.stack))
      .join("\n");
  const caught = (fn) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return assert.fail("the real check did not throw, so the test would pass vacuously");
  };
  try {
    const mk = (name, files) => {
      const dir = path.join(base, name);
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
      }
      return dir;
    };
    const { KNOWN_KEYS } = require("../../scripts/sanitize-claude-transcript.js");
    const keys = (d, r) => checkKeys(d, r, KNOWN_KEYS);
    const both = `{"type":1}\n{"${word}":1,"timestamp":1794106525129}\n`;
    const cases = [
      // [label, check, files, message must contain]
      [
        "name",
        checkNames,
        { [`sub/${word}.jsonl`]: `{"ok":1}\n` },
        "forbidden name: sub",
        "[redacted].jsonl"
      ],
      [
        "jsonl raw",
        checkContents,
        { "a.jsonl": `{"ok":1}\n{"cwd":"/x/${word}/y"}\n` },
        "a.jsonl:2"
      ],
      [
        "jsonl escaped",
        checkContents,
        { "b.jsonl": `{"ok":1}\n{"ok":2}\n{"cwd":"/x/${uEscape(word)}/y"}\n` },
        "b.jsonl:3"
      ],
      [
        "unknown key",
        keys,
        { "k.jsonl": `{"type":1}\n{"${word}":1}\n` },
        "unknown keys (1)",
        "k.jsonl:2: [redacted]"
      ],
      [
        "unknown key, word in file name",
        keys,
        { [`sub/${word}-a.jsonl`]: both },
        "[redacted]-a.jsonl:2: [redacted]"
      ],
      [
        "epoch-ms, word in content",
        checkEpoch,
        { "e.jsonl": `{"type":1}\n{"timestamp":1794106525129,"note":"${word}"}\n` },
        "epoch-ms number",
        "e.jsonl:2"
      ],
      [
        "epoch-ms, word in file name",
        checkEpoch,
        { [`sub/${word}-a.jsonl`]: both },
        "[redacted]-a.jsonl:2"
      ],
      ["plain text", checkContents, { "c.txt": `one\ntwo\nthree ${word}\n` }, "c.txt:3"],
      [
        "file name and content",
        checkContents,
        { [`${word}.txt`]: `one\n${word}\n` },
        "[redacted].txt:2"
      ]
    ];
    for (const [label, check, files, ...wanted] of cases) {
      const dir = mk(label.replace(/\W/g, "-"), files);
      const err = caught(() => check(dir, re));
      assert.ok(err instanceof assert.AssertionError, `${label}: assertion error`);
      for (const w of wanted) assert.ok(err.message.includes(w), `${label}: "${w}" in message`);
      const all = dump(err);
      assert.ok(!all.toLowerCase().includes(word), `${label}: planted word leaked`);
      assert.ok(!all.includes(uEscape(word)), `${label}: escaped planted word leaked`);
    }
    // A clean tree does not throw.
    const clean = mk("clean", { "ok.jsonl": `{"type":1}\n` });
    checkNames(clean, re);
    checkContents(clean, re);
    keys(clean, re);
    checkEpoch(clean, re);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
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

test("an escaped hit in a multi-line .json reports its real line", () => {
  const esc = uEscape("C:\\Users\\someone");
  const pretty = `{\n  "a": "S1",\n  "b": {\n    "cwd": "${esc}"\n  }\n}\n`;
  assert.equal(findHit("x.json", pretty).line, 4);
  const key = `{\n  "a": 1,\n  "${uEscape("/mnt/c/x")}": 2\n}\n`;
  assert.equal(findHit("x.json", key).line, 3);
  assert.equal(findHit("x.json", `{"cwd":"${esc}"}`).line, 1);
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

/**
 * The real key check: throws if any object key is not a KNOWN_KEYS key, a hashed k_<12 hex>,
 * a hashed id (toolu_/msg_ plus 8..24 hex, what hashId can emit) or a real model slug (the
 * sanitizer keeps those under modelUsage; any parent key is accepted here), or if a line does not parse (see parseFile).
 * Every path and key goes through safePath, and the asserted value is the count (not the
 * raw list), so assert's diff cannot print an unmasked key or path.
 */
function checkKeys(root, re, knownKeys) {
  const files = walk(root).filter((e) => !e.dir && /\.jsonl?$/.test(e.name));
  const bad = [];
  for (const e of files) {
    const f = parseFile(e.name, fs.readFileSync(e.full, "utf8"));
    const isLines = e.name.endsWith(".jsonl");
    const at = (line) => safePath(path.relative(root, e.full), re) + (isLines ? ":" + line : "");
    for (const line of f.bad) bad.push(at(line) + ": unparseable");
    for (const d of f.docs) {
      for (const k of allKeys(d.value))
        if (!keyOk(k, knownKeys)) bad.push(at(d.line) + ": " + safePath(k, re));
    }
    // a cut-off tail's keys are checked in parseFile: a bad one makes the line unparseable
  }
  assert.equal(bad.length, 0, "unknown keys (" + bad.length + "): " + bad.join("; "));
}

test("every fixture object key is a KNOWN_KEYS key, a hashed k_<12 hex>, or a hashed id", () => {
  const { KNOWN_KEYS } = require("../../scripts/sanitize-claude-transcript.js");
  assert.ok(walk(ROOT).filter((e) => !e.dir && /\.jsonl?$/.test(e.name)).length >= 5);
  checkKeys(ROOT, FORBIDDEN, KNOWN_KEYS);
});

// A cut-off last line does not parse, so the JSON checks skip it; scan every line raw for
// epoch-millisecond numbers, which would undo the shifted timestamps.
const EPOCH_MS = /[:,[]\s*-?1[0-9]{12}(?![0-9.])/;

/** The real epoch-ms check: names the masked file and line; the number itself is digits only. */
function checkEpoch(root, re) {
  for (const e of walk(root).filter((x) => !x.dir)) {
    const text = fs.readFileSync(e.full, "utf8");
    const m = EPOCH_MS.exec(text);
    const line = m ? text.slice(0, m.index).split("\n").length : 0;
    assert.ok(
      !m,
      "epoch-ms number " +
        (m && m[0]) +
        " in " +
        safePath(path.relative(root, e.full), re) +
        ":" +
        line
    );
  }
}

test("no fixture line holds an epoch-millisecond number, even a cut-off one", () => {
  assert.ok(EPOCH_MS.test('{"k_1":1794106525129,'), "matcher flags a bare epoch-ms value");
  assert.ok(EPOCH_MS.test('{"a":[1,1794106525129]}'), "matcher flags one inside an array");
  assert.ok(EPOCH_MS.test('{"ts": 1794106525129}'), "matcher flags one after whitespace");
  assert.ok(!EPOCH_MS.test('{"a":"k_1794106525129ab","b":1234}'), "ids and small numbers pass");
  checkEpoch(ROOT, FORBIDDEN);
});

test("redaction is case-insensitive in file names and content, in both directions", () => {
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-case-"));
  const dump = (err) =>
    [err.message, String(err.actual), String(err.expected), String(err.generatedMessage)]
      .concat(JSON.stringify(err), String(err.stack))
      .join("\n")
      .toLowerCase();
  const caught = (fn) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return assert.fail("the real check did not throw, so the test would pass vacuously");
  };
  try {
    let n = 0;
    for (const [configured, planted] of [
      ["zq-secret-owner", "ZQ-SECRET-OWNER"],
      ["ZQ-SECRET-OWNER", "zq-secret-owner"]
    ]) {
      const re = buildForbidden([configured]);
      const lower = configured.toLowerCase();
      const cases = [
        ["name", checkNames, `sub/${planted}.jsonl`, `{"ok":1}\n`, "[redacted].jsonl"],
        [
          "content",
          checkContents,
          `x-${planted}.txt`,
          `one\ntwo ${planted}\n`,
          "x-[redacted].txt:2"
        ],
        ["escaped", checkContents, "b.jsonl", `{"c":"${uEscape(planted)}"}\n`, "b.jsonl:1"]
      ];
      for (const [label, check, rel, body, wanted] of cases) {
        const dir = path.join(base, "d" + n++);
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
        const err = caught(() => check(dir, re));
        const tag = `${label} (${configured} vs ${planted})`;
        assert.ok(err instanceof assert.AssertionError, `${tag}: assertion error`);
        assert.ok(err.message.includes(wanted), `${tag}: "${wanted}" in message`);
        if (label !== "escaped") assert.ok(err.message.includes("[redacted]"), `${tag}: redacted`);
        const all = dump(err);
        assert.ok(!all.includes(lower), `${tag}: word leaked in some case`);
        assert.ok(!all.includes(uEscape(lower)), `${tag}: escaped word leaked`);
        assert.ok(!all.includes(uEscape(planted.toLowerCase())), `${tag}: escaped word leaked`);
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Runs a copy of this file in a throwaway tree under .scratch, so its own relative
// .privacy-words lookup cannot see the real file at the repo root.
test(
  "the skip message appears with no words configured and is absent when a word is set",
  { skip: process.env.PRIVACY_SKIP_CHILD ? "this is the isolated copy: no recursion" : false },
  () => {
    const { spawnSync } = require("child_process");
    const repo = path.join(__dirname, "..", "..");
    const scratch = path.join(repo, ".scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const tree = fs.mkdtempSync(path.join(scratch, "privacy-skip-"));
    try {
      const copy = (rel) => {
        fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
        fs.cpSync(path.join(repo, rel), path.join(tree, rel), { recursive: true });
      };
      copy("test/unit/fixture-privacy.test.js");
      copy("test/fixtures/claude-code");
      copy("scripts/sanitize-claude-transcript.js");
      assert.ok(!fs.existsSync(path.join(tree, ".privacy-words")), "no words file in the copy");
      const run = (words) => {
        const env = { ...process.env, PRIVACY_SKIP_CHILD: "1" };
        delete env.PRIVACY_WORDS;
        delete env.NODE_TEST_CONTEXT; // else the child behaves as a runner worker, not a runner
        if (words !== undefined) env.PRIVACY_WORDS = words;
        const r = spawnSync(
          process.execPath,
          [
            "--test",
            "--test-reporter=tap",
            path.join(tree, "test", "unit", "fixture-privacy.test.js")
          ],
          { cwd: tree, env, encoding: "utf8" }
        );
        return { status: r.status, out: String(r.stdout) + String(r.stderr) };
      };
      const SKIP = "privacy-words check SKIPPED: no secret";
      for (const words of [undefined, ""]) {
        const r = run(words);
        const tag = `PRIVACY_WORDS ${words === undefined ? "unset" : "empty"}`;
        assert.equal(r.status, 0, `${tag}: child run passes`);
        assert.ok(r.out.includes(SKIP), `${tag}: skip message printed`);
        const line = r.out
          .split("\n")
          .find((l) => /^(not )?ok /.test(l) && l.includes("owner name words are configured"));
        assert.ok(line && line.includes("# SKIP"), `${tag}: owner-words test reported skipped`);
      }
      const set = run("zq-secret-owner");
      assert.equal(set.status, 0, "word set: child run passes");
      assert.ok(!set.out.includes(SKIP), "word set: no skip message");
      const line = set.out
        .split("\n")
        .find((l) => /^(not )?ok /.test(l) && l.includes("owner name words are configured"));
      assert.ok(line && !line.includes("# SKIP"), "word set: owner-words test ran");
      assert.ok(!set.out.includes("zq-secret-owner"), "word set: planted word not printed");
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  }
);

// ---- path-pattern gaps ----------------------------------------------------------------

test("the neutral demo names pass, but near-miss usernames are flagged", () => {
  for (const ok of [
    "/home/user",
    "/home/user/demo",
    "/home/user\n",
    "-home-user-demo",
    "-home-user-demo-x",
    "C--proj-demo"
  ]) {
    assert.ok(!FORBIDDEN.test(ok), "must pass: " + ok);
  }
  for (const bad of [
    "/home/user-bob/x",
    "/home/user.bob/x",
    "/home/user_bob/x",
    "/home/users/x",
    "/home/username",
    "-home-user-bob-proj",
    "-home-users-x",
    "-home-userbob"
  ]) {
    assert.ok(FORBIDDEN.test(bad), "must be flagged: " + bad);
  }
});

// [pattern, strings that must be flagged, strings that must pass]. Each string is planted
// in memory only; no committed fixture holds any of them.
const PATTERN_CASES = [
  ["/root", ["/root/.ssh/id", "cwd=/root/x", '"/root/"'], ["a/root/b", "S1", "rootless"]],
  ["/Volumes/", ["/Volumes/Backup/x", "cwd=/Volumes/Disk"], ["/Volumes", "a/Volumes/b"]],
  [
    "/private/var/folders/",
    ["/private/var/folders/ab/cd/T/x", "x=/private/var/folders/q"],
    ["/private/var", "/private/tmp/x"]
  ],
  [
    "Documents and Settings",
    [
      "C:\\Documents and Settings\\bob",
      "D:/Documents and Settings/bob",
      "C:\\\\Documents and Settings"
    ],
    ["Documents and Settings", "my Documents and Settings notes"]
  ],
  [
    "url-encoded paths",
    ["%2FUsers%2Fbob", "%2fusers%2fbob", "%2Fhome%2Fbob", "x=%2Fhome%2Fuser%2Fdemo"],
    ["%2FUsersx", "%2Fhomes%2F", "%2Ftmp%2Fx"]
  ],
  [
    "email addresses",
    ["someone@example.test", "a.b+c@sub-d.example.org", "mailto:x_y@host.io"],
    ["@scope/pkg", "name@host", "a @ b.c", "S1"]
  ],
  [
    "github tokens",
    [
      "ghp_" + "a1".repeat(18),
      "gho_" + "Z".repeat(30),
      "github_pat_" + "A1b2".repeat(8),
      "token ghs_" + "x".repeat(25),
      "ghp_" + "a".repeat(20) // the shortest length the pattern flags
    ],
    [
      "ghp_short",
      "github_pat_short",
      "ghp-" + "a".repeat(30),
      "toolu_ab12cd34",
      "ghp_" + "a".repeat(19)
    ]
  ],
  ["tilde paths", ["~/projects/x", "cd ~/.ssh", "(~/notes)", "~/"], ["~", "a~/b", "S1~", "~user"]]
];

for (const [label, bad, ok] of PATTERN_CASES) {
  test("path pattern: " + label, () => {
    for (const s of bad) assert.ok(FORBIDDEN.test(s), "must be flagged: " + s);
    for (const s of ok) assert.ok(!FORBIDDEN.test(s), "must pass: " + s);
  });
}

// Trailing-slash-free forms and the two extra encodings, each with a positive and a negative case.
const FORM_CASES = [
  [
    "/root without a slash",
    ["/root", "cd /root", "x=/root;", '"/root"', "/root.bak"],
    ["a/root", "rootless", "/rootless", "/roots", "a/root/b"]
  ],
  [
    "/Users without a slash",
    ["/Users", "cwd=/Users", "(/Users)", "/Users."],
    ["/Usersx", "a/Users", "/UsersGuide", "Users"]
  ],
  [
    "/private/var/folders without a slash",
    ["/private/var/folders", "x=/private/var/folders;", "/private/var/folders\n"],
    ["/private/var/foldersx", "/private/var", "a/private/varfolders"]
  ],
  [
    "~user paths",
    ["~bob/x", "cd ~alice/.ssh", "(~bob/x)", "~_svc/y"],
    ["~bob", "a~bob/x", "~5/10", "~bob x/y"]
  ],
  [
    "url-encoded backslash paths",
    ["C%3A%5CUsers%5Cx", "c%3a%5cusers", "%5CUsers%5Cbob", "D%3A%2FUsers%2Fx", "x=C%3A%5C%5CUsers"],
    ["C%3A%5CProjects", "%5CUsersx%5C", "C%3A%5CWindows", "%5Ctmp%5Cx"]
  ]
];

for (const [label, bad, ok] of FORM_CASES) {
  test("path form: " + label, () => {
    for (const s of bad) assert.ok(FORBIDDEN.test(s), "must be flagged: " + s);
    for (const s of ok) assert.ok(!FORBIDDEN.test(s), "must pass: " + s);
  });
}

test(
  "the email pattern scans a long run of word characters in linear time",
  { timeout: 10000 },
  () => {
    // Generous bound: the old unanchored form took minutes on this input, this one takes ms.
    for (const unit of ["a", "a.", "a-b+"]) {
      const run = unit.repeat(Math.ceil(400000 / unit.length));
      const t0 = Date.now();
      assert.ok(!FORBIDDEN.test(run), "a long run holds no forbidden text");
      assert.ok(Date.now() - t0 < 2000, "scan of " + run.length + " chars took too long");
    }
  }
);

test("each new pattern also trips the JSON content scan, even when escaped", () => {
  for (const [label, bad] of PATTERN_CASES) {
    const s = bad[0];
    assert.ok(findHit("x.jsonl", JSON.stringify({ a: s }) + "\n"), label + " raw");
    const hidden = '{"a":"' + uEscape(s) + '"}';
    assert.ok(findHit("x.jsonl", hidden), label + " escaped");
  }
});

test("a key literally named k_PLANTED is reported as an unknown key", () => {
  const { KNOWN_KEYS } = require("../../scripts/sanitize-claude-transcript.js");
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-kplanted-"));
  try {
    const put = (name, body) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "k.jsonl"), body);
      return dir;
    };
    for (const key of [
      "k_PLANTED",
      "k_planted",
      "k_0123456789a",
      "k_0123456789abc",
      "K_0123456789ab"
    ]) {
      const dir = put("bad-" + key, '{"type":1}\n{"' + key + '":1}\n');
      assert.throws(
        () => checkKeys(dir, FORBIDDEN, KNOWN_KEYS),
        (err) => err instanceof assert.AssertionError && err.message.includes("unknown keys (1)"),
        key
      );
    }
    // a real hashed key passes
    checkKeys(put("good", '{"type":1}\n{"k_0123456789ab":1}\n'), FORBIDDEN, KNOWN_KEYS);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- every string value is on the sanitizer's allowlist ------------------------------------

const SAN = require("../../scripts/sanitize-claude-transcript.js");
const HEX_ID = /^[0-9a-f]{8,40}$/; // hashId: digest slice(0, 8..40)
const UUID_OUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // hashId, uuid input
const PREFIX_REST = /^[0-9a-f]{8,24}$/; // hashId: prefix (SAN.ID_PREFIX_RE) + digest slice(0, 8..24)
/** Exactly what hashId can emit: hex, a uuid, prefix + hex, or the neutral agent name aN. */
function idShape(v) {
  if (HEX_ID.test(v) || UUID_OUT.test(v) || /^a[1-9]\d*$/.test(v)) return true;
  const p = SAN.ID_PREFIX_RE.exec(v);
  return !!p && PREFIX_REST.test(v.slice(p[0].length));
}
/** In a notification the id tags hold hashId output, or S1 when the tag is missing. */
const idOk = (v) => v === SAN.PLACEHOLDER || idShape(v);

/** A <task-notification> exactly as the sanitizer rebuilds it, nothing else. */
function notificationOk(v) {
  const lines = v.split("\n");
  const fixed = [
    ["<output-file>", "S1", "</output-file>"],
    null, // status
    ["<summary>", "S1", "</summary>"],
    ["<note>", "S1", "</note>"],
    ["<result>", "S1", "</result>"]
  ];
  if (
    lines.length !== 10 ||
    lines[0] !== "<task-notification>" ||
    lines[9] !== "</task-notification>"
  ) {
    return false;
  }
  for (const [i, tag] of [
    [1, "task-id"],
    [2, "tool-use-id"]
  ]) {
    const m = new RegExp("^<" + tag + ">(.*)</" + tag + ">$").exec(lines[i]);
    if (!m || !idOk(m[1])) return false;
  }
  const status = /^<status>(.*)<\/status>$/.exec(lines[4]);
  if (!status || (status[1] !== "S1" && !SAN.KNOWN_ENUM_VALUES.has(status[1]))) return false;
  for (const [i, j] of [
    [3, 0],
    [5, 2],
    [6, 3],
    [7, 4]
  ]) {
    if (lines[i] !== fixed[j].join("")) return false;
  }
  return /^<usage>(<(subagent_tokens|total_tokens|tool_uses|duration_ms)>\d+<\/\2>)*<\/usage>$/.test(
    lines[8]
  );
}

/** A <task-notification> in the exact shape the sanitizer writes; `patch` swaps lines by index. */
const notif = (patch = {}) => {
  const lines = [
    "<task-notification>",
    "<task-id>a1</task-id>",
    "<tool-use-id>toolu_0123456789ab</tool-use-id>",
    "<output-file>S1</output-file>",
    "<status>completed</status>",
    "<summary>S1</summary>",
    "<note>S1</note>",
    "<result>S1</result>",
    "<usage><tool_uses>4</tool_uses></usage>",
    "</task-notification>"
  ];
  for (const [i, v] of Object.entries(patch)) lines[i] = v;
  return lines.join("\n");
};

// Known sanitizer limit, not fixed here: minTimestamp counts a date-only string such as 2025-05-05 toward the earliest baseline while shiftTs turns that string into S1.
const ISO_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const TS_WINDOW_MS = 2 * 3600 * 1000; // fixtures span one hour after BASE_TS

// Limit: on genuine id keys and under hashed k_<12 hex> keys, a hashed id and a real one are
// both random hex, so this check cannot tell them apart. It only pins where id-shaped values
// may sit.

/**
 * Keys under which the sanitizer writes id-shaped values: its own idKey (walkString runs
 * hashId there) and its hashed key k_<12 hex> (the child is walked under the original key).
 * toolu_/msg_ keys are renamed by hashKey but their child is walked under the original
 * key, which is no id key, so those hold S1 and never an id.
 */
const idKeyOk = (k) => typeof k === "string" && (SAN.idKey(k) || /^k_[0-9a-f]{12}$/.test(k));

/** True if the sanitizer could have written this string value under this key. */
function allowedValue(v, key) {
  // walkString answers every string on a genuine id key with hashId: never S1, never ""
  if (typeof key === "string" && SAN.idKey(key)) return idShape(v);
  if (v === SAN.PLACEHOLDER || v === "") return true;
  if (v.startsWith("<task-notification>")) return notificationOk(v);
  if (SAN.KNOWN_ENUM_VALUES.has(v) || SAN.KNOWN_AGENT_TYPES.has(v) || SAN.BUILTIN_TOOLS.has(v)) {
    return true;
  }
  if (SAN.MODEL_RE.test(v) || SAN.DOCS_TOOL_RE.test(v)) return true;
  if (/^custom(-tool)?-\d+$/.test(v) || /^mcp__s1__[0-9a-f]{12}$/.test(v)) return true;
  if (idShape(v)) return idKeyOk(key);
  if (ISO_TS.test(v)) {
    const t = Date.parse(v);
    return key === "timestamp" && t >= SAN.BASE_TS && t <= SAN.BASE_TS + TS_WINDOW_MS;
  }
  if (/^(S1 )+S1$/.test(v)) return true; // the synthetic oversize filler
  if (v === "oversize" || v === "partial-usage") return true; // _synthetic markers
  return false;
}

/**
 * Throws naming the masked file and line only (never the offending value). An unparseable
 * line fails; the one cut-off tail line is checked on its complete string literals.
 */
function checkValues(root, re) {
  const bad = [];
  for (const e of walk(root).filter((x) => !x.dir && /\.jsonl?$/.test(x.name))) {
    const f = parseFile(e.name, fs.readFileSync(e.full, "utf8"));
    const isLines = e.name.endsWith(".jsonl");
    const at = (line) => safePath(path.relative(root, e.full), re) + (isLines ? ":" + line : "");
    f.bad.forEach((line) => bad.push(at(line)));
    for (const d of f.docs) {
      const strings = [];
      (function values(v, key) {
        if (typeof v === "string") strings.push([v, key]);
        else if (Array.isArray(v))
          v.forEach((x) => values(x, key)); // an array keeps its parent key
        else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => values(x, k));
      })(d.value);
      if (strings.some(([s, k]) => !allowedValue(s, k))) bad.push(at(d.line));
    }
    if (f.tail) {
      let key;
      for (const l of f.tail.literals) {
        if (l.isKey) key = l.value;
        else if (!allowedValue(l.value, key)) {
          bad.push(at(f.tail.line));
          break;
        }
      }
    }
  }
  assert.equal(
    bad.length,
    0,
    "string values off the sanitizer allowlist (" + bad.length + "): " + bad.join("; ")
  );
}

test("every string value in the fixtures is on the sanitizer's allowlist", () => {
  assert.ok(walk(ROOT).filter((e) => !e.dir && /\.jsonl?$/.test(e.name)).length >= 5);
  checkValues(ROOT, FORBIDDEN);
});

/**
 * Throws naming the fixture folder only: the earliest timestamp in each project folder under
 * `root` must be BASE_TS, and no file in it may fail to parse (see parseFile). Returns how many
 * folders had timestamps.
 */
function checkEarliest(root) {
  const wrong = [];
  const unparseable = [];
  let checked = 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    let earliest = Infinity;
    let broken = false;
    const take = (key, v) => {
      if (key === "timestamp" && typeof v === "string" && ISO_TS.test(v)) {
        earliest = Math.min(earliest, Date.parse(v));
      }
    };
    for (const e of walk(path.join(root, d.name))) {
      if (e.dir || !(e.name.endsWith(".jsonl") || e.name.endsWith(".json"))) continue;
      const f = parseFile(e.name, fs.readFileSync(e.full, "utf8"));
      if (f.bad.length) broken = true;
      for (const doc of f.docs) {
        (function scan(v, key) {
          if (typeof v === "string") take(key, v);
          else if (Array.isArray(v)) v.forEach((x) => scan(x, key));
          else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => scan(x, k));
        })(doc.value);
      }
      if (f.tail) {
        let key;
        for (const l of f.tail.literals) {
          if (l.isKey) key = l.value;
          else take(key, l.value);
        }
      }
    }
    if (broken) unparseable.push(d.name);
    if (earliest === Infinity) continue; // no timestamps in this folder
    checked++;
    if (earliest !== SAN.BASE_TS) wrong.push(d.name);
  }
  assert.equal(
    wrong.length + unparseable.length,
    0,
    "earliest timestamp is not the sanitizer base in: " +
      wrong.join("; ") +
      " | unparseable file in: " +
      unparseable.join("; ")
  );
  return checked;
}

/** checkEarliest over every project folder under every group folder of `root` (ROOT/real, ...). */
function checkEarliestTree(root) {
  let checked = 0;
  for (const g of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    checked += checkEarliest(path.join(root, g.name));
  }
  return checked;
}

test("the earliest timestamp in each fixture is exactly the sanitizer's base", () => {
  assert.equal(new Date(SAN.BASE_TS).toISOString(), "2026-01-01T00:00:00.000Z");
  assert.ok(checkEarliestTree(ROOT) >= 2);
});

test("the earliest-timestamp check flags a shifted base and passes the exact one", () => {
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-earliest-"));
  try {
    const put = (name, lines) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "a.jsonl"),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
      );
    };
    put("late", [
      { timestamp: "2026-01-01T00:00:01.000Z" },
      { timestamp: "2026-01-01T00:00:09.000Z" }
    ]);
    assert.throws(() => checkEarliest(base), /late/);
    fs.rmSync(path.join(base, "late"), { recursive: true });
    put("early", [{ timestamp: "2025-12-31T23:59:59.000Z" }]);
    assert.throws(() => checkEarliest(base), /early/);
    fs.rmSync(path.join(base, "early"), { recursive: true });
    put("exact", [
      { timestamp: "2026-01-01T00:00:03.000Z" },
      { timestamp: "2026-01-01T00:00:00.000Z" }
    ]);
    assert.equal(checkEarliest(base), 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the allowlist check flags what the sanitizer would never write, and passes what it would", () => {
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-values-"));
  try {
    const planted = "zq-planted-value";
    const put = (name, rel, body) => {
      const dir = path.join(base, name);
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
      return dir;
    };
    const bads = {
      plain: { cwd: planted },
      "free text on a type key": { type: planted },
      "real-looking model": { model: "claude-" + planted },
      "unknown agent": { agentType: planted },
      "unshifted timestamp": { timestamp: "2025-05-05T10:00:00.000Z" },
      "2026-11 timestamp": { timestamp: "2026-11-12T09:15:00.000Z" },
      "timestamp just past the window": { timestamp: "2026-01-01T02:00:00.001Z" },
      "iso on cwd": { cwd: "2026-01-01T00:00:05.000Z" },
      "hex40 on command": { command: "0123456789abcdef0123456789abcdef01234567" },
      "hex repeated in text": {
        message: { content: [{ type: "text", text: "deadbeef".repeat(4) }] }
      },
      "uuid on cwd": { cwd: "6f1c2a3b-1111-4222-8333-944455556666" },
      "toolu in text": { text: "toolu_0123456789abcdef" },
      "msg id on cwd": { cwd: "msg_0123456789abcdef" },
      "agent-style id on text": { text: "a42" },
      "hex40 under a tool-id key": {
        toolu_0123456789ab: "0123456789abcdef0123456789abcdef01234567"
      },
      "uuid under a msg id key": { msg_0123456789ab: "6f1c2a3b-1111-4222-8333-944455556666" },
      "raw toolu id on an id key": { toolUseID: "toolu_01A9bCdEfGhIjKlMnOpQrStU" },
      "agent-style name with a tail on an id key": { agentId: "a1x" },
      "zero agent name on an id key": { agentId: "a0" },
      "empty string on an id key": { sessionId: "" },
      "placeholder on an id key": { sessionId: "S1" },
      "hex40 on cwd": { cwd: "0123456789abcdef0123456789abcdef01234567" },
      // hashId slices a sha1 digest to 8..40 hex, so 41+ and under 8 can never be written
      "hex64 on an id key": { sessionId: "0123456789abcdef".repeat(4) },
      "hex41 on an id key": { sessionId: "0123456789abcdef0123456789abcdef012345678" },
      "hex7 on an id key": { sessionId: "0123456" },
      "uppercase hex on an id key": { sessionId: "0123456789ABCDEF" },
      "prefixed id with 25 hex": {
        toolUseID: "toolu_" + "0123456789abcdef".repeat(2).slice(0, 25)
      },
      "notification with a free-text task id": {
        content: [
          "<task-notification>",
          "<task-id>" + planted + "</task-id>",
          "<tool-use-id>toolu_0123456789ab</tool-use-id>",
          "<output-file>S1</output-file>",
          "<status>completed</status>",
          "<summary>S1</summary>",
          "<note>S1</note>",
          "<result>S1</result>",
          "<usage><tool_uses>4</tool_uses></usage>",
          "</task-notification>"
        ].join(String.fromCharCode(10))
      },
      "non-hex id": { uuid: planted },
      nested: { message: { content: [{ type: "text", text: planted }] } },
      "forged notification": {
        content: "<task-notification>\n<summary>" + planted + "</summary>\n</task-notification>"
      },
      "notification with a free-text summary": { content: notif({ 5: "<summary>zq</summary>" }) },
      "notification with a free-text status": {
        content: notif({ 4: "<status>plantedword</status>" })
      },
      "notification with free-text usage": { content: notif({ 8: "<usage>zq</usage>" }) },
      "notification with an 11th line": { content: notif() + "\nzq" },
      "S1 with a tail": { cwd: "S1zq" },
      "S1 words with a tail": { cwd: "S1 S1 zq" },
      "free-text name": { name: "zq" },
      "unmapped mcp tool name": { name: "mcp__realsrv__tool" },
      "uuid with a tail": { uuid: "01234567-89ab-4cde-8f01-23456789abcd/zq" },
      "uppercase uuid": { uuid: "01234567-89AB-4CDE-8F01-23456789ABCD" },
      "prefixed id with 7 hex": { toolUseID: "toolu_0123456" },
      "timestamp 1 ms before the base": { timestamp: "2025-12-31T23:59:59.999Z" }
    };
    for (const [label, obj] of Object.entries(bads)) {
      const dir = put(
        "bad-" + label.replace(/\W/g, "-"),
        "a.jsonl",
        '{"type":"user"}\n' + JSON.stringify(obj) + "\n"
      );
      assert.throws(
        () => checkValues(dir, FORBIDDEN),
        (err) =>
          err instanceof assert.AssertionError &&
          err.message.includes("a.jsonl:2") &&
          !err.message.includes(planted),
        label
      );
    }
    const good = {
      type: "user",
      cwd: "S1",
      model: "claude-opus-4-8",
      agentType: "custom-2",
      name: "mcp__s1__0123456789ab",
      timestamp: "2026-01-01T00:00:05.000Z",
      toolUseID: ["a1", "a2"],
      k_0123456789ab: "0123456789abcdef0123456789abcdef01234567",
      uuid: "01234567-89ab-4cde-8f01-23456789abcd",
      id: "toolu_0123456789abcdef",
      agentId: "a1",
      sessionId: "0123456789abcdef0123456789abcdef01234567", // 40 hex: the longest hashId output
      content:
        "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_0123456789ab</tool-use-id>\n" +
        "<output-file>S1</output-file>\n<status>completed</status>\n<summary>S1</summary>\n" +
        "<note>S1</note>\n<result>S1</result>\n<usage><tool_uses>4</tool_uses></usage>\n</task-notification>"
    };
    checkValues(put("good", "g.jsonl", JSON.stringify(good) + "\n"), FORBIDDEN);
    // a timestamp 1h59m after the base is inside the window
    checkValues(
      put("late-ok", "t.jsonl", JSON.stringify({ timestamp: "2026-01-01T01:59:00.000Z" }) + "\n"),
      FORBIDDEN
    );
    // the real fixtures' shape: a cut-off last line (no trailing newline) with only allowed strings
    checkValues(put("cut", "c.jsonl", '{"type":"user"}\n{"cwd":"S1","ty'), FORBIDDEN);
    // an open string at the cut holds nothing complete to check (the raw scan covers owner words)
    checkValues(put("cut-open", "o.jsonl", '{"type":"user"}\n{"cwd":"' + planted), FORBIDDEN);
    // a complete planted string inside the cut-off line fails
    assert.throws(
      () =>
        checkValues(
          put("cut-bad", "c.jsonl", '{"type":"user"}\n{"cwd":"' + planted + '","ty'),
          FORBIDDEN
        ),
      (err) =>
        err instanceof assert.AssertionError &&
        err.message.includes("c.jsonl:2") &&
        !err.message.includes(planted),
      "cut-off line with a planted complete value"
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- round 4: parse failures, file types, more path forms, key bounds -------------------------

test("the notification helper builds exactly what the allowlist accepts", () => {
  assert.ok(notificationOk(notif()));
  assert.ok(!notificationOk(notif({ 5: "<summary>zq</summary>" })));
});

/** The real file-type check: every file must end in lowercase .jsonl or .json. */
function checkFileTypes(root) {
  const bad = walk(root)
    .filter((e) => !e.dir && !/\.jsonl?$/.test(e.name))
    .map((e) => safePath(path.relative(root, e.full)));
  assert.equal(bad.length, 0, "not a lowercase .jsonl/.json file (" + bad.length + "): " + bad);
}

test("every fixture file ends in lowercase .jsonl or .json", () => {
  checkFileTypes(ROOT);
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-types-"));
  try {
    let n = 0;
    const one = (name) => {
      const dir = path.join(base, "d" + n++);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, name), "{}\n");
      return dir;
    };
    for (const name of ["a.JSONL", "a.Json", "a.ndjson", "noext", "a.jsonl.bak", "a.json5"]) {
      assert.throws(
        () => checkFileTypes(one(name)),
        (err) => err instanceof assert.AssertionError && err.message.includes(name),
        name
      );
    }
    for (const name of ["a.jsonl", "a.json", "agent-a1.meta.json"]) checkFileTypes(one(name));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// [label, strings that must be flagged, strings that must pass]; one case per pattern added in round 4.
const NEW_CASES = [
  [
    "/c/Users and /cygdrive/<x>/Users",
    ["/c/Users/bob", "cwd=/c/Users", "/cygdrive/d/Users/x", "/C/Users", "(/c/Users)"],
    ["/c/Usersx", "/cc/Users", "c/Users", "/cygdrive/Users", "S1"]
  ],
  [
    "drive-less \\Users\\",
    ["\\Users\\bob", "x \\Users\\bob", "\\\\Users\\\\bob", '"\\Users\\x"'],
    ["a\\Users\\x", "\\Users", "\\Usersx\\", "Users\\x"]
  ],
  [
    "/var/folders",
    ["/var/folders/zz/T/x", "x=/var/folders", "(/var/folders)"],
    ["/var/foldersx", "/var/lib/x", "/var"]
  ],
  [
    "//wsl forward-slash form",
    ["//wsl$/Ubuntu/home", "//wsl.localhost/Ubuntu", "//WSL$/x", "\\/wsl$/x"],
    ["http://wslfoo.example", "//wslx", "/wsl$/x", "//wsl"]
  ],
  [
    "UNC \\\\server\\share",
    [
      "\\\\server\\share",
      "\\\\localhost\\C$",
      "x=\\\\fileserver\\share\\dir",
      "\\\\\\\\srv\\\\share",
      "\\\\ab\\cd",
      "\\\\\\\\ab\\\\cd"
    ],
    [
      "a\\\\server\\share",
      "\\\\",
      "\\\\server",
      "//server/share",
      "C:\\\\x",
      "S1\\\\x",
      "\\r\\n",
      "\\\\r\\\\n",
      "\\n\\t",
      "\\\\n\\\\t",
      "\\\\a\\cd",
      "\\\\ab\\c"
    ]
  ],
  ["~\\ tilde paths", ["~\\x", "cd ~\\Documents", "~bob\\x"], ["a~\\b", "~", "~5\\x", "~bob x\\y"]],
  [
    "%40 inside email-like strings",
    ["user%40example.test", "a.b%40sub-d.example.org", "mailto:x_y%40host.io", "x%40y.z"],
    ["%40scope/pkg", "name%40host", "100%40", "a %40 b.c"]
  ]
];

for (const [label, bad, ok] of NEW_CASES) {
  test("path form: " + label, () => {
    for (const s of bad) assert.ok(FORBIDDEN.test(s), "must be flagged: " + s);
    for (const s of ok) assert.ok(!FORBIDDEN.test(s), "must pass: " + s);
  });
}

test("every round-4 pattern also trips the JSON content scan, even when escaped", () => {
  for (const [label, bad] of NEW_CASES) {
    assert.ok(findHit("x.jsonl", JSON.stringify({ a: bad[0] }) + "\n"), label + " raw");
    assert.ok(findHit("x.jsonl", '{"a":"' + uEscape(bad[0]) + '"}'), label + " escaped");
  }
});

test(
  "the backslash, slash, tilde and percent patterns scan long runs in linear time",
  { timeout: 10000 },
  () => {
    // Generous bound: a quadratic form takes many seconds on 100k characters, a linear one takes ms.
    const bs = "\\";
    for (const unit of [bs, bs + "a", "/", "/a", "~", "~a", "%", "%4", "a@", "a.", "-"]) {
      const run = unit.repeat(Math.ceil(100000 / unit.length));
      const t0 = Date.now();
      assert.ok(!FORBIDDEN.test(run), "a long run of " + unit.length + "-char units holds no hit");
      assert.ok(Date.now() - t0 < 2000, "scan of " + run.length + " chars took too long");
    }
    const t0 = Date.now();
    assert.ok(FORBIDDEN.test(bs.repeat(100000) + "wsl"), "a backslash run before wsl is flagged");
    assert.ok(FORBIDDEN.test(bs.repeat(100000) + "Users" + bs), "a backslash run before Users");
    assert.ok(Date.now() - t0 < 2000, "scan of a 100k-backslash run before a hit took too long");
  }
);

test("a line that does not parse fails every JSON check; only a cut-off last line is tolerated", () => {
  const { KNOWN_KEYS } = SAN;
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-parse-"));
  try {
    let n = 0;
    const tree = (rel, body) => {
      const dir = path.join(base, "t" + n++);
      fs.mkdirSync(path.dirname(path.join(dir, "proj", rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, "proj", rel), body);
      return dir;
    };
    const isAssert = (err) => err instanceof assert.AssertionError && !err.message.includes("zq");
    const checks = [
      ["values", (d) => checkValues(d, FORBIDDEN)],
      ["keys", (d) => checkKeys(d, FORBIDDEN, KNOWN_KEYS)],
      ["earliest", (d) => checkEarliest(d)],
      ["contents", (d) => checkContents(d, FORBIDDEN)]
    ];
    const bads = [
      ["trailing comma mid-file", "a.jsonl", '{"type":"user"}\n{"cwd":"zq",}\n{"type":"user"}\n'],
      ["unparseable meta.json", "x.meta.json", '{"a":1,}\n'],
      ["BOM first line", "b.jsonl", BOM + '{"type":"user"}\n'],
      ["BOM on a later line", "b.jsonl", '{"type":"user"}\n' + BOM + '{"type":"user"}\n'],
      ["cut-off line then a newline", "c.jsonl", '{"type":"user"}\n{"cwd":"S1","ty\n'],
      ["two cut-off lines", "c.jsonl", '{"type":"user"}\n{"cwd":"S1","ty\n{"cwd":"S1","ty'],
      ["invalid escape in the tail", "c.jsonl", '{"type":"user"}\n{"cwd":"\\x"}'],
      ["BOM, one complete line, no newline", "d.jsonl", BOM + '{"type":"user"}'],
      ["cut-off .json", "x.meta.json", '{"type":"user","ty'],
      ["BOM, one cut-off line, no newline", "d.jsonl", BOM + '{"cwd":"S1","ty'],
      [
        "tail: text after a string",
        "c.jsonl",
        '{"type":"user"}\n{"cwd":"S1", zq private project notes'
      ],
      [
        "tail: text after an object",
        "c.jsonl",
        '{"type":"user"}\n{"type":"user"} zq private notes {"ty'
      ],
      ["tail: free text only", "c.jsonl", '{"type":"user"}\nzq this is free text'],
      ["tail: unquoted key", "c.jsonl", '{"type":"user"}\n{"type":"user",zqkey:1,"ty'],
      ["tail: space before a colon", "c.jsonl", '{"type":"user"}\n{"type":"user","badkey" : 1,"ty']
    ];
    for (const [label, rel, body] of bads) {
      for (const [what, run] of checks) {
        assert.throws(() => run(tree(rel, body)), isAssert, label + " / " + what);
      }
      assert.ok(findHit(rel, body), label + " / findHit");
    }
    // the accepted shape: one cut-off last line, no trailing newline
    const cut = '{"type":"user"}\n{"cwd":"S1","ty';
    for (const [, run] of checks) run(tree("c.jsonl", cut));
    assert.equal(findHit("c.jsonl", cut), null);
    // the tail's complete strings are still checked, as keys, as dates and as hidden paths
    assert.throws(
      () =>
        checkKeys(
          tree("c.jsonl", '{"type":"user"}\n{"type":"user","badkey":1,"ty'),
          FORBIDDEN,
          KNOWN_KEYS
        ),
      isAssert,
      "tail key"
    );
    assert.throws(
      () =>
        checkEarliest(
          tree(
            "c.jsonl",
            '{"timestamp":"2026-01-01T00:00:00.000Z"}\n{"timestamp":"2025-12-31T23:59:59.000Z","ty'
          )
        ),
      (err) => err instanceof assert.AssertionError && err.message.includes("proj"),
      "tail timestamp"
    );
    const esc = uEscape("C:\\Users\\someone");
    assert.ok(findHit("c.jsonl", '{"ok":1}\n{"cwd":"' + esc + '","ty'), "tail escaped path");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the earliest-timestamp check covers every group folder, not just real", () => {
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-groups-"));
  try {
    const put = (rel, ts) => {
      const file = path.join(base, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ timestamp: ts }) + "\n");
    };
    put("real/p1/a.jsonl", "2026-01-01T00:00:00.000Z");
    assert.equal(checkEarliestTree(base), 1);
    put("other/late/a.jsonl", "2026-01-01T00:00:01.000Z");
    assert.throws(() => checkEarliestTree(base), /late/);
    put("other/late/a.jsonl", "2026-01-01T00:00:00.000Z");
    assert.equal(checkEarliestTree(base), 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("hashed toolu_/msg_ keys carry 8 to 24 lowercase hex, no more and no less", () => {
  const { KNOWN_KEYS } = SAN;
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-idkeys-"));
  try {
    const hex = "0123456789abcdef0123456789abcdef";
    let n = 0;
    const put = (key) => {
      const dir = path.join(base, "d" + n++);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "k.jsonl"), '{"type":1}\n{"' + key + '":1}\n');
      return dir;
    };
    for (const p of ["toolu_", "msg_"]) {
      for (const len of [8, 24]) checkKeys(put(p + hex.slice(0, len)), FORBIDDEN, KNOWN_KEYS);
      for (const key of [p + hex.slice(0, 7), p + hex.slice(0, 25), p + "0123456789AB", p + "zz"]) {
        assert.throws(
          () => checkKeys(put(key), FORBIDDEN, KNOWN_KEYS),
          (err) => err instanceof assert.AssertionError && err.message.includes("unknown keys (1)"),
          key
        );
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a cut-off tail may hold only JSON-prefix structure", () => {
  for (const ok of [
    "{",
    '{"a":-',
    '{"a":1.',
    '{"a":1e',
    '{"a":1.5e+',
    '{"a":tr',
    '{"a":fals',
    '{"a":nul',
    '{"a":[1,2',
    '{"a":"x","b":{"c":0',
    '{"a":"x","b":"op',
    '{"a":"x\\',
    '{"a":"x\\"',
    '{"a":true,"b":f',
    " {",
    '{"a":1 ,"b',
    '{"a" : 1,',
    '{"a":1,\t"b',
    '{"a":1\r'
  ]) {
    assert.ok(tailShapeOk(ok), "must pass: " + ok);
  }
  for (const bad of [
    '{"a":1}x',
    '{"a":tx',
    '{"a":truee',
    '{"a":nulll',
    '{"a":1.5.',
    '{"a":.5',
    '{"a":0x',
    '{"a":-}',
    '{"a":"b"c"',
    "zq",
    "{zqkey:1,",
    '{"a":1.,'
  ]) {
    assert.ok(!tailShapeOk(bad), "must fail: " + bad);
  }
});

test("the tail shape check scans long runs in linear time", { timeout: 10000 }, () => {
  // Small cases first: the timeout cannot stop a synchronous regex, so a regression must fail
  // here in seconds, not hang on the long runs below. Without (?!\d) in TAIL_OK, 29 digits
  // take seconds (exponential); the old literal scan in tailLiterals restarted at every
  // escaped quote of an open string (quadratic) and took seconds on 120k characters.
  const tDigits = Date.now();
  tailShapeOk('{"k":' + "1".repeat(29) + "z");
  assert.ok(Date.now() - tDigits < 1000, "29 digits took too long");
  const quotes = '{"type":"user"}\n{"cwd":"' + '\\"'.repeat(60000);
  const t2 = Date.now();
  assert.equal(parseFile("c.jsonl", quotes).bad.length, 0, "an open string of escaped quotes");
  assert.ok(Date.now() - t2 < 1000, "parseFile on an open string of escaped quotes took too long");
  for (const [run, end] of [
    ["1", "z"],
    ["1,", "z"],
    ["1.", "z"],
    ["1e", "z"],
    ['"a"', "z"],
    ["{", "z"]
  ]) {
    const text = '{"k":' + run.repeat(200000) + end;
    const t0 = Date.now();
    tailShapeOk(text);
    assert.ok(Date.now() - t0 < 2000, "tail scan of " + text.length + " chars took too long");
  }
  const open = '{"k":"' + "\\a".repeat(200000);
  const t1 = Date.now();
  assert.ok(tailShapeOk(open), "a long open string passes");
  assert.ok(Date.now() - t1 < 2000, "open-string tail scan took too long");
});

test("a model-slug-shaped key must be a real family exactly", () => {
  const { KNOWN_KEYS } = SAN;
  const scratch = path.join(__dirname, "..", "..", ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, "privacy-slugs-"));
  try {
    let n = 0;
    const put = (key) => {
      const dir = path.join(base, "d" + n++);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "k.jsonl"), '{"type":1}\n{"' + key + '":1}\n');
      return dir;
    };
    for (const key of ["claude-opus-4-8", "claude-haiku-4-5-20251001", "opus"]) {
      checkKeys(put(key), FORBIDDEN, KNOWN_KEYS);
    }
    for (const key of ["claude-zq", "claude-opus-4-8-zq"]) {
      assert.throws(
        () => checkKeys(put(key), FORBIDDEN, KNOWN_KEYS),
        (err) => err instanceof assert.AssertionError && err.message.includes("unknown keys (1)"),
        key
      );
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a cut-off tail's keys must be allowed keys, whatever the spacing", () => {
  const head = '{"type":"user"}\n';
  const bad = (tail) => parseFile("c.jsonl", head + tail).bad.length;
  for (const ok of [
    '{"type":"user","ty',
    '{"type" : "user","ty',
    '{"type"\t:"user","ty',
    '{"k_0123456789ab":1,"ty',
    '{"toolu_0123456789ab":1,"ty',
    '{"claude-opus-4-8":{"type":0,"ty',
    '{"cwd":"S1","ty'
  ]) {
    assert.equal(bad(ok), 0, "must pass: " + ok);
  }
  for (const nope of [
    '{"badkey":1,"ty',
    '{"badkey" : 1,"ty',
    '{"badkey"\t:1,"ty',
    '{"k_0123456789a":1,"ty',
    '{"claude-zq":1,"ty',
    '{"claude-opus-4-8-zq" : 1,"ty'
  ]) {
    assert.equal(bad(nope), 1, "must fail: " + nope);
  }
  // a string that is a value, not a key, is not held to the key rule
  assert.equal(bad('{"cwd":"badkey","ty'), 0);
});
