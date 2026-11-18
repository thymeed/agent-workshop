/**
 * Tests for lib/claude-code-ingest.js. Sessions are copies of the sanitized fixtures placed
 * in a project folder under the repo's gitignored .scratch/ (never real user data, never
 * system temp). Oversize/CRLF/rotation cases are built by rewriting those fixture lines.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");

const ROOT = path.join(__dirname, "..", "..", ".scratch", "ingest-test-" + process.pid);
const EVENT_DIR = path.join(ROOT, "event-log-guard");
fs.mkdirSync(EVENT_DIR, { recursive: true });
// Any stray event-log write would land here (and fail the last test).
process.env.CURSOR_EVENT_LOG_DIR = EVENT_DIR;

const I = require("../../lib/claude-code-ingest");
const P = require("../../lib/claude-code-parse");
const T = require("../../lib/transcript-tail");
const { buildForbidden } = require("../helpers/privacy-patterns");

const FIX = path.join(__dirname, "..", "fixtures", "claude-code", "real", "C--proj-demo");
const FIX_SUB = path.join(FIX, "s1", "subagents");
const FORBIDDEN = buildForbidden([]);

let seq = 0;
const newProject = () => {
  const dir = path.join(ROOT, "proj-demo-" + ++seq);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const parentLines = () => fs.readFileSync(path.join(FIX, "s1.jsonl"), "utf8").trim().split("\n");

/** Copy the full fixture session (parent + 2 subagents with meta) into dir. */
function copyFixture(dir, id = "s1") {
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), path.join(dir, id + ".jsonl"));
  const sub = path.join(dir, id, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const n of fs.readdirSync(FIX_SUB)) {
    fs.copyFileSync(path.join(FIX_SUB, n), path.join(sub, n));
  }
  return sub;
}

/** Poll until nothing is pending (bounded). */
function drain(ing, max = 50) {
  const rows = [];
  for (let i = 0; i < max; i++) {
    rows.push(...ing.poll());
    if (!ing.stats().more) return rows;
  }
  throw new Error("ingest never drained");
}

/** Rows of the first n parent lines parsed directly (reference result). */
function parentRef(lines) {
  const state = P.createState();
  const rows = [];
  for (const l of lines) {
    rows.push(...P.parseLine(P.parseJsonLine(l), state, { source: "session" }));
  }
  return rows;
}

/** Direct parse of the whole fixture session, parent first (reference result). */
function reference(parentText) {
  const state = P.createState();
  const rows = [];
  const feed = (text, opts) => {
    for (const l of text.split("\n")) {
      const o = P.parseJsonLine(l);
      if (o) rows.push(...P.parseLine(o, state, opts));
    }
  };
  feed(parentText || fs.readFileSync(path.join(FIX, "s1.jsonl"), "utf8"), { source: "session" });
  ["a1", "a2"].forEach((a, i) => {
    feed(fs.readFileSync(path.join(FIX_SUB, `agent-${a}.jsonl`), "utf8"), {
      source: "subagent:" + (i + 1),
      meta: JSON.parse(fs.readFileSync(path.join(FIX_SUB, `agent-${a}.meta.json`), "utf8"))
    });
  });
  return rows;
}

/** Injectable clock: advance() moves past the 30 s rescan backstop. */
function mkClock() {
  let t = Date.now(); // after the old folder mtimes the cache tests set (a recent mtime is not trusted)
  const c = () => t;
  c.advance = (ms = 31000) => {
    t += ms;
  };
  return c;
}

/** Replace fs[name] while fn runs; make gets the original. Always restored. */
function withStub(name, make, fn) {
  const orig = fs[name];
  fs[name] = make(orig);
  try {
    return fn(orig);
  } finally {
    fs[name] = orig;
  }
}

/** Visible skip when this machine cannot create a link. */
function tryLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    t.skip("links cannot be created on this machine: " + e.code);
    return false;
  }
}

before(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(EVENT_DIR, { recursive: true });
});
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("parent is fed before children: child spawn rows get the parent role and model", () => {
  const dir = newProject();
  copyFixture(dir);
  const rows = drain(I.createClaudeCodeIngest({ projectDir: dir }));
  assert.deepEqual(rows, reference());
  const a1 = rows.find((r) => r.agentId === "a1" && r.type === "spawn");
  assert.equal(a1.role, "planner");
  assert.equal(a1.modelRaw, "claude-opus-5-5"); // only known from the parent's Agent result
  const a2 = rows.find((r) => r.agentId === "a2" && r.type === "spawn");
  assert.equal(a2.role, "worker");
  const firstChild = rows.findIndex((r) => /^subagent/.test(r.source));
  const lastParent = rows.map((r) => r.source).lastIndexOf("session");
  assert.ok(lastParent < firstChild, "all parent rows come before any child row");
});

test("incremental: appended lines give only new rows; a partial last line waits", () => {
  const dir = newProject();
  const L = parentLines();
  const file = path.join(dir, "s1.jsonl");
  const half = Math.floor(L[6].length / 2);
  fs.writeFileSync(file, L.slice(0, 6).join("\n") + "\n" + L[6].slice(0, half));
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const first = drain(ing);
  assert.equal(ing.stats().lines, 6, "unterminated line 7 not read yet");
  assert.deepEqual(ing.poll(), [], "nothing new, nothing returned");
  fs.appendFileSync(file, L[6].slice(half) + "\n" + L.slice(7).join("\n") + "\n");
  const second = drain(ing);
  assert.equal(ing.stats().lines, L.length);
  assert.deepEqual([...first, ...second], parentRef(L));
  assert.ok(second.length > 0);
});

test("CRLF line endings give the same rows as LF", () => {
  const lf = newProject();
  const crlf = newProject();
  const L = parentLines();
  fs.writeFileSync(path.join(lf, "s1.jsonl"), L.join("\n") + "\n");
  fs.writeFileSync(path.join(crlf, "s1.jsonl"), L.join("\r\n") + "\r\n");
  const a = drain(I.createClaudeCodeIngest({ projectDir: lf }));
  const b = drain(I.createClaudeCodeIngest({ projectDir: crlf }));
  assert.ok(a.length > 0);
  assert.deepEqual(b, a);
});

test("an oversize line is skipped and counted, with no text kept; later lines still read", () => {
  const dir = newProject();
  const L = parentLines();
  const secret = "OVERSIZE-SECRET-TEXT";
  const big = secret + "x".repeat(T.TRANSCRIPT_READ_MAX_PER_POLL + 5000);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), [L[0], big, L[1], L[2]].join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  const st = ing.stats();
  assert.equal(st.drift.oversize, 1);
  assert.equal(st.lines, 3, "the three real lines were read, the oversize one was not");
  assert.deepEqual(rows, parentRef([L[0], L[1], L[2]]));
  assert.ok(!JSON.stringify([rows, st]).includes(secret));
});

test("a file that shrinks restarts from 0 with fresh state (no double counting)", () => {
  const dir = newProject();
  const L = parentLines();
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(file, L.join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  fs.writeFileSync(file, L.slice(0, 4).join("\n") + "\n");
  const again = drain(ing);
  assert.deepEqual(again, parentRef(L.slice(0, 4)));
  assert.equal(ing.stats().sessions, 2);
});

test("a newer session replaces the older one and replays from its start", () => {
  const dir = newProject();
  const L = parentLines();
  const old = path.join(dir, "old.jsonl");
  const fresh = path.join(dir, "new.jsonl");
  // The new session is LONGER than the old one, so a missing reset would resume at the
  // old offset and lose the first lines.
  fs.writeFileSync(old, L.slice(0, 3).join("\n") + "\n");
  fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock, holdPolls: 1 });
  drain(ing);
  assert.equal(ing.stats().sessions, 1);
  assert.equal(ing.stats().lines, 3);
  fs.writeFileSync(fresh, L.join("\n") + "\n");
  fs.utimesSync(fresh, new Date(2026, 5, 1), new Date(2026, 5, 1));
  clock.advance();
  const rows = drain(ing);
  assert.equal(ing.stats().sessions, 2);
  assert.equal(ing.stats().lines, 3 + L.length, "new session read from its first line");
  assert.deepEqual(rows, parentRef(L));
});

test("symlinked .jsonl files are skipped (top level and subagents)", (t) => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const outside = path.join(ROOT, "outside.jsonl");
  fs.writeFileSync(outside, parentLines().join("\n") + "\n");
  try {
    fs.symlinkSync(outside, path.join(dir, "zz-link.jsonl"));
    fs.symlinkSync(outside, path.join(sub, "agent-zz.jsonl"));
  } catch (e) {
    t.skip("symlinks cannot be created on this machine: " + e.code);
    return;
  }
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(outside, future, future); // a followed link would look newest
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  assert.deepEqual(rows, reference());
  assert.equal(ing.stats().files, 3, "parent + two real subagent files only");
});

test("uppercase .JSONL is not matched", () => {
  const dir = newProject();
  fs.writeFileSync(path.join(dir, "s1.JSONL"), parentLines().join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  assert.deepEqual(ing.poll(), []);
  assert.equal(ing.stats().files, 0);
});

test("the per-folder entry cap is respected", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const N = I.MAX_DIR_ENTRIES + 5;
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(sub, "b" + String(i).padStart(5, "0") + ".jsonl"), "");
  }
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  const st = ing.stats();
  // names sort as agent-a1.jsonl, agent-a1.meta.json, agent-a2.*, then b00000...: only the
  // first MAX_DIR_ENTRIES names are looked at, so the tail of the b-files is never tracked
  assert.ok(st.files < N, "files tracked: " + st.files);
  assert.ok(st.files <= I.MAX_DIR_ENTRIES, "files tracked: " + st.files);
  assert.ok(st.drift.dirCut >= 1);
});

test("a bad or missing meta.json waits 2 polls, then the child reads without it; a bad one is counted once", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  fs.writeFileSync(path.join(sub, "agent-a1.meta.json"), "{not json SECRET-META");
  fs.rmSync(path.join(sub, "agent-a2.meta.json"));
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = [];
  const a2Child = () => rows.filter((r) => /^subagent/.test(r.source) && r.agentId === "a2");
  const a1Child = () => rows.filter((r) => /^subagent/.test(r.source) && r.agentId === "a1");
  rows.push(...ing.poll());
  rows.push(...ing.poll());
  assert.equal(a2Child().length, 0, "child file not read while its meta is awaited (2 polls)");
  assert.equal(a1Child().length, 0, "a half-written meta is retried, not given up on at once");
  assert.equal(ing.stats().drift.metaBad, 0, "nothing counted while the wait runs");
  rows.push(...ing.poll());
  assert.ok(a2Child().length > 0, "child without meta read on the third poll");
  assert.ok(a1Child().length > 0, "child with a meta that never parsed read on the third poll");
  const st = ing.stats();
  assert.equal(st.drift.metaBad, 1);
  assert.ok(!JSON.stringify([rows, st]).includes("SECRET-META"));
});

test("meta is passed to the parser: it alone marks a child file and sets its role", () => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), path.join(dir, "s1.jsonl"));
  // Child lines without isSidechain: only the meta tells the parser this is a child.
  const stripped = fs
    .readFileSync(path.join(FIX_SUB, "agent-a2.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const o = JSON.parse(l);
      delete o.isSidechain;
      return JSON.stringify(o);
    });
  fs.writeFileSync(path.join(sub, "agent-a2.jsonl"), stripped.join("\n") + "\n");
  fs.copyFileSync(path.join(FIX_SUB, "agent-a2.meta.json"), path.join(sub, "agent-a2.meta.json"));
  const rows = drain(I.createClaudeCodeIngest({ projectDir: dir }));
  const child = rows.filter((r) => r.source === "subagent:1");
  assert.ok(child.length > 0);
  assert.ok(child.some((r) => r.type === "spawn" && r.role === "worker"));
  assert.ok(child.every((r) => r.role !== "parent"));
});

test("a vanished or never-existing project folder returns [] with a flag, no throw", () => {
  const dir = newProject();
  copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  assert.ok(drain(ing).length > 0);
  assert.equal(ing.stats().projectMissing, false);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(ing.poll(), []);
  assert.equal(ing.stats().projectMissing, true);
  const never = I.createClaudeCodeIngest({ projectDir: path.join(ROOT, "nope-demo") });
  assert.deepEqual(never.poll(), []);
  assert.equal(never.stats().projectMissing, true);
});

test("a directory named like a session file does not throw out of poll()", () => {
  const dir = newProject();
  fs.mkdirSync(path.join(dir, "s1.jsonl"));
  fs.writeFileSync(path.join(dir, "s0.jsonl"), parentLines().join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  assert.doesNotThrow(() => ing.poll());
  assert.ok(ing.stats().lines > 0, "the real file is still read");
});

test("rows and stats are path-free and text-free", () => {
  const dir = newProject();
  copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  const out = JSON.stringify([rows, ing.stats()]);
  assert.ok(rows.length > 20);
  assert.ok(!FORBIDDEN.test(out), "shared privacy patterns");
  const needles = [
    dir,
    path.basename(dir),
    ROOT,
    "s1.jsonl",
    "agent-a1",
    "subagents",
    ".meta.json",
    ".scratch",
    ".jsonl",
    "agent-a2"
  ];
  for (const needle of needles) {
    assert.ok(!out.includes(needle), "leaked: " + needle);
    assert.ok(!out.includes(JSON.stringify(needle).slice(1, -1)), "leaked escaped: " + needle);
  }
  for (const v of Object.values(ing.stats())) {
    assert.ok(["number", "boolean", "object"].includes(typeof v));
  }
});

test("a parent past the per-poll cap is fully read before any child is fed", () => {
  const dir = newProject();
  copyFixture(dir);
  // Filler lines BEFORE the Agent lines push the Agent call/result past the first chunk.
  const filler = JSON.stringify({ type: "system", pad: "x".repeat(900) });
  const lines = [];
  for (let n = 0; n < Math.ceil((T.TRANSCRIPT_READ_MAX_PER_POLL + 20000) / 900); n++) {
    lines.push(filler);
  }
  const text = lines.join("\n") + "\n" + fs.readFileSync(path.join(FIX, "s1.jsonl"), "utf8");
  fs.writeFileSync(path.join(dir, "s1.jsonl"), text);
  assert.ok(Buffer.byteLength(lines.join("\n")) > T.TRANSCRIPT_READ_MAX_PER_POLL);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const first = ing.poll();
  assert.equal(ing.stats().more, true);
  assert.equal(ing.stats().capped, true, "capped unread bytes are reported as capped");
  assert.ok(!first.some((r) => /^subagent/.test(r.source)), "no child fed in a capped poll");
  assert.equal(ing.stats().files, 1);
  const rest = drain(ing);
  assert.deepEqual([...first, ...rest], reference(text));
  const spawn = (id) => rest.find((r) => r.agentId === id && r.type === "spawn");
  assert.equal(spawn("a1").modelRaw, "claude-opus-5-5");
  assert.equal(spawn("a2").modelRaw, "claude-sonnet-5-5");
});

test("more stays true when a later file's oversize skip finishes that file", () => {
  const dir = newProject();
  const L = parentLines();
  fs.writeFileSync(path.join(dir, "s1.jsonl"), L.slice(0, 3).join("\n") + "\n");
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const row = JSON.stringify({ type: "system", pad: "y".repeat(1000) });
  const many = [];
  for (let n = 0; n < 400; n++) many.push(row);
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), many.join("\n") + "\n");
  const one = "z".repeat(T.TRANSCRIPT_READ_MAX_PER_POLL + 10) + "\n";
  fs.writeFileSync(path.join(sub, "agent-z.jsonl"), one);
  for (const n of ["agent-a", "agent-z"]) {
    fs.writeFileSync(path.join(sub, n + ".meta.json"), '{"agentType":"worker"}');
  }
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  assert.equal(ing.stats().drift.oversize, 1);
  assert.equal(ing.stats().more, true, "agent-a still has capped bytes");
  assert.equal(ing.stats().capped, true);
  drain(ing);
});

test("links are never followed: the <id> folder, a junction, and the subagents folder", (t) => {
  const outside = path.join(ROOT, "outside-sub-" + ++seq);
  fs.mkdirSync(outside, { recursive: true });
  copyFixture(outside);
  const kinds = [
    ["dir symlink for <id>", "dir", (dir) => path.join(dir, "s1"), path.join(outside, "s1")],
    ["junction for <id>", "junction", (dir) => path.join(dir, "s1"), path.join(outside, "s1")],
    [
      "link for subagents",
      "dir",
      (dir) => path.join(dir, "s1", "subagents"),
      path.join(outside, "s1", "subagents")
    ]
  ];
  let ran = 0;
  for (const [what, type, linkAt, target] of kinds) {
    const dir = newProject();
    fs.copyFileSync(path.join(FIX, "s1.jsonl"), path.join(dir, "s1.jsonl"));
    if (what === "link for subagents") fs.mkdirSync(path.join(dir, "s1"));
    if (!tryLink(t, target, linkAt(dir), type)) return;
    ran += 1;
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    const rows = drain(ing);
    assert.equal(ing.stats().files, 1, what);
    assert.ok(!rows.some((r) => /^subagent/.test(r.source)), what);
    assert.deepEqual(rows, parentRef(parentLines()), what);
  }
  assert.equal(ran, kinds.length);
});

test("a one-off listing error keeps the session: no replay, sessions stays 1", () => {
  const dir = newProject();
  copyFixture(dir);
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  assert.ok(drain(ing).length > 0);
  assert.equal(ing.stats().sessions, 1);
  clock.advance(); // the next poll lists the folder again
  let thrown = 0;
  withStub(
    "readdirSync",
    (orig) =>
      function (p, ...a) {
        if (p === dir && thrown === 0) {
          thrown += 1;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return orig.call(this, p, ...a);
      },
    () => {
      assert.deepEqual(ing.poll(), []);
    }
  );
  assert.equal(thrown, 1);
  assert.equal(ing.stats().drift.unreadable, 1);
  assert.equal(ing.stats().sessions, 1);
  assert.deepEqual(ing.poll(), [], "no repeated rows after the error");
  assert.equal(ing.stats().sessions, 1);
  assert.equal(ing.stats().projectMissing, false);
});

function countListings(dir, fn) {
  let n = 0;
  withStub(
    "readdirSync",
    (orig) =>
      function (p, ...a) {
        if (p === dir) n += 1;
        return orig.call(this, p, ...a);
      },
    fn
  );
  return n;
}

test("scan cache: top-level folder is re-listed only on mtime change, the 30 s backstop, or a vanished file", () => {
  const dir = newProject();
  copyFixture(dir);
  const t0 = new Date(2026, 0, 1);
  fs.utimesSync(dir, t0, t0);
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  assert.equal(
    countListings(dir, () => drain(ing)),
    1,
    "first poll lists once"
  );
  assert.equal(
    countListings(dir, () => {
      for (let i = 0; i < 5; i++) ing.poll();
    }),
    0,
    "unchanged folder mtime: no top-level readdir"
  );
  // appended data is still seen without a listing (the cached file is stat'ed each poll)
  const L = parentLines();
  fs.appendFileSync(path.join(dir, "s1.jsonl"), L[1] + "\n");
  const linesBefore = ing.stats().lines;
  assert.equal(
    countListings(dir, () => {
      ing.poll();
    }),
    0
  );
  assert.equal(ing.stats().lines, linesBefore + 1, "appended line read from the cached session");
  // a changed folder mtime lists again
  const t1 = new Date(2026, 0, 2);
  fs.utimesSync(dir, t1, t1);
  assert.equal(
    countListings(dir, () => ing.poll()),
    1,
    "changed mtime"
  );
  // the 30 s backstop lists again
  clock.advance(29000);
  assert.equal(
    countListings(dir, () => ing.poll()),
    0,
    "29 s: still cached"
  );
  clock.advance(1000);
  assert.equal(
    countListings(dir, () => ing.poll()),
    1,
    "30 s backstop"
  );
  // a vanished cached file lists again even when the folder mtime did not change
  const extra = path.join(dir, "s2.jsonl");
  fs.writeFileSync(extra, L.slice(0, 2).join("\n") + "\n");
  const future = new Date(Date.now() + 3600000);
  fs.utimesSync(extra, future, future);
  fs.utimesSync(dir, t1, t1);
  clock.advance();
  assert.equal(
    countListings(dir, () => ing.poll()),
    1,
    "listed again after the clock moved"
  ); // s2 is now the cached newest (the hold keeps reading s1)
  fs.rmSync(extra);
  fs.utimesSync(dir, t1, t1);
  assert.equal(
    countListings(dir, () => ing.poll()),
    1,
    "cached file gone"
  );
});

test("hold: a session that alternates as newest never switches; one that stays 5 polls does", () => {
  const dir = newProject();
  const L = parentLines();
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  fs.writeFileSync(a, L.slice(0, 3).join("\n") + "\n");
  fs.writeFileSync(b, L.slice(0, 4).join("\n") + "\n");
  const newer = (f, o) => fs.utimesSync(f, new Date(2026, 3, o), new Date(2026, 3, o));
  newer(a, 1);
  newer(b, 1);
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  let day = 2;
  const step = (f) => {
    newer(f, day++);
    clock.advance();
    ing.poll();
  };
  newer(a, day++); // a is newest: first selection is immediate
  ing.poll();
  assert.equal(ing.stats().sessions, 1);
  for (let i = 0; i < 8; i++) step(i % 2 === 0 ? b : a); // b, a, b, a ...
  assert.equal(ing.stats().sessions, 1, "alternating never switches");
  step(a); // a is newest and the current session
  for (let i = 1; i <= 4; i++) {
    step(b);
    assert.equal(ing.stats().sessions, 1, "b has led " + i + " poll(s)");
  }
  step(b);
  assert.equal(ing.stats().sessions, 2, "5th consecutive poll switches once");
  for (let i = 0; i < 6; i++) step(b);
  assert.equal(ing.stats().sessions, 2, "no further switch");
});

test("source labels are unique, stable and appended; describeFile gives a base name only", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  const labels = new Set(rows.map((r) => r.source));
  assert.deepEqual([...labels].sort(), ["session", "subagent:1", "subagent:2"]);
  assert.equal(ing.describeFile("session"), "s1.jsonl");
  assert.equal(ing.describeFile("subagent:1"), "agent-a1.jsonl");
  assert.equal(ing.describeFile("subagent:2"), "agent-a2.jsonl");
  assert.equal(ing.describeFile("subagent:9"), null);
  assert.equal(ing.describeFile("../x"), null);
  for (const l of labels) {
    const d = ing.describeFile(l);
    assert.ok(!d.includes("/") && !d.includes("\\"), "base name only");
  }
  // a child that sorts BEFORE the others but appears later is appended, nothing renumbered
  fs.writeFileSync(path.join(sub, "agent-a0.jsonl"), parentLines()[0] + "\n");
  fs.writeFileSync(path.join(sub, "agent-a0.meta.json"), '{"agentType":"worker"}');
  ing.poll();
  assert.equal(ing.describeFile("subagent:1"), "agent-a1.jsonl");
  assert.equal(ing.describeFile("subagent:3"), "agent-a0.jsonl");
  const out = JSON.stringify([rows, ing.stats()]);
  assert.ok(!out.includes("s1.jsonl") && !out.includes("agent-a1") && !out.includes(dir));
});

test("a child added within the folder's mtime tick is still listed (coarse mtime, e.g. ext4)", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  // Force the coarse-mtime condition on any host: the new child leaves the folder mtime unchanged
  // (a whole-ms value just before now, so the listing is recent like a real same-tick write).
  // The injected clock keeps the timing off the wall clock: the first listing is taken 50 ms
  // after the folder mtime (racy), and the second poll runs 3 s later, still inside the 30 s
  // backstop. The listing was racy when it was taken, so it must not be trusted, even though
  // the folder mtime is now more than RACY_MS behind the clock.
  const clock = mkClock();
  const tick = new Date(clock() - 50);
  fs.utimesSync(sub, tick, tick);
  const pinned = fs.statSync(sub).mtimeMs; // what the disk stored (it may round the value)
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  drain(ing);
  fs.writeFileSync(path.join(sub, "agent-a0.jsonl"), parentLines()[0] + "\n");
  fs.writeFileSync(path.join(sub, "agent-a0.meta.json"), '{"agentType":"worker"}');
  fs.utimesSync(sub, tick, tick);
  assert.equal(fs.statSync(sub).mtimeMs, pinned, "folder mtime pinned");
  clock.advance(3000);
  drain(ing);
  assert.equal(ing.describeFile("subagent:3"), "agent-a0.jsonl");
});

test("a newer session added within the project folder's mtime tick is still found", () => {
  const dir = newProject();
  copyFixture(dir);
  // Injected clock, as in the child test: racy at listing time, polled again 3 s later.
  const clock = mkClock();
  const tick = new Date(clock() - 50);
  fs.utimesSync(dir, tick, tick);
  const pinned = fs.statSync(dir).mtimeMs; // what the disk stored (it may round the value)
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  drain(ing);
  const next = path.join(dir, "s2.jsonl");
  fs.writeFileSync(next, parentLines().slice(0, 2).join("\n") + "\n");
  const future = new Date(Date.now() + 3600000);
  fs.utimesSync(next, future, future);
  fs.utimesSync(dir, tick, tick); // the folder mtime did not move
  assert.equal(fs.statSync(dir).mtimeMs, pinned, "folder mtime pinned");
  clock.advance(3000);
  for (let i = 0; i < I.HOLD_POLLS + 1; i++) ing.poll();
  assert.equal(ing.stats().sessions, 2);
});

test("open-handle checks: regular files are read; an identity or type change is refused", () => {
  const dir = newProject();
  copyFixture(dir);
  const clean = drain(I.createClaudeCodeIngest({ projectDir: dir }));
  assert.deepEqual(clean, reference());

  // dev/ino of the open handle differs from the lstat of the same name (a swap)
  const swapped = newProject();
  fs.writeFileSync(path.join(swapped, "s1.jsonl"), parentLines().join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: swapped });
  const rows = withStub(
    "fstatSync",
    (orig) =>
      function (fd, ...a) {
        const st = orig.call(this, fd, ...a);
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          ino: typeof st.ino === "bigint" ? st.ino + 1n : st.ino + 1
        });
      },
    () => ing.poll()
  );
  assert.deepEqual(rows, []);
  assert.equal(ing.stats().drift.unreadable, 1);
  assert.equal(ing.stats().lines, 0);
  assert.ok(ing.poll().length > 0, "the same file is read once the handle matches again");

  // the open handle is not a regular file
  const odd = newProject();
  fs.writeFileSync(path.join(odd, "s1.jsonl"), parentLines().join("\n") + "\n");
  const ing2 = I.createClaudeCodeIngest({ projectDir: odd });
  const none = withStub(
    "fstatSync",
    (orig) =>
      function (fd, ...a) {
        const st = orig.call(this, fd, ...a);
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isFile: () => false
        });
      },
    () => ing2.poll()
  );
  assert.deepEqual(none, []);
  assert.equal(ing2.stats().drift.unreadable, 1);
});

test("O_NOFOLLOW refuses a link that an lstat check was fooled into accepting", (t) => {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    t.skip("O_NOFOLLOW is not defined on this platform (Windows)");
    return;
  }
  const dir = newProject();
  const real = path.join(ROOT, "outside-nf.jsonl");
  fs.writeFileSync(real, parentLines().join("\n") + "\n");
  if (!tryLink(t, real, path.join(dir, "s1.jsonl"), "file")) return;
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  // swap gap: the name looked like a regular file when it was checked
  const rows = withStub(
    "lstatSync",
    (orig) =>
      function (p, ...a) {
        return orig.call(this, p === path.join(dir, "s1.jsonl") ? real : p, ...a);
      },
    () => ing.poll()
  );
  assert.deepEqual(rows, []);
  assert.ok(ing.stats().drift.unreadable >= 1);
});

test("a meta file bigger than the cap is cut at cap+1 bytes actually read", () => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), "");
  fs.writeFileSync(path.join(sub, "agent-big.jsonl"), "");
  const big = JSON.stringify({ agentType: "worker", pad: "p".repeat(300 * 1024) });
  const metaFile = path.join(sub, "agent-big.meta.json");
  fs.writeFileSync(metaFile, big);
  let bytes = 0;
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  withStub(
    "readSync",
    (orig) =>
      function (...a) {
        const n = orig.apply(this, a);
        bytes += n;
        return n;
      },
    () =>
      // the earlier lstat claims the file is tiny: only the bytes actually read are trusted
      withStub(
        "lstatSync",
        (orig) =>
          function (p, ...a) {
            const st = orig.call(this, p, ...a);
            return p === metaFile
              ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 10 })
              : st;
          },
        () => ing.poll()
      )
  );
  assert.equal(ing.stats().drift.metaBad, 1);
  assert.ok(bytes > 0 && bytes <= 64 * 1024 + 1, "bytes read from the meta handle: " + bytes);
});

/** Reference rows of one child file fed after the given parent lines (direct parse). */
function childRef(parent, a, source) {
  const state = P.createState();
  for (const l of parent) P.parseLine(P.parseJsonLine(l), state, { source: "session" });
  const rows = [];
  const text = fs.readFileSync(path.join(FIX_SUB, `agent-${a}.jsonl`), "utf8");
  const meta = JSON.parse(fs.readFileSync(path.join(FIX_SUB, `agent-${a}.meta.json`), "utf8"));
  for (const l of text.split("\n")) {
    const o = P.parseJsonLine(l);
    if (o) rows.push(...P.parseLine(o, state, { source, meta }));
  }
  return rows;
}

const isChildRow = (r) => /^subagent/.test(r.source);

test("a failed parent open feeds no child in that poll; the models are still right afterwards", () => {
  const dir = newProject();
  copyFixture(dir);
  const parentFile = path.join(dir, "s1.jsonl");
  let thrown = 0;
  // holdChildPolls 0 turns the child hold off so only the parent-failure rule is exercised
  const ing = I.createClaudeCodeIngest({ projectDir: dir, holdChildPolls: 0 });
  const first = withStub(
    "openSync",
    (orig) =>
      function (p, ...a) {
        if (p === parentFile && thrown === 0) {
          thrown += 1;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return orig.call(this, p, ...a);
      },
    () => ing.poll()
  );
  assert.equal(thrown, 1);
  assert.deepEqual(first, [], "no child rows while the parent could not be read");
  assert.equal(ing.stats().files, 1, "no child file was even tracked");
  assert.equal(ing.stats().drift.unreadable, 1);
  const rows = drain(ing);
  assert.deepEqual(rows, reference());
  const a1 = rows.find((r) => r.agentId === "a1" && r.type === "spawn");
  assert.equal(a1.role, "planner");
  assert.equal(a1.modelRaw, "claude-opus-5-5");
});

test("a child that appears while the poll runs is read with the parent's Agent lines in hand", () => {
  const dir = newProject();
  const L = parentLines();
  const parentFile = path.join(dir, "s1.jsonl");
  fs.writeFileSync(parentFile, L.slice(0, 33).join("\n") + "\n");
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  let raced = 0;
  const ing = I.createClaudeCodeIngest({ projectDir: dir, holdChildPolls: 0 });
  // Between the start of the poll and the subagents listing: the parent gains its Agent
  // lines and the children appear.
  const first = withStub(
    "readdirSync",
    (orig) =>
      function (p, ...a) {
        if (p === sub && raced === 0) {
          raced += 1;
          fs.appendFileSync(parentFile, L.slice(33).join("\n") + "\n");
          for (const n of fs.readdirSync(FIX_SUB)) {
            fs.copyFileSync(path.join(FIX_SUB, n), path.join(sub, n));
          }
        }
        return orig.call(this, p, ...a);
      },
    () => ing.poll()
  );
  assert.equal(raced, 1);
  const rows = [...first, ...drain(ing)];
  assert.deepEqual(rows, reference());
  const spawn = (id) => rows.find((r) => r.agentId === id && r.type === "spawn");
  assert.equal(spawn("a1").modelRaw, "claude-opus-5-5");
  assert.equal(spawn("a2").modelRaw, "claude-sonnet-5-5");
});

test("top level: more than MAX_DIR_ENTRIES entries; the newest session sorts last and still wins", () => {
  const dir = newProject();
  const old = new Date(Date.now() - 3600000);
  for (let i = 0; i < I.MAX_DIR_ENTRIES + 100; i++) {
    const f = path.join(dir, "a" + String(i).padStart(5, "0") + ".jsonl");
    fs.writeFileSync(f, "");
    fs.utimesSync(f, old, old);
  }
  fs.mkdirSync(path.join(dir, "an-id-folder"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const newest = path.join(dir, "zz-newest.jsonl");
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), newest);
  // copyFileSync keeps the SOURCE mtime on Windows: set it, or the file ages with the checkout
  const fresh = new Date();
  fs.utimesSync(newest, fresh, fresh);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  assert.equal(ing.describeFile("session"), "zz-newest.jsonl");
  assert.deepEqual(rows, parentRef(parentLines()));
  assert.equal(ing.stats().drift.dirCut, 0, "nothing was cut at 2100 candidates");
});

function holdProject(parentCount, withA2) {
  const dir = newProject();
  const L = parentLines();
  const parentFile = path.join(dir, "s1.jsonl");
  fs.writeFileSync(parentFile, L.slice(0, parentCount).join("\n") + "\n");
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const a of withA2 ? ["a1", "a2"] : ["a1"]) {
    fs.copyFileSync(path.join(FIX_SUB, `agent-${a}.jsonl`), path.join(sub, `agent-${a}.jsonl`));
    fs.copyFileSync(
      path.join(FIX_SUB, `agent-${a}.meta.json`),
      path.join(sub, `agent-${a}.meta.json`)
    );
  }
  return { dir, L, parentFile, sub };
}

test("child hold: a child waits for its parent's Agent result, then gets the right model", () => {
  const { dir, L, parentFile } = holdProject(34, false); // Agent call at line 33, no result yet
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const early = [];
  for (let i = 0; i < 2; i++) {
    early.push(...ing.poll());
    assert.equal(ing.stats().heldChildren, 1, "held on poll " + (i + 1));
    assert.equal(ing.stats().more, true, "a held child keeps more true");
    assert.equal(ing.stats().capped, false, "a hold is a wait, not capped bytes");
  }
  assert.ok(!early.some(isChildRow), "no child line fed while held");
  assert.ok(early.length > 0, "the parent itself is not blocked");
  fs.appendFileSync(parentFile, L[34] + "\n"); // the Agent result arrives
  const third = ing.poll();
  assert.equal(ing.stats().heldChildren, 0);
  const kid = third.filter(isChildRow);
  assert.deepEqual(kid, childRef(L.slice(0, 35), "a1", "subagent:1"));
  const a1 = kid.find((r) => r.type === "spawn");
  assert.equal(a1.role, "planner");
  assert.equal(a1.modelRaw, "claude-opus-5-5");
});

test("child hold: a result that never arrives releases the child after exactly HOLD_CHILD_POLLS polls", () => {
  assert.equal(I.HOLD_CHILD_POLLS, 6);
  const { dir } = holdProject(34, false);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  for (let i = 1; i <= I.HOLD_CHILD_POLLS; i++) {
    const rows = ing.poll();
    assert.ok(!rows.some(isChildRow), "held on poll " + i);
    assert.equal(ing.stats().heldChildren, 1);
  }
  const rows = ing.poll();
  assert.ok(
    rows.some((r) => isChildRow(r) && r.type === "spawn"),
    "fed on poll 7"
  );
  assert.equal(ing.stats().heldChildren, 0);
  // an injected shorter hold is honoured
  const { dir: dir2 } = holdProject(34, false);
  const quick = I.createClaudeCodeIngest({ projectDir: dir2, holdChildPolls: 2 });
  assert.ok(!quick.poll().some(isChildRow));
  assert.ok(!quick.poll().some(isChildRow));
  assert.ok(quick.poll().some(isChildRow));
});

test("child hold: a held child blocks neither the parent nor another child; no toolUseId means no hold", () => {
  const { dir, L, parentFile, sub } = holdProject(34, true);
  // a2 has meta without a toolUseId: never held
  const m = JSON.parse(fs.readFileSync(path.join(sub, "agent-a2.meta.json"), "utf8"));
  delete m.toolUseId;
  fs.writeFileSync(path.join(sub, "agent-a2.meta.json"), JSON.stringify(m));
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const first = ing.poll();
  assert.ok(
    first.some((r) => r.source === "session"),
    "parent rows flow"
  );
  assert.ok(
    first.some((r) => r.source === "subagent:2"),
    "the unheld child is fed at once"
  );
  assert.ok(!first.some((r) => r.source === "subagent:1"), "a1 is held");
  assert.equal(ing.stats().heldChildren, 1);
  fs.appendFileSync(parentFile, L[34] + "\n");
  const next = ing.poll();
  assert.ok(
    next.some((r) => r.source === "subagent:1"),
    "a1 released by the result"
  );
  assert.ok(!JSON.stringify(ing.stats()).includes("toolu_"), "no ids in stats");
});

const EBUSY = () => Object.assign(new Error("busy"), { code: "EBUSY" });

test("meta retry: a transient open error is retried on the next poll (no sleep), then the meta is used", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const metaA2 = path.join(sub, "agent-a2.meta.json");
  let fails = 2;
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = [];
  withStub(
    "openSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === metaA2 && fails-- > 0) throw EBUSY();
        return orig.call(this, p, ...a);
      },
    () => {
      rows.push(...ing.poll());
      rows.push(...ing.poll());
    }
  );
  assert.equal(
    rows.filter((r) => r.source === "subagent:2").length,
    0,
    "child waits while its meta is busy"
  );
  rows.push(...drain(ing));
  assert.deepEqual(rows, reference());
  assert.equal(ing.stats().drift.unreadable, 0, "a recovered error is not counted");
});

test("meta retry: a meta that stays unreadable is counted once, then the child runs without it", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const metaA2 = path.join(sub, "agent-a2.meta.json");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = [];
  withStub(
    "openSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === metaA2) throw EBUSY();
        return orig.call(this, p, ...a);
      },
    () => {
      for (let i = 0; i < 3; i++) rows.push(...ing.poll());
    }
  );
  assert.equal(ing.stats().drift.unreadable, 1);
  assert.ok(
    rows.some((r) => r.source === "subagent:2"),
    "read without meta after the wait"
  );
});

test("meta retry: an empty or half-written meta is re-read and used once it is complete", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const metaA2 = path.join(sub, "agent-a2.meta.json");
  const real = fs.readFileSync(metaA2, "utf8");
  fs.writeFileSync(metaA2, "");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = [...ing.poll(), ...ing.poll()];
  assert.equal(rows.filter((r) => r.source === "subagent:2").length, 0);
  fs.writeFileSync(metaA2, real);
  rows.push(...drain(ing));
  assert.deepEqual(rows, reference());
  assert.equal(ing.stats().drift.metaBad, 0);
});

test("a meta padded with spaces past the cap is refused by the byte cap, not by its parse", () => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), path.join(dir, "s1.jsonl"));
  fs.copyFileSync(path.join(FIX_SUB, "agent-a2.jsonl"), path.join(sub, "agent-a2.jsonl"));
  // valid JSON, then whitespace: a truncated read at the cap would still parse
  fs.writeFileSync(
    path.join(sub, "agent-a2.meta.json"),
    '{"agentType":"worker"}' + " ".repeat(70 * 1024)
  );
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = ing.poll();
  assert.equal(ing.stats().drift.metaBad, 1, "over the cap is definitive, at once");
  assert.ok(
    rows.some((r) => r.source === "subagent:1"),
    "the child still reads without meta"
  );
});

/** Run fn with the BigInt lstat of file `p` patched (dev/ino/birthtimeMs overrides). */
function withLstatPatch(p, patch, fn) {
  return withStub(
    "lstatSync",
    (orig) =>
      function (q, opts, ...a) {
        const st = orig.call(this, q, opts, ...a);
        if (String(q) !== p || !(opts && opts.bigint)) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch(st));
      },
    fn
  );
}

test("replaced file (real fs): a different, larger file renamed over the parent restarts the session", () => {
  const dir = newProject();
  copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  assert.equal(ing.stats().sessions, 1);
  const parent = path.join(dir, "s1.jsonl");
  const text = fs.readFileSync(parent, "utf8");
  const other = path.join(dir, "swap.tmp");
  fs.writeFileSync(other, text + text.split("\n")[0] + "\n");
  fs.renameSync(other, parent);
  drain(ing);
  assert.equal(ing.stats().sessions, 2, "a replaced parent is a new session: clear and replay");
});

test("replaced file by platform: win32 trusts creation time (and a nonzero id), posix the id", () => {
  const cases = [
    // [platform, patch on the second poll, expected sessions, label]
    ["win32", (st) => ({ birthtimeMs: st.birthtimeMs + 5000n }), 2, "win32: new creation time"],
    ["win32", (st) => ({ ino: st.ino + 1n }), 2, "win32: same creation time, new id (tunneling)"],
    ["posix", (st) => ({ ino: st.ino + 1n }), 2, "posix: new id"],
    [
      "posix",
      (st) => ({ birthtimeMs: st.birthtimeMs + 5000n }),
      1,
      "posix: creation time is unused"
    ],
    ["win32", () => ({ dev: 0n, ino: 0n }), 1, "win32: no id and the same creation time"]
  ];
  for (const [platform, patch, want, label] of cases) {
    const dir = newProject();
    copyFixture(dir);
    const parent = path.join(dir, "s1.jsonl");
    const ing = I.createClaudeCodeIngest({ projectDir: dir, platform });
    drain(ing);
    withLstatPatch(parent, patch, () => ing.poll());
    assert.equal(ing.stats().sessions, want, label);
  }
});

test("replaced file with no usable ids anywhere: the shrink check still resets on its own", () => {
  const dir = newProject();
  copyFixture(dir);
  const parent = path.join(dir, "s1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir, platform: "posix" });
  const zero = () => ({ dev: 0n, ino: 0n });
  withLstatPatch(parent, zero, () => drain(ing));
  fs.writeFileSync(parent, parentLines().slice(0, 2).join("\n") + "\n"); // shorter than the offset
  withLstatPatch(parent, zero, () => drain(ing));
  assert.equal(ing.stats().sessions, 2);
});

test("subagent listing cache: re-listed only on a folder mtime change or the 30 s backstop", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const old = new Date(2026, 0, 1);
  fs.utimesSync(sub, old, old); // an old folder mtime: the cached listing is trusted
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  let listings = 0;
  const run = (fn) =>
    withStub(
      "readdirSync",
      (orig) =>
        function (p, ...a) {
          if (String(p) === sub) listings += 1;
          return orig.call(this, p, ...a);
        },
      fn
    );
  run(() => drain(ing));
  assert.equal(listings, 1, "first poll lists the subagents folder once");
  run(() => ing.poll());
  assert.equal(listings, 1, "unchanged folder mtime: no listing");
  const later = new Date(2026, 0, 2); // old, so the re-listed cache is trusted again
  fs.writeFileSync(path.join(sub, "agent-a3.jsonl"), "");
  fs.utimesSync(sub, later, later); // a new child changed the folder mtime
  run(() => ing.poll());
  assert.equal(listings, 2, "a changed mtime re-lists");
  assert.ok(ing.describeFile("subagent:3"), "the new child is found");
  run(() => ing.poll());
  assert.equal(listings, 2, "unchanged: no listing");
  clock.advance(31000);
  run(() => ing.poll());
  assert.equal(listings, 3, "the backstop re-lists");
});

test("idle children: an unchanged, fully read child is lstat'ed only every IDLE_EVERY-th poll", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const a1 = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  for (let i = 0; i < I.IDLE_AFTER + 2; i++) ing.poll(); // let it settle into idle
  let calls = 0;
  withStub(
    "lstatSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === a1) calls += 1;
        return orig.call(this, p, ...a);
      },
    () => {
      for (let i = 0; i < 3 * I.IDLE_EVERY; i++) ing.poll();
    }
  );
  // staggered phase: 3 or 4 checks in 3 periods (30 without the idle rule)
  assert.ok(
    calls >= 3 && calls <= 4,
    "real lstats in " + 3 * I.IDLE_EVERY + " idle polls: " + calls
  );
});

test("idle children: one that grows is noticed within IDLE_EVERY polls, then checked every poll", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const a1 = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  for (let i = 0; i < I.IDLE_AFTER + 2; i++) ing.poll();
  const before = ing.stats().lines;
  fs.appendFileSync(a1, '{"type":"system","subtype":"x"}\n');
  let seen = 0;
  while (ing.stats().lines === before && seen <= I.IDLE_EVERY) {
    ing.poll();
    seen += 1;
  }
  assert.ok(ing.stats().lines > before, "the appended line is read");
  assert.ok(seen <= I.IDLE_EVERY, "within IDLE_EVERY polls: " + seen);
  // it is active again: the next append is read on the very next poll
  const mid = ing.stats().lines;
  fs.appendFileSync(a1, '{"type":"system","subtype":"y"}\n');
  ing.poll();
  assert.ok(ing.stats().lines > mid, "an active child is checked on every poll");
});

test("idle children: a child still unread (held, or growing every poll) is never idle", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const a1 = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  for (let i = 0; i < I.IDLE_AFTER * 3; i++) {
    const before = ing.stats().lines;
    fs.appendFileSync(a1, '{"type":"system","subtype":"z' + i + '"}\n');
    ing.poll();
    assert.ok(ing.stats().lines > before, "poll " + i + " reads the new line at once");
  }
});

test("usesCreationTime: Windows local drives yes; WSL shares, POSIX no", () => {
  const bs = String.fromCharCode(92);
  const win = (p) => I.usesCreationTime("win32", p);
  assert.equal(win("C:" + bs + "Users" + bs + "user" + bs + "proj-demo"), true);
  assert.equal(win(bs + bs + "server" + bs + "share" + bs + "proj-demo"), true);
  assert.equal(win(bs + bs + "wslfoo" + bs + "x"), true, "only the real WSL host names");
  assert.equal(win(bs + bs + "wsl.localhostx" + bs + "x"), true, "the host name must end there");
  assert.equal(win(bs + bs + "wslXlocalhost" + bs + "x"), true, "the dot is a literal dot");
  assert.equal(win(bs + bs + "wsl$foo" + bs + "x"), true, "a separator must follow wsl$");
  assert.equal(win(bs + bs + "wsl.localhost" + bs + "distro" + bs + "home" + bs + "user"), false);
  assert.equal(win(bs + bs + "wsl$" + bs + "distro" + bs + "home" + bs + "user"), false);
  assert.equal(win(bs + bs + "WSL.LocalHost" + bs + "distro"), false, "case-insensitive");
  assert.equal(win("//wsl.localhost/distro/home/user"), false, "forward slashes too");
  assert.equal(I.usesCreationTime("linux", "/home/user/proj-demo"), false);
  assert.equal(I.usesCreationTime("darwin", "/Users/user/proj-demo"), false);
});

test("WSL share: a creation time that equals the modification time does not reset the session on appends", () => {
  const run = (creationTime) => {
    const dir = newProject();
    const parent = path.join(dir, "s1.jsonl");
    const L = parentLines();
    const end = Math.min(26, L.length);
    fs.writeFileSync(parent, L.slice(0, 20).join("\n") + "\n");
    const ing = I.createClaudeCodeIngest({ projectDir: dir, platform: "win32", creationTime });
    // what the share reports: creation time is the (moving) modification time
    const share = (st) => ({ birthtimeMs: st.mtimeMs });
    const rows = [];
    withLstatPatch(parent, share, () => rows.push(...drain(ing)));
    for (let i = 20; i < end; i++) {
      fs.appendFileSync(parent, L[i] + "\n");
      const t = new Date(Date.now() + 1000 * (i + 1));
      fs.utimesSync(parent, t, t);
      withLstatPatch(parent, share, () => rows.push(...drain(ing)));
    }
    return { rows, sessions: ing.stats().sessions, want: parentRef(L.slice(0, end)) };
  };
  const wsl = run(false);
  assert.equal(wsl.sessions, 1, "no reset");
  assert.deepEqual(wsl.rows, wsl.want, "every appended line arrives once");
  const control = run(true);
  assert.ok(control.sessions > 1, "control: trusting creation time resets on every append");
});

test("idle children are staggered: no poll re-checks every idle child at once", () => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), "");
  const N = 30;
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(sub, "agent-" + String(i).padStart(3, "0") + ".jsonl"), "");
  }
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  for (let i = 0; i < I.IDLE_AFTER + 5; i++) ing.poll();
  let calls = 0;
  const per = [];
  withStub(
    "lstatSync",
    (orig) =>
      function (p, ...a) {
        if (String(p).startsWith(sub) && String(p).endsWith(".jsonl")) calls += 1;
        return orig.call(this, p, ...a);
      },
    () => {
      for (let i = 0; i < 3 * I.IDLE_EVERY; i++) {
        calls = 0;
        ing.poll();
        per.push(calls);
      }
    }
  );
  const total = per.reduce((x, y) => x + y, 0);
  assert.ok(total >= 2 * N, "every child is still re-checked: " + total);
  assert.ok(Math.max(...per) <= 2 * Math.ceil(N / I.IDLE_EVERY), "spike: " + Math.max(...per));
});

test("an idle child that grew while polled keeps its real size: no reset loop", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const a1 = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  for (let i = 0; i < 20; i++) {
    fs.appendFileSync(a1, '{"type":"system","subtype":"g' + i + '"}\n');
    ing.poll();
  }
  for (let i = 0; i < 3 * I.IDLE_EVERY + I.IDLE_AFTER; i++) ing.poll();
  assert.equal(ing.stats().sessions, 1, "a stale size for the idle child would reset the session");
});

test("top level: sessions with the same mtime: the first name in order wins", () => {
  const dir = newProject();
  const t = new Date(2026, 3, 1);
  for (const n of ["b-sess.jsonl", "a-sess.jsonl", "c-sess.jsonl"]) {
    const f = path.join(dir, n);
    fs.writeFileSync(f, parentLines().join("\n") + "\n");
    fs.utimesSync(f, t, t);
  }
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  assert.equal(ing.describeFile("session"), "a-sess.jsonl");
});

test("the meta wait does not depend on idle skipping: 3 polls, nothing counted, a late line still read", () => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), "");
  const child = path.join(sub, "agent-z.jsonl");
  fs.writeFileSync(child, "");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  for (let i = 0; i < 3; i++) ing.poll();
  assert.equal(ing.stats().heldChildren, 0);
  assert.deepEqual(ing.stats().drift, {
    unparsed: 0,
    oversize: 0,
    metaBad: 0,
    unreadable: 0,
    dirCut: 0
  });
  for (let i = 0; i < I.IDLE_AFTER + 5; i++) ing.poll(); // the child is idle now
  const before = ing.stats().lines;
  fs.appendFileSync(child, '{"type":"system","subtype":"late"}\n');
  let seen = 0;
  while (ing.stats().lines === before && seen <= I.IDLE_EVERY) {
    ing.poll();
    seen += 1;
  }
  assert.ok(ing.stats().lines > before && seen <= I.IDLE_EVERY, "late line read in " + seen);
  assert.equal(ing.stats().drift.metaBad + ing.stats().drift.unreadable, 0);
});

/** Map paths under `fake` onto `real` for the fs calls the ingest makes by path. */
function withPathMap(fake, real, fn) {
  const names = ["statSync", "lstatSync", "readdirSync", "openSync"];
  const origs = names.map((n) => fs[n]);
  names.forEach((n, i) => {
    fs[n] = function (p, ...a) {
      const q = typeof p === "string" && p.startsWith(fake) ? real + p.slice(fake.length) : p;
      return origs[i].call(this, q, ...a);
    };
  });
  try {
    return fn();
  } finally {
    names.forEach((n, i) => {
      fs[n] = origs[i];
    });
  }
}

test("production wiring: with default options a WSL-share folder ignores creation time", () => {
  const bs = String.fromCharCode(92);
  const run = (fake) => {
    const real = newProject();
    const parent = path.join(real, "s1.jsonl");
    const fakeParent = path.join(fake, "s1.jsonl");
    const L = parentLines();
    const end = Math.min(26, L.length);
    fs.writeFileSync(parent, L.slice(0, 20).join("\n") + "\n");
    // no `creationTime` option: the folder name alone decides, as in production
    const ing = I.createClaudeCodeIngest({ projectDir: fake, platform: "win32" });
    const share = (st) => ({ birthtimeMs: st.mtimeMs });
    const step = () =>
      withPathMap(fake, real, () => withLstatPatch(fakeParent, share, () => drain(ing)));
    const rows = step();
    for (let i = 20; i < end; i++) {
      fs.appendFileSync(parent, L[i] + "\n");
      const t = new Date(Date.now() + 1000 * (i + 1));
      fs.utimesSync(parent, t, t);
      rows.push(...step());
    }
    return { rows, sessions: ing.stats().sessions, want: parentRef(L.slice(0, end)) };
  };
  const wsl = run(bs + bs + "wsl.localhost" + bs + "distro" + bs + "proj-demo");
  assert.equal(wsl.sessions, 1, "a WSL-share folder: no reset on appends");
  assert.deepEqual(wsl.rows, wsl.want);
  const other = run(bs + bs + "server" + bs + "share" + bs + "proj-demo");
  assert.ok(other.sessions > 1, "control: another share trusts creation time and resets");
});

test("top level: a symlink and a directory named *.jsonl with the newest mtime are never selected", (t) => {
  const dir = newProject();
  copyFixture(dir);
  const real = path.join(dir, "s1.jsonl");
  const old = new Date(2026, 3, 1);
  fs.utimesSync(real, old, old);
  // newer than the real session: a folder, and (where links can be made) a link to a file
  fs.mkdirSync(path.join(dir, "zz-folder.jsonl"));
  const outside = path.join(ROOT, "outside-link-target-" + ++seq + ".jsonl");
  fs.writeFileSync(outside, parentLines().slice(0, 3).join("\n") + "\n");
  tryLink(t, outside, path.join(dir, "zz-link.jsonl"), "file"); // skips the link part if it cannot be made
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = drain(ing);
  assert.equal(ing.describeFile("session"), "s1.jsonl", "the real file is the session");
  assert.deepEqual(rows, reference(), "the real session keeps feeding, children included");
  assert.equal(ing.stats().sessions, 1);
});

test("a transient error on the project folder keeps the session: no replay, counted once", () => {
  const dir = newProject();
  copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  const before = ing.stats();
  let thrown = 0;
  const rows = withStub(
    "statSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === dir && thrown++ === 0) throw EBUSY();
        return orig.call(this, p, ...a);
      },
    () => ing.poll()
  );
  assert.deepEqual(rows, []);
  const mid = ing.stats();
  assert.equal(mid.sessions, before.sessions, "same session");
  assert.equal(mid.files, before.files, "same files and offsets");
  assert.equal(mid.lines, before.lines);
  assert.equal(mid.drift.unreadable, before.drift.unreadable + 1);
  assert.equal(mid.projectMissing, false);
  assert.deepEqual(ing.poll(), [], "the next poll continues without a replay");
  assert.equal(ing.stats().sessions, before.sessions);
  assert.equal(ing.stats().lines, before.lines);
});

test("the current parent vanishes: the remaining newest is picked at once, with no hold", () => {
  const dir = newProject();
  copyFixture(dir); // s1 is the newest
  const older = path.join(dir, "s0.jsonl");
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), older);
  const old = new Date(2026, 3, 1);
  fs.utimesSync(older, old, old);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  assert.equal(ing.describeFile("session"), "s1.jsonl");
  assert.equal(ing.stats().sessions, 1);
  fs.rmSync(path.join(dir, "s1.jsonl"));
  const rows = [];
  for (let i = 0; i < 2; i++) rows.push(...ing.poll()); // far fewer than HOLD_POLLS (5)
  assert.ok(I.HOLD_POLLS > 2);
  assert.equal(ing.stats().sessions, 2, "switched to the remaining session");
  assert.equal(ing.describeFile("session"), "s0.jsonl");
  assert.ok(rows.length > 0 && rows.every((r) => r.source === "session"));
});

test("a meta file that is a link is refused at once: counted, and the child runs without it", (t) => {
  const dir = newProject();
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(FIX, "s1.jsonl"), path.join(dir, "s1.jsonl"));
  fs.copyFileSync(path.join(FIX_SUB, "agent-a2.jsonl"), path.join(sub, "agent-a2.jsonl"));
  const outside = path.join(ROOT, "outside-meta-" + ++seq + ".json");
  fs.copyFileSync(path.join(FIX_SUB, "agent-a2.meta.json"), outside);
  if (!tryLink(t, outside, path.join(sub, "agent-a2.meta.json"), "file")) return;
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const rows = ing.poll(); // the very first poll
  assert.equal(ing.stats().drift.metaBad, 1, "refused and counted on the first poll");
  assert.equal(ing.stats().drift.unreadable, 0);
  assert.ok(
    rows.some((r) => r.source === "subagent:1"),
    "the child ran at once, with no META_WAIT_POLLS wait"
  );
});

test("the module does not load event-log.js and ingest writes no event-log file", () => {
  const dir = newProject();
  copyFixture(dir);
  drain(I.createClaudeCodeIngest({ projectDir: dir }));
  const loaded = Object.keys(require.cache).filter((k) =>
    /[\\/](event-log|live-bridge)\.js$/.test(k)
  );
  assert.deepEqual(loaded, []);
  assert.deepEqual(fs.readdirSync(EVENT_DIR), []);
});

// ---- per-poll facts and catch-up polls (the bridge reads these instead of guessing) ----

const busyOn = (match, count, calls) =>
  function (orig) {
    let left = count;
    return function (p, ...a) {
      if (match(p, a) && left > 0) {
        left -= 1;
        if (calls) calls.n += 1;
        throw EBUSY();
      }
      return orig.call(this, p, ...a);
    };
  };

test("facts: parentRead is true only when this poll read the current parent to its end", () => {
  const dir = newProject();
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  assert.equal(ing.stats().parentRead, false, "an empty folder has no session to read");
  copyFixture(dir);
  ing.poll();
  const st = ing.stats();
  assert.equal(st.parentRead, true);
  assert.equal(st.capped, false);
  assert.equal(st.more, false);
  assert.equal(st.waiting, false);
  ing.poll();
  assert.equal(ing.stats().parentRead, true, "nothing new to read still counts as read");
  assert.ok(!JSON.stringify(ing.stats()).includes(dir), "path-free");
});

test("facts: a failed parent lstat or open leaves parentRead false, even on the first poll", () => {
  for (const kind of ["openSync", "lstatSync"]) {
    const dir = newProject();
    copyFixture(dir);
    const parentFile = path.join(dir, "s1.jsonl");
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    const calls = { n: 0 };
    const first = withStub(
      kind,
      busyOn(
        (p, a) => p === parentFile && (kind === "openSync" || (a[0] && a[0].bigint)),
        1,
        calls
      ),
      () => ing.poll()
    );
    assert.equal(calls.n, 1, kind + " fault applied");
    assert.deepEqual(first, []);
    const st = ing.stats();
    assert.equal(st.sessions, 1, "the session was adopted all the same");
    assert.equal(st.parentRead, false, kind + ": a failed read is not a read");
    ing.poll();
    assert.equal(ing.stats().parentRead, true, "the next poll reads it");
  }
});

test("facts: a capped parent is not read to its end until drained", () => {
  const dir = newProject();
  const filler = JSON.stringify({ type: "system", pad: "x".repeat(900) });
  const lines = [];
  for (let n = 0; n < Math.ceil((T.TRANSCRIPT_READ_MAX_PER_POLL * 2) / 900); n++)
    lines.push(filler);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  assert.equal(ing.stats().capped, true);
  assert.equal(ing.stats().parentRead, false);
  for (let i = 0; i < 5 && ing.stats().capped; i++) ing.poll({ catchUp: true });
  assert.equal(ing.stats().capped, false);
  assert.equal(ing.stats().parentRead, true);
});

test("facts: a reset (shrink) whose read fails is not a read; the next poll is", () => {
  const dir = newProject();
  const L = parentLines();
  const parentFile = path.join(dir, "s1.jsonl");
  fs.writeFileSync(parentFile, L.slice(0, 6).join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  assert.equal(ing.stats().parentRead, true);
  fs.writeFileSync(parentFile, L.slice(0, 2).join("\n") + "\n"); // shrunk
  withStub(
    "openSync",
    busyOn((p) => p === parentFile, 1),
    () => ing.poll()
  );
  assert.equal(ing.stats().sessions, 2, "the shrink reset the session");
  assert.equal(ing.stats().parentRead, false);
  ing.poll();
  assert.equal(ing.stats().parentRead, true);
});

test("facts: a vanished parent is not a read", () => {
  const dir = newProject();
  copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  fs.rmSync(path.join(dir, "s1.jsonl"));
  ing.poll();
  assert.equal(ing.stats().parentRead, false);
});

test("facts: waiting covers a child hold, a meta wait and a session hold", () => {
  // child hold
  const h = holdProject(34, false);
  const ing = I.createClaudeCodeIngest({ projectDir: h.dir });
  ing.poll();
  let st = ing.stats();
  assert.equal(st.parentRead, true, "the parent itself was read");
  assert.deepEqual([st.waiting, st.more, st.heldChildren, st.metaWaiting], [true, true, 1, 0]);
  fs.appendFileSync(h.parentFile, h.L[34] + "\n");
  ing.poll();
  assert.equal(ing.stats().waiting, false);
  // meta wait
  const dir = newProject();
  const sub = copyFixture(dir);
  fs.rmSync(path.join(sub, "agent-a1.meta.json"));
  const m = I.createClaudeCodeIngest({ projectDir: dir });
  m.poll();
  st = m.stats();
  assert.deepEqual([st.waiting, st.more, st.metaWaiting], [true, true, 1]);
  m.poll();
  m.poll();
  assert.deepEqual([m.stats().waiting, m.stats().metaWaiting], [false, 0]);
  // session hold
  const d3 = newProject();
  const a = path.join(d3, "a.jsonl");
  const b = path.join(d3, "b.jsonl");
  fs.writeFileSync(a, parentLines().slice(0, 3).join("\n") + "\n");
  fs.writeFileSync(b, parentLines().slice(0, 4).join("\n") + "\n");
  fs.utimesSync(a, new Date(2026, 3, 1), new Date(2026, 3, 1));
  fs.utimesSync(b, new Date(2026, 3, 1), new Date(2026, 3, 1));
  const clock = mkClock();
  const s = I.createClaudeCodeIngest({ projectDir: d3, now: clock });
  s.poll();
  assert.equal(s.stats().waiting, false);
  fs.utimesSync(b, new Date(2026, 3, 5), new Date(2026, 3, 5));
  clock.advance();
  s.poll();
  assert.deepEqual([s.stats().waiting, s.stats().more], [true, false], "a session hold is a wait");
});

test("catch-up polls do not advance the child hold: only regular polls count", () => {
  const { dir } = holdProject(34, false);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  for (let i = 0; i < 30; i++) {
    assert.ok(!ing.poll({ catchUp: true }).some(isChildRow));
    assert.equal(ing.stats().heldChildren, 1);
  }
  // the hold still lasts HOLD_CHILD_POLLS regular polls in total (one is already spent)
  for (let i = 2; i <= I.HOLD_CHILD_POLLS; i++) {
    assert.ok(!ing.poll().some(isChildRow), "still held on regular poll " + i);
  }
  assert.ok(
    ing.poll().some((r) => isChildRow(r) && r.type === "spawn"),
    "released after that"
  );
});

test("catch-up polls do not advance the meta wait", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  fs.rmSync(path.join(sub, "agent-a2.meta.json"));
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const isA2 = (r) => /^subagent/.test(r.source) && r.agentId === "a2";
  assert.ok(!ing.poll().some(isA2));
  for (let i = 0; i < 30; i++) {
    assert.ok(!ing.poll({ catchUp: true }).some(isA2), "catch-up poll " + i);
    assert.equal(ing.stats().metaWaiting, 1);
  }
  assert.ok(!ing.poll().some(isA2), "second regular poll still waits");
  assert.ok(ing.poll().some(isA2), "third regular poll runs without the meta, as before");
});

test("catch-up polls do not advance the session hold", () => {
  const dir = newProject();
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  fs.writeFileSync(a, parentLines().slice(0, 3).join("\n") + "\n");
  fs.writeFileSync(b, parentLines().slice(0, 4).join("\n") + "\n");
  fs.utimesSync(a, new Date(2026, 3, 1), new Date(2026, 3, 1));
  fs.utimesSync(b, new Date(2026, 3, 1), new Date(2026, 3, 1));
  const clock = mkClock();
  const ing = I.createClaudeCodeIngest({ projectDir: dir, now: clock });
  ing.poll();
  fs.utimesSync(b, new Date(2026, 3, 5), new Date(2026, 3, 5));
  for (let i = 0; i < 20; i++) {
    clock.advance();
    ing.poll({ catchUp: true });
  }
  assert.equal(ing.stats().sessions, 1, "twenty catch-up polls never switch");
  for (let i = 1; i <= I.HOLD_POLLS; i++) {
    assert.equal(ing.stats().sessions, 1, "not yet switched before regular poll " + i);
    clock.advance();
    ing.poll();
  }
  assert.equal(ing.stats().sessions, 2, "the switch needs HOLD_POLLS regular polls");
});

test("catch-up polls do not advance the idle counters", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const a1 = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  for (let i = 0; i < 5 * I.IDLE_AFTER; i++) ing.poll({ catchUp: true });
  let calls = 0;
  withStub(
    "lstatSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === a1) calls += 1;
        return orig.call(this, p, ...a);
      },
    () => ing.poll()
  );
  assert.equal(calls, 1, "the child is not idle yet: a regular poll still stats it");
});

test("catch-up polls still read capped bytes", () => {
  const dir = newProject();
  const filler = JSON.stringify({ type: "system", pad: "x".repeat(900) });
  const lines = [];
  for (let n = 0; n < Math.ceil((T.TRANSCRIPT_READ_MAX_PER_POLL * 3) / 900); n++)
    lines.push(filler);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  ing.poll();
  let n = 0;
  while (ing.stats().capped && n++ < 10) ing.poll({ catchUp: true });
  assert.equal(ing.stats().capped, false);
  assert.equal(ing.stats().parentRead, true);
  assert.ok(ing.stats().lines >= lines.length, "every line was read");
});

test("facts: a transient failure on a child never read holds the live phase, then lets go", () => {
  for (const kind of ["openSync", "lstatSync"]) {
    const dir = newProject();
    const sub = copyFixture(dir);
    const child = path.join(sub, "agent-a1.jsonl");
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    const calls = { n: 0 };
    withStub(
      kind,
      busyOn((p, a) => p === child && (kind === "openSync" || (a[0] && a[0].bigint)), 1, calls),
      () => ing.poll()
    );
    assert.equal(calls.n, 1, kind + " fault applied");
    let st = ing.stats();
    assert.equal(st.parentRead, true, "the parent itself was read");
    assert.equal(st.waiting, true, kind + ": an unread child that failed is a pending wait");
    assert.equal(st.more, false, "more keeps its meaning");
    ing.poll();
    st = ing.stats();
    assert.equal(st.waiting, false, kind + ": the next regular poll read it");
    assert.ok(ing.poll().length === 0 && ing.stats().lines > 0);
  }
});

test("facts: a child that keeps failing holds the live phase for a bounded number of polls", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const child = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const flags = withStub(
    "lstatSync",
    busyOn((p, a) => p === child && a[0] && a[0].bigint, 100),
    () => {
      const out = [];
      for (let i = 0; i < 5; i++) ing.poll({ catchUp: true }); // re-polls never use the wait up
      for (let i = 0; i < I.FAULT_WAIT_POLLS + 2; i++) {
        ing.poll();
        out.push(ing.stats().waiting);
      }
      return out;
    }
  );
  assert.deepEqual(
    flags,
    [...Array(I.FAULT_WAIT_POLLS).fill(true), false, false],
    "waits FAULT_WAIT_POLLS regular polls, then stops waiting"
  );
  assert.ok(ing.stats().drift.unreadable >= I.FAULT_WAIT_POLLS, "every failure is counted");
});

test("facts: a failed subagents listing holds the live phase, a missing folder does not", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const calls = { n: 0 };
  withStub(
    "readdirSync",
    busyOn((p) => String(p) === sub, 1, calls),
    () => ing.poll()
  );
  assert.equal(calls.n, 1, "listing fault applied");
  assert.equal(ing.stats().waiting, true);
  ing.poll();
  assert.equal(ing.stats().waiting, false);
  const plain = newProject();
  fs.copyFileSync(path.join(dir, "s1.jsonl"), path.join(plain, "s1.jsonl"));
  const none = I.createClaudeCodeIngest({ projectDir: plain });
  none.poll();
  assert.equal(none.stats().waiting, false, "no subagents folder at all is not a fault");
});

test("facts: a child bigger than one read that fails on its second chunk still holds the live phase", () => {
  for (const kind of ["openSync", "lstatSync"]) {
    const dir = newProject();
    const sub = copyFixture(dir);
    const child = path.join(sub, "agent-a1.jsonl");
    const filler = JSON.stringify({ type: "x", pad: "y".repeat(900) }) + String.fromCharCode(10);
    fs.writeFileSync(child, filler.repeat(400) + fs.readFileSync(child, "utf8"));
    assert.ok(fs.statSync(child).size > 300 * 1024, "larger than one read");
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    ing.poll();
    assert.equal(ing.stats().capped, true, "the first chunk was capped");
    const calls = { n: 0 };
    withStub(
      kind,
      busyOn((p, a) => p === child && (kind === "openSync" || (a[0] && a[0].bigint)), 1, calls),
      () => ing.poll({ catchUp: true })
    );
    assert.equal(calls.n, 1, kind + " fault applied");
    const st = ing.stats();
    assert.equal(st.waiting, true, kind + ": a failure part-way through the first read waits");
    for (let i = 0; i < 6 && ing.stats().capped; i++) ing.poll({ catchUp: true });
    ing.poll();
    assert.deepEqual([ing.stats().capped, ing.stats().waiting], [false, false], "then it drains");
  }
});

/** A session whose parent is bigger than one read, plus the rows a clean ingest yields for it. */
function bigParentProject() {
  const mk = () => {
    const dir = newProject();
    copyFixture(dir);
    const parent = path.join(dir, "s1.jsonl");
    const filler = JSON.stringify({ type: "x", pad: "y".repeat(900) }) + String.fromCharCode(10);
    fs.writeFileSync(parent, filler.repeat(400) + fs.readFileSync(parent, "utf8"));
    assert.ok(fs.statSync(parent).size > T.TRANSCRIPT_READ_MAX_PER_POLL, "larger than one read");
    return dir;
  };
  const clean = I.createClaudeCodeIngest({ projectDir: mk() });
  const rows = drain(clean);
  assert.ok(rows.length > 0 && clean.stats().parentRead, "the reference ingest reads everything");
  return { dir: mk(), rows, lines: clean.stats().lines };
}

/** The same fault must not claim the parent was read, lose rows, or duplicate them on recovery. */
function assertSecondChunkRecovery(ing, ref, got, label) {
  const st = ing.stats();
  assert.equal(st.parentRead, false, label + ": a failed chunk is not 'read to its end'");
  assert.equal(st.drift.unreadable >= 1, true, label + ": the failure is counted");
  const linesAtFault = st.lines;
  const all = got.concat(drain(ing));
  assert.equal(ing.stats().parentRead, true, label + ": the retry reads the parent to its end");
  assert.deepEqual(all, ref.rows, label + ": no row lost or duplicated");
  assert.equal(ing.stats().lines, ref.lines, label + ": every line parsed exactly once");
  assert.ok(ing.stats().lines > linesAtFault, label + ": the retry did the remaining work");
}

test("a parent whose second chunk fails on readSync is not claimed as read, then recovers", () => {
  const ref = bigParentProject();
  const ing = I.createClaudeCodeIngest({ projectDir: ref.dir });
  const got = ing.poll();
  assert.equal(ing.stats().capped, true, "the first chunk was capped");
  assert.equal(ing.stats().parentRead, false);
  const calls = { n: 0 };
  const second = withStub(
    "readSync",
    (orig) =>
      function (...a) {
        calls.n += 1;
        if (calls.n === 1) throw Object.assign(new Error("io"), { code: "EIO" });
        return orig.apply(this, a);
      },
    () => ing.poll()
  );
  assert.equal(calls.n >= 1, true, "fault applied");
  assert.deepEqual(second, [], "a failed chunk yields no rows");
  assertSecondChunkRecovery(ing, ref, got.concat(second), "readSync");
});

test("a parent whose second chunk fails the identity check is not claimed as read, then recovers", () => {
  const ref = bigParentProject();
  const ing = I.createClaudeCodeIngest({ projectDir: ref.dir });
  const got = ing.poll();
  assert.equal(ing.stats().capped, true, "the first chunk was capped");
  const calls = { n: 0 };
  const second = withStub(
    "fstatSync",
    (orig) =>
      function (fd, o, ...rest) {
        const st = orig.call(this, fd, o, ...rest);
        if (calls.n++ > 0 || !(o && o.bigint)) return st;
        // the name now holds another file: same shape, different identity
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          ino: st.ino + 1n,
          dev: st.dev + 1n
        });
      },
    () => ing.poll()
  );
  assert.equal(calls.n >= 1, true, "fault applied");
  assert.deepEqual(second, [], "a changed identity yields no rows");
  assertSecondChunkRecovery(ing, ref, got.concat(second), "identity");
});

test("a read that returns a short first chunk and then fails reads nothing and recovers", () => {
  const ref = bigParentProject();
  const ing = I.createClaudeCodeIngest({ projectDir: ref.dir });
  const calls = { n: 0 };
  const first = withStub(
    "readSync",
    (orig) =>
      function (fd, buf, off, len, pos) {
        calls.n += 1;
        if (calls.n === 1) return orig.call(this, fd, buf, off, Math.min(len, 4096), pos);
        if (calls.n === 2) throw Object.assign(new Error("io"), { code: "EIO" });
        return orig.call(this, fd, buf, off, len, pos);
      },
    () => ing.poll()
  );
  assert.equal(calls.n, 2, "the second readSync of one read failed");
  assert.deepEqual(first, [], "bytes before the failure are not used");
  assertSecondChunkRecovery(ing, ref, first, "short-then-fail");
});

test("facts: a failed subagents folder check holds the live phase", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const calls = { n: 0 };
  withStub(
    "lstatSync",
    busyOn((p) => String(p) === sub, 1, calls),
    () => ing.poll()
  );
  assert.equal(calls.n, 1, "folder fault applied");
  assert.equal(ing.stats().waiting, true);
  ing.poll();
  assert.equal(ing.stats().waiting, false);
});

test("facts: a child that vanishes (missing, not busy) is not a fault", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const child = path.join(sub, "agent-a1.jsonl");
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  withStub(
    "lstatSync",
    (orig) =>
      function (p, ...a) {
        if (String(p) === child) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return orig.call(this, p, ...a);
      },
    () => ing.poll()
  );
  assert.equal(ing.stats().waiting, false, "a missing child holds nothing");
});

test("facts: a child already read to its end that then fails does NOT hold the live phase", () => {
  for (const kind of ["openSync", "lstatSync"]) {
    const dir = newProject();
    const sub = copyFixture(dir);
    const child = path.join(sub, "agent-a1.jsonl");
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    drain(ing);
    assert.equal(ing.stats().waiting, false, "read to its end");
    // new data to read, so openSync is reached; the failure is on a file that was fully read once
    fs.appendFileSync(
      child,
      JSON.stringify({ type: "system", note: "more" }) + String.fromCharCode(10)
    );
    const calls = { n: 0 };
    withStub(
      kind,
      busyOn((p, a) => p === child && (kind === "openSync" || (a[0] && a[0].bigint)), 1, calls),
      () => ing.poll()
    );
    assert.equal(calls.n, 1, kind + " fault applied");
    assert.equal(ing.stats().waiting, false, kind + ": new data is live data, no wait");
  }
});

test("facts: a child with nothing to read counts as read to its end (the size <= offset branch)", () => {
  const dir = newProject();
  const sub = copyFixture(dir);
  const child = path.join(sub, "agent-empty.jsonl");
  fs.writeFileSync(child, "");
  fs.writeFileSync(
    path.join(sub, "agent-empty.meta.json"),
    JSON.stringify({ agentType: "worker" })
  );
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  drain(ing);
  const calls = { n: 0 };
  withStub(
    "lstatSync",
    busyOn((p, a) => p === child && a[0] && a[0].bigint, 1, calls),
    () => ing.poll()
  );
  assert.equal(calls.n, 1, "lstat fault applied");
  assert.equal(
    ing.stats().waiting,
    false,
    "an empty child was read to its end: a failure is not a wait"
  );
});

test("catch-up polls do not advance the idle skipped counter: the next real lstat comes at the same regular poll", () => {
  const regularPollsUntilLstat = (extraCatchUps) => {
    const dir = newProject();
    const sub = copyFixture(dir);
    const a1 = path.join(sub, "agent-a1.jsonl");
    const ing = I.createClaudeCodeIngest({ projectDir: dir });
    drain(ing);
    for (let i = 0; i < I.IDLE_AFTER + 2; i++) ing.poll(); // settle into idle
    for (let i = 0; i < extraCatchUps; i++) ing.poll({ catchUp: true });
    let calls = 0;
    return withStub(
      "lstatSync",
      (orig) =>
        function (p, ...a) {
          if (String(p) === a1) calls += 1;
          return orig.call(this, p, ...a);
        },
      () => {
        for (let n = 1; n <= 3 * I.IDLE_EVERY; n++) {
          ing.poll();
          if (calls > 0) return n;
        }
        return -1;
      }
    );
  };
  const plain = regularPollsUntilLstat(0);
  assert.ok(plain > 0, "an idle child is stat'ed again within a few periods");
  assert.equal(
    regularPollsUntilLstat(3 * I.IDLE_EVERY),
    plain,
    "catch-up polls left skipped alone"
  );
});

test("with no session known, a new top-level session is found even when the folder mtime does not change", () => {
  const dir = newProject();
  const frozen = fs.statSync(dir);
  const ing = I.createClaudeCodeIngest({ projectDir: dir });
  const found = withStub(
    "statSync",
    (orig) =>
      function (p, ...a) {
        const st = orig.call(this, p, ...a);
        // the folder reports the same (pre-create) mtime on every call
        return String(p) === dir
          ? Object.assign(Object.create(st), { mtimeMs: frozen.mtimeMs })
          : st;
      },
    () => {
      ing.poll();
      assert.equal(ing.stats().sessions, 0, "empty folder, no session");
      copyFixture(dir);
      ing.poll();
      return ing.stats().sessions;
    }
  );
  assert.equal(found, 1, "the new session is listed on the next poll, no sleep, no mtime change");
  assert.equal(ing.stats().parentRead, true);
});
