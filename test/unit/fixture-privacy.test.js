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

/**
 * First forbidden hit in a file's text as { match, line } (1-based line), or null.
 * Failure messages must use `line` only: `match` can be an owner word and CI logs are public.
 */
function findHit(fileName, text, re = FORBIDDEN) {
  const raw = re.exec(text);
  if (raw) return { match: raw[0], line: text.slice(0, raw.index).split("\n").length };
  if (!/\.jsonl?$/.test(fileName)) return null;
  const isLines = fileName.endsWith(".jsonl");
  const chunks = isLines ? text.split("\n") : [text];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue; // unparseable (cut-off) line: the raw scan above already covered it
    }
    for (const str of decodedStrings(parsed)) {
      const m = re.exec(str);
      if (m) return { match: m[0], line: isLines ? i + 1 : literalLine(text, re) };
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
 * The real key check: throws if any object key is not a KNOWN_KEYS key, a hashed k_<12 hex>
 * or a hashed id. Every path and key goes through safePath, and the asserted value is the
 * count (not the raw list), so assert's diff cannot print an unmasked key or path.
 */
function checkKeys(root, re, knownKeys) {
  const files = walk(root).filter((e) => !e.dir && /\.jsonl?$/.test(e.name));
  const bad = [];
  for (const e of files) {
    const text = fs.readFileSync(e.full, "utf8");
    const isLines = e.name.endsWith(".jsonl");
    const chunks = isLines ? text.split("\n") : [text];
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i]) continue;
      let parsed;
      try {
        parsed = JSON.parse(chunks[i]);
      } catch {
        continue; // the deliberately cut-off tail
      }
      for (const k of allKeys(parsed)) {
        if (knownKeys.has(k) || /^k_[0-9a-f]{12}$/.test(k) || /^(toolu|msg)_[0-9a-f]+$/.test(k)) {
          continue;
        }
        const where = safePath(path.relative(root, e.full), re) + (isLines ? ":" + (i + 1) : "");
        bad.push(where + ": " + safePath(k, re));
      }
    }
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
