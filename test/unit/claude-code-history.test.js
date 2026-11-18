/**
 * lib/claude-code-history.js: the list rule (20 newest and the last 14 days, whichever is fewer),
 * opaque ids, the refusals, the caps, subagent grouping, the privacy scrub and the read-only
 * guarantee. Everything lives in a folder under the repo's gitignored .scratch/ (never system temp).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const H = require("../../lib/claude-code-history");
const L = require("../helpers/claude-lines");
const { buildForbidden } = require("../helpers/privacy-patterns");

const ROOT = path.join(__dirname, "..", "..", ".scratch", "history-test-" + process.pid);
const SALT = Buffer.alloc(16, 7);
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PLANTED = "zqplanted";
const PROMPT = "zqprompttoken";
const SECRET_FILE = "/home/" + PLANTED + "/proj-demo/zqsecretfile.js";
const opts = (extra) => ({ salt: SALT, now: () => NOW, ...extra });

let n = 0;
function projectDir() {
  const dir = path.join(ROOT, "p" + n++);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const idOf = (k) => "0000000" + k.toString(16).padStart(1, "0") + "-aaaa-4bbb-8ccc-dddddddddddd";

/** A session file, with its mtime set (seconds precision, so exact comparisons hold). */
function plant(dir, name, text, mtimeMs) {
  const file = path.join(dir, name + ".jsonl");
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
const tiny = () => L.userTurn("hello " + PROMPT) + "\n";

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test("list: newest first, opaque ids, times, subagent count", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 3 * 3600 * 1000);
  plant(dir, idOf(2), tiny(), NOW - 1 * 3600 * 1000);
  plant(dir, idOf(3), tiny(), NOW - 2 * 3600 * 1000);
  const sub = path.join(dir, idOf(2), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), tiny());
  fs.writeFileSync(path.join(sub, "agent-a2.jsonl"), tiny());
  fs.writeFileSync(path.join(sub, "agent-a1.meta.json"), "{}");
  const r = H.listSessions(dir, opts());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.sessions.map((s) => s.lastAt),
    [NOW - 3600e3, NOW - 7200e3, NOW - 3 * 3600e3].map((t) => new Date(t).toISOString())
  );
  assert.deepStrictEqual(
    r.sessions.map((s) => s.subagents),
    [2, 0, 0]
  );
  assert.strictEqual(r.sessions[0].events, null);
  assert.ok(r.sessions[0].startedAt, "start time read from the first line");
  const text = JSON.stringify(r);
  for (const s of r.sessions) assert.match(s.id, /^cs-[0-9a-f]{24}$/);
  assert.ok(!text.includes("0000000"), "no file name in the body");
  assert.ok(!text.includes(ROOT) && !text.includes(".jsonl"), "no folder or file name");
  // same salt -> same ids; another salt -> other ids
  assert.deepStrictEqual(
    H.listSessions(dir, opts()).sessions.map((s) => s.id),
    r.sessions.map((s) => s.id)
  );
  const other = H.listSessions(dir, opts({ salt: Buffer.alloc(16, 9) }));
  assert.notStrictEqual(other.sessions[0].id, r.sessions[0].id);
});

test("list: at most 20 when more are recent", () => {
  const dir = projectDir();
  for (let i = 0; i < 21; i++) plant(dir, idOf(i), tiny(), NOW - (i + 1) * 60000);
  const r = H.listSessions(dir, opts());
  assert.strictEqual(r.sessions.length, 20);
  assert.strictEqual(r.sessions[19].lastAt, new Date(NOW - 20 * 60000).toISOString());
});

test("list: exactly 20 sessions give 20 (the limit itself)", () => {
  const dir = projectDir();
  for (let i = 0; i < 20; i++) plant(dir, idOf(i), tiny(), NOW - (i + 1) * 60000);
  assert.strictEqual(H.listSessions(dir, opts()).sessions.length, 20);
});

test("list: fewer when only some are inside 14 days; the 14-day edge", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - DAY);
  plant(dir, idOf(2), tiny(), NOW - 14 * DAY); // exactly 14 days: still listed
  plant(dir, idOf(3), tiny(), NOW - 14 * DAY - 1000); // one second older: not listed
  plant(dir, idOf(4), tiny(), NOW - 30 * DAY);
  const r = H.listSessions(dir, opts());
  assert.deepStrictEqual(
    r.sessions.map((s) => s.lastAt),
    [NOW - DAY, NOW - 14 * DAY].map((t) => new Date(t).toISOString())
  );
});

test("list: old sessions never fill the list beyond the 20 newest", () => {
  const dir = projectDir();
  // 20 newer ones are all older than 14 days except 2: the list is those 2, not 20
  for (let i = 0; i < 18; i++) plant(dir, idOf(i), tiny(), NOW - (20 + i) * DAY);
  plant(dir, idOf(30), tiny(), NOW - 1 * DAY);
  plant(dir, idOf(31), tiny(), NOW - 2 * DAY);
  assert.strictEqual(H.listSessions(dir, opts()).sessions.length, 2);
});

test("list: only regular lower-case .jsonl files; a missing folder is a path-free refusal", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "UPPER.JSONL"), tiny());
  fs.mkdirSync(path.join(dir, "folder.jsonl"));
  assert.strictEqual(H.listSessions(dir, opts()).sessions.length, 1);
  const missing = H.listSessions(path.join(ROOT, "no-such-folder"), opts());
  assert.strictEqual(missing.ok, false);
  assert.ok(!JSON.stringify(missing).includes("no-such-folder"));
});

test("list: a symlinked .jsonl is not listed and cannot be loaded", (t) => {
  const dir = projectDir();
  const outside = path.join(ROOT, "outside-" + n++ + ".jsonl");
  fs.writeFileSync(outside, tiny());
  fs.utimesSync(outside, NOW / 1000, NOW / 1000);
  try {
    fs.symlinkSync(outside, path.join(dir, idOf(9) + ".jsonl"));
  } catch (e) {
    t.skip("symlinks cannot be created on this machine: " + e.code);
    return;
  }
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const r = H.listSessions(dir, opts());
  assert.strictEqual(r.sessions.length, 1);
  const linkId = H.sessionId(SALT, dir, idOf(9) + ".jsonl");
  const l = H.loadSession(dir, linkId, opts());
  assert.strictEqual(l.ok, false);
  assert.strictEqual(l.status, 400);
});

test("load: a subagents folder reached through a junction or link is not read", (t) => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const real = path.join(ROOT, "real-subs-" + n++);
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "agent-x.jsonl"), tiny());
  fs.mkdirSync(path.join(dir, idOf(1)), { recursive: true });
  try {
    fs.symlinkSync(real, path.join(dir, idOf(1), "subagents"), "junction");
  } catch (e) {
    t.skip("links cannot be created on this machine: " + e.code);
    return;
  }
  const [s] = H.listSessions(dir, opts()).sessions;
  assert.strictEqual(s.subagents, 0);
  const l = H.loadSession(dir, s.id, opts());
  assert.strictEqual(l.counts.files, 1);
  assert.deepStrictEqual(l.agents, []);
});

/** A session whose parent delegates to an Explore child that has its own file and meta. */
function plantFamily(dir, name, mtimeMs) {
  const parent = [
    JSON.stringify({ type: "user", cwd: "/home/" + PLANTED + "/proj-demo", sessionId: L.SESSION }),
    L.userTurn("please do " + PROMPT),
    L.assistant([L.toolUse("toolu_r", "Read", { file_path: SECRET_FILE })]),
    L.assistant([L.agentCall("toolu_1", "Explore", "haiku", { prompt: PROMPT })]),
    L.agentResult("toolu_1", "agent1"),
    L.notification("toolu_1", "agent1", "completed")
  ].join("\n");
  plant(dir, name, parent + "\n", mtimeMs);
  const sub = path.join(dir, name, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const child = [
    JSON.stringify({
      isSidechain: true,
      agentId: "agent1",
      type: "user",
      message: { role: "user", content: "go " + PROMPT },
      timestamp: "2026-01-02T03:04:07.500Z",
      sessionId: L.SESSION
    }),
    JSON.stringify({
      isSidechain: true,
      agentId: "agent1",
      type: "assistant",
      timestamp: "2026-01-02T03:04:08.500Z",
      sessionId: L.SESSION,
      parentUuid: "p1",
      message: {
        id: "msg_child",
        model: "claude-haiku-5-5",
        content: [L.toolUse("toolu_c", "Read", { file_path: SECRET_FILE })],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    })
  ].join("\n");
  fs.writeFileSync(path.join(sub, "agent-agent1.jsonl"), child + "\n");
  fs.writeFileSync(
    path.join(sub, "agent-agent1.meta.json"),
    JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1" })
  );
}

test("load: events are replay rows, parent then children merged by time, children groupable", () => {
  const dir = projectDir();
  plantFamily(dir, idOf(1), NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, s.id);
  assert.strictEqual(r.truncated, false);
  assert.ok(r.events.length >= 5);
  assert.ok(r.events.every((e) => e.replay === true));
  assert.deepStrictEqual(
    r.events.map((e) => e.id),
    r.events.map((_e, i) => i + 1)
  );
  const times = r.events.map((e) => Date.parse(e.iso));
  assert.deepStrictEqual(
    times,
    [...times].sort((a, b) => a - b),
    "merged by time"
  );
  const kids = r.events.filter((e) => e.source === "subagent:1");
  assert.ok(kids.length >= 2, "the child's rows are in");
  assert.ok(r.events.some((e) => e.source === "session"));
  assert.deepStrictEqual(r.agents, [
    { key: "subagent:1", role: kids[0].role, parentToolUseId: "toolu_1" }
  ]);
  const spawn = r.events.find((e) => e.type === "spawn");
  assert.strictEqual(spawn.parentToolUseId, "toolu_1");
  assert.ok(r.events.some((e) => e.kind === "delegates" && e.childRole));
  assert.strictEqual(r.counts.files, 2);
});

test("load: equal timestamps keep parent before child, then file order", () => {
  const dir = projectDir();
  const same = "2026-01-02T03:04:05.000Z";
  const row = (extra) =>
    JSON.stringify({ type: "user", timestamp: same, sessionId: L.SESSION, ...extra });
  plant(dir, idOf(1), row({ message: { role: "user", content: "a" } }) + "\n", NOW - 1000);
  const sub = path.join(dir, idOf(1), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, "agent-z.jsonl"),
    row({ isSidechain: true, agentId: "z", message: { role: "user", content: "b" } }) + "\n"
  );
  fs.writeFileSync(
    path.join(sub, "agent-a.jsonl"),
    row({ isSidechain: true, agentId: "a", message: { role: "user", content: "c" } }) + "\n"
  );
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts());
  assert.deepStrictEqual(
    r.events.map((e) => e.source),
    ["session", "subagent:1", "subagent:2"]
  );
});

test("load: an id the server did not list is refused with 400", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  plant(dir, idOf(2), tiny(), NOW - 40 * DAY); // exists but is not offered
  const [s] = H.listSessions(dir, opts()).sessions;
  const aged = H.sessionId(SALT, dir, idOf(2) + ".jsonl");
  const bad = [
    "cs-" + "0".repeat(24), // well formed, unknown
    aged, // a real file that is not in the listing
    idOf(1), // a file base name
    idOf(1) + ".jsonl",
    "../" + idOf(1),
    path.join(dir, idOf(1) + ".jsonl"),
    "cs-" + s.id.slice(3).toUpperCase(),
    "",
    s.id + "x",
    null,
    undefined,
    42,
    { id: s.id },
    [s.id]
  ];
  for (const id of bad) {
    const r = H.loadSession(dir, id, opts());
    assert.strictEqual(r.ok, false, "refused: " + JSON.stringify(id));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.error, "Unknown session");
  }
  assert.strictEqual(H.loadSession(dir, s.id, opts()).ok, true);
  // an id of another install (another salt) is unknown here
  assert.strictEqual(H.loadSession(dir, s.id, opts({ salt: Buffer.alloc(16, 1) })).ok, false);
});

test("load: the event cap sets truncated at one past the limit, not at the limit", () => {
  const dir = projectDir();
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(L.userTurn("t" + i));
  plant(dir, idOf(1), lines.join("\n") + "\n", NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  const full = H.loadSession(dir, s.id, opts());
  assert.strictEqual(full.events.length, 5);
  const exact = H.loadSession(dir, s.id, opts({ caps: { maxEvents: 5 } }));
  assert.strictEqual(exact.events.length, 5);
  assert.strictEqual(exact.truncated, false);
  const cut = H.loadSession(dir, s.id, opts({ caps: { maxEvents: 4 } }));
  assert.strictEqual(cut.events.length, 4);
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.counts.events, 4);
  assert.strictEqual(H.MAX_EVENTS, 20000);
});

test("load: the byte cap sets truncated and reports the bytes read", () => {
  const dir = projectDir();
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(L.userTurn("t" + i));
  const text = lines.join("\n") + "\n";
  plant(dir, idOf(1), text, NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  const size = Buffer.byteLength(text);
  const exact = H.loadSession(dir, s.id, opts({ caps: { maxBytes: size } }));
  assert.strictEqual(exact.truncated, false);
  assert.strictEqual(exact.events.length, 40);
  assert.strictEqual(exact.counts.bytesRead, size);
  const cut = H.loadSession(dir, s.id, opts({ caps: { maxBytes: size - 1 } }));
  assert.strictEqual(cut.truncated, true);
  assert.ok(cut.events.length < 40 && cut.events.length > 0);
  assert.ok(cut.counts.bytesRead <= size - 1);
});

test("load: the child cap sets truncated", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const sub = path.join(dir, idOf(1), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const k of ["a", "b", "c"])
    fs.writeFileSync(path.join(sub, "agent-" + k + ".jsonl"), tiny());
  const [s] = H.listSessions(dir, opts()).sessions;
  assert.strictEqual(H.loadSession(dir, s.id, opts({ caps: { maxChildren: 3 } })).truncated, false);
  const cut = H.loadSession(dir, s.id, opts({ caps: { maxChildren: 2 } }));
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.counts.files, 3);
});

test("load: bad lines, an oversize line and an unterminated last line are handled", () => {
  const dir = projectDir();
  const big = JSON.stringify({ type: "system", pad: "x".repeat(300 * 1024) });
  const last = L.userTurn("last, no newline");
  plant(
    dir,
    idOf(1),
    [L.userTurn("a"), "not json", big, L.userTurn("b")].join("\n") + "\n" + last,
    NOW - 1000
  );
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.events.length, 3, "a, b and the unterminated last line");
  assert.strictEqual(r.counts.unparsed, 1);
  assert.strictEqual(r.counts.oversize, 1);
  assert.strictEqual(r.truncated, false);
});

test("load: a line with no timestamp keeps the previous row's time, not the load time", () => {
  const dir = projectDir();
  const at = (iso, text) =>
    JSON.stringify({ type: "user", timestamp: iso, message: { role: "user", content: text } });
  const noTime = JSON.stringify({ type: "user", message: { role: "user", content: "no time" } });
  const t1 = "2026-01-02T03:04:05.000Z";
  const t3 = "2026-01-02T03:09:05.000Z";
  plant(dir, idOf(1), [at(t1, "one"), noTime, at(t3, "three")].join("\n") + "\n", NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.events.length, 3);
  assert.deepStrictEqual(
    r.events.map((e) => e.iso),
    [t1, t1, t3],
    "the row without a time sits between its neighbours, dated like the one before it"
  );
});

test("load: a first row with no timestamp takes the file's modification time", () => {
  const dir = projectDir();
  const noTime = JSON.stringify({ type: "user", message: { role: "user", content: "no time" } });
  const mtime = NOW - 5 * DAY;
  plant(dir, idOf(1), noTime + "\n", mtime);
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts());
  assert.strictEqual(r.events[0].iso, new Date(mtime).toISOString());
});

test("load: skipping an oversize line stays inside the byte cap", () => {
  const dir = projectDir();
  const big = JSON.stringify({ type: "system", pad: "x".repeat(3 * 1024 * 1024) });
  plant(dir, idOf(1), [L.userTurn("a"), big, L.userTurn("b")].join("\n") + "\n", NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  const cut = H.loadSession(dir, s.id, opts({ caps: { maxBytes: 1024 * 1024 } }));
  assert.strictEqual(cut.truncated, true, "the budget ended inside the long line");
  assert.ok(
    cut.counts.bytesRead <= 1024 * 1024,
    "never reads past the cap: " + cut.counts.bytesRead
  );
  const whole = H.loadSession(dir, s.id, opts());
  assert.strictEqual(whole.truncated, false);
  assert.strictEqual(whole.events.length, 2, "with room, the long line is skipped and b is read");
});

test("load: an unreadable folder or session is a path-free refusal, not a crash", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const [s] = H.listSessions(dir, opts()).sessions;
  fs.rmSync(path.join(dir, idOf(1) + ".jsonl"));
  const gone = H.loadSession(dir, s.id, opts());
  assert.strictEqual(gone.ok, false);
  const nofolder = H.loadSession(path.join(ROOT, "nope-" + PLANTED), s.id, opts());
  assert.strictEqual(nofolder.ok, false);
  for (const r of [gone, nofolder]) {
    const text = JSON.stringify(r);
    assert.ok(!text.includes(ROOT) && !text.includes(PLANTED) && !text.includes(".jsonl"), text);
  }
});

test("load: planted paths, prompt text and file names never reach a body", () => {
  const dir = projectDir();
  plantFamily(dir, idOf(1), NOW - 1000);
  const forbidden = buildForbidden([
    PLANTED,
    PROMPT,
    ROOT,
    JSON.stringify(ROOT).slice(1, -1),
    "agent-agent1"
  ]);
  const list = H.listSessions(dir, opts());
  const r = H.loadSession(dir, list.sessions[0].id, opts());
  for (const text of [JSON.stringify(list), JSON.stringify(r)]) {
    assert.ok(!forbidden.test(text), "forbidden text found: " + (forbidden.exec(text) || [])[0]);
    assert.ok(!text.includes(idOf(1)), "the session file name is not in a body");
  }
  const read = r.events.find((e) => e.activity && e.activity.kind === "read");
  assert.strictEqual(read.message, "read · zqsecretfile.js");
  assert.strictEqual(read.activity.path, "zqsecretfile.js");
});

test("read-only: planted files keep their bytes and mtime, and nothing is written", () => {
  const dir = projectDir();
  plantFamily(dir, idOf(1), NOW - 1000);
  const snap = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push([p, fs.readFileSync(p, "utf8"), fs.statSync(p).mtimeMs]);
      }
    };
    walk(dir);
    return JSON.stringify(out);
  };
  const before = snap();
  const names = [
    "writeFileSync",
    "appendFileSync",
    "writeSync",
    "unlinkSync",
    "rmSync",
    "renameSync",
    "mkdirSync",
    "utimesSync",
    "truncateSync",
    "copyFileSync",
    "symlinkSync"
  ];
  const orig = {};
  const hits = [];
  for (const k of names) {
    orig[k] = fs[k];
    fs[k] = (...a) => {
      hits.push(k);
      return orig[k](...a);
    };
  }
  const origOpen = fs.openSync;
  fs.openSync = (p, flags, ...rest) => {
    if (typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0)
      hits.push("openSync:write");
    if (typeof flags === "string" && !/^r$/.test(flags)) hits.push("openSync:" + flags);
    return origOpen(p, flags, ...rest);
  };
  try {
    const [s] = H.listSessions(dir, opts()).sessions;
    assert.strictEqual(H.loadSession(dir, s.id, opts()).ok, true);
  } finally {
    for (const k of names) fs[k] = orig[k];
    fs.openSync = origOpen;
  }
  assert.deepStrictEqual(hits, []);
  assert.strictEqual(snap(), before);
});

test("the module never loads the event log or History", () => {
  const code =
    "const H=require(" +
    JSON.stringify(path.join(__dirname, "..", "..", "lib", "claude-code-history.js")) +
    ");const bad=Object.keys(require.cache).filter(k=>/event-log/.test(k));" +
    "process.stdout.write(JSON.stringify({bad,ok:typeof H.listSessions}))";
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { bad: [], ok: "function" });
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "claude-code-history.js"),
    "utf8"
  );
  assert.ok(!/recordHistoryEvent|require\([^)]*event-log/.test(src));
});

test("a salt that is not a 16-byte buffer is refused", () => {
  const dir = projectDir();
  assert.throws(() => H.listSessions(dir, { salt: "text", now: () => NOW }));
  assert.throws(() => H.loadSession(dir, "cs-" + "0".repeat(24), { now: () => NOW }));
});

test("load: a malformed id is refused before the folder is listed", () => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const orig = fs.readdirSync;
  let listed = 0;
  fs.readdirSync = (...a) => {
    listed += 1;
    return orig(...a);
  };
  try {
    for (const id of ["../x", idOf(1), "cs-zz", "", null, 7]) {
      assert.strictEqual(H.loadSession(dir, id, opts()).status, 400);
    }
    assert.strictEqual(listed, 0);
    H.loadSession(dir, "cs-" + "0".repeat(24), opts());
    assert.ok(listed > 0, "a well formed id does list (the spy works)");
  } finally {
    fs.readdirSync = orig;
  }
});

test("load: a parent swapped for a link after the listing is refused", (t) => {
  const dir = projectDir();
  const name = idOf(1) + ".jsonl";
  const file = plant(dir, idOf(1), tiny(), NOW - 1000);
  const outside = path.join(ROOT, "swap-target-" + n++ + ".jsonl");
  fs.writeFileSync(outside, tiny());
  const [s] = H.listSessions(dir, opts()).sessions;
  const orig = fs.lstatSync;
  let hits = 0;
  let swapped = true;
  fs.lstatSync = (p, ...a) => {
    if (String(p) === file && ++hits === 2) {
      // the second lstat of the parent is the one in loadSession (the first is the listing)
      fs.rmSync(file);
      try {
        fs.symlinkSync(outside, file);
      } catch (_e) {
        swapped = false;
      }
    }
    return orig(p, ...a);
  };
  let r;
  try {
    r = H.loadSession(dir, s.id, opts());
  } finally {
    fs.lstatSync = orig;
  }
  if (!swapped) {
    t.skip("links cannot be created on this machine");
    return;
  }
  assert.ok(hits >= 2 && name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 404, "refused by the regular-file check, before any open");
});

test("load: a symlinked subagent file is neither counted nor read", (t) => {
  const dir = projectDir();
  plant(dir, idOf(1), tiny(), NOW - 1000);
  const sub = path.join(dir, idOf(1), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-real.jsonl"), tiny());
  const outside = path.join(ROOT, "child-target-" + n++ + ".jsonl");
  fs.writeFileSync(outside, tiny());
  try {
    fs.symlinkSync(outside, path.join(sub, "agent-link.jsonl"));
  } catch (e) {
    t.skip("symlinks cannot be created on this machine: " + e.code);
    return;
  }
  const [s] = H.listSessions(dir, opts()).sessions;
  assert.strictEqual(s.subagents, 1);
  const r = H.loadSession(dir, s.id, opts());
  assert.strictEqual(r.counts.files, 2);
  assert.strictEqual(r.counts.unreadableFiles, 0);
});

test("load: a byte cap used up by the parent still marks the children as cut", () => {
  const dir = projectDir();
  const text = tiny();
  plant(dir, idOf(1), text, NOW - 1000);
  const sub = path.join(dir, idOf(1), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), tiny());
  const [s] = H.listSessions(dir, opts()).sessions;
  const r = H.loadSession(dir, s.id, opts({ caps: { maxBytes: Buffer.byteLength(text) } }));
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.events.length, 1, "only the parent line fitted");
});
