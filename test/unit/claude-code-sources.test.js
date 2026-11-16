/**
 * Source discovery (lib/claude-code-sources.js): Windows + running WSL distros, notes,
 * labels and privacy. Everything runs against a recording fake fs and a fake wsl runner;
 * no WSL, no network, no real home folder.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const { test } = require("node:test");
const S = require("../../lib/claude-code-sources.js");
const { buildForbidden } = require("../helpers/privacy-patterns");

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const PLANTED = "zqplanted";
const PRIVATE = buildForbidden([PLANTED]);
const NOW = 2e12;
const WSL_DEFAULT = "C:" + BS + "Windows" + BS + "System32" + BS + "wsl.exe";
const T1 = 1700000000000;
const T2 = 1700000100000;
const norm = (p) => p.split(BS).join("/");
const SALT = Buffer.alloc(16, 7);
const SALT2 = Buffer.alloc(16, 9);
const hmacHex = (salt, text) => crypto.createHmac("sha256", salt).update(text).digest("hex");
const hash6 = (p, salt = SALT) => hmacHex(salt, p).slice(0, 6);

/**
 * In-memory promise-style fs (the shape of fs.promises: readdir, lstat, open -> handle with
 * read/close) that records every path it is asked about and every read size. `stats` tracks
 * calls in flight; an optional `fs.hold(kind, path)` can delay or hang a call.
 */
function makeFs(entries = {}) {
  const nodes = new Map();
  const calls = [];
  const reads = [];
  const stats = { inflight: 0, max: 0 };
  const handles = { opened: 0, closed: 0 };
  const put = (p, node) => {
    const n = norm(p);
    const parts = n.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      if (anc && !nodes.has(anc)) nodes.set(anc, { dir: true });
    }
    nodes.set(n, node);
  };
  const enoent = (p) => Object.assign(new Error("ENOENT " + p), { code: "ENOENT" });
  const track = async (kind, p, fn) => {
    stats.inflight++;
    stats.max = Math.max(stats.max, stats.inflight);
    try {
      if (fs.hold) await fs.hold(kind, p);
      return fn();
    } finally {
      stats.inflight--;
    }
  };
  const fs = {
    calls,
    reads,
    stats,
    handles,
    put,
    dir: (p) => put(p, { dir: true }),
    file: (p, text = "{}", mtimeMs = T1) => put(p, { file: true, text, mtimeMs }),
    link: (p) => put(p, { link: true }),
    readdir(p) {
      calls.push(["readdir", p]);
      return track("readdir", p, () => {
        const n = norm(p);
        const node = nodes.get(n);
        if (!node || !node.dir) throw enoent(p);
        if (node.denied) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        const out = new Set();
        for (const k of nodes.keys()) {
          if (k.startsWith(n + "/")) out.add(k.slice(n.length + 1).split("/")[0]);
        }
        return [...out];
      });
    },
    lstat(p) {
      calls.push(["lstat", p]);
      return track("lstat", p, () => {
        const node = nodes.get(norm(p));
        if (!node) throw enoent(p);
        if (node.deniedStat) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return {
          isDirectory: () => !!node.dir,
          isFile: () => !!node.file,
          isSymbolicLink: () => !!node.link,
          mtimeMs: node.mtimeMs || 0
        };
      });
    },
    open(p) {
      calls.push(["open", p]);
      return track("open", p, () => {
        const node = nodes.get(norm(p));
        if (!node || !node.file) throw enoent(p);
        handles.opened++;
        return {
          read: (buf, off, len) =>
            track("read", p, () => {
              reads.push(len);
              const b = Buffer.from(node.text, "utf8");
              return { bytesRead: b.copy(buf, off, 0, Math.min(len, b.length)), buffer: buf };
            }),
          close: () =>
            track("close", p, () => {
              handles.closed++;
            })
        };
      });
    },
    readFile() {
      throw new Error("whole-file read is not allowed");
    }
  };
  for (const [p, n] of Object.entries(entries)) put(p, n);
  return fs;
}

/** A project folder holding one transcript whose first line carries `cwd`. */
function addProject(fs, projectsRoot, name, cwd, mtimeMs = T1, sep = BS) {
  const line = JSON.stringify(cwd === null ? { type: "x" } : { type: "x", cwd });
  fs.file(projectsRoot + sep + name + sep + "s1.jsonl", line + NL, mtimeMs);
}

/** Rarer home-folder spellings that would put the username into a label (item: hardening). */
const RARE_HOMES = (u) => [
  BS + BS + "?" + BS + "C:" + BS + "Users" + BS + u,
  "//?/C:/Users/" + u,
  BS + BS + "?" + BS + "UNC" + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + u,
  BS + BS + "wsl$" + BS + "Ubuntu" + BS + "mnt" + BS + "c" + BS + "Users" + BS + u,
  "//wsl.localhost/Ubuntu/mnt/c/Users/" + u,
  "C:" + BS + "Documents and Settings" + BS + u,
  "c:/documents and settings/" + u,
  "/mnt/c/Documents and Settings/" + u,
  "/var/home/" + u,
  "/var/home/" + u + "/"
];

const WIN_HOME = "C:" + BS + "Users" + BS + "user";
const WIN_ROOT = WIN_HOME + BS + ".claude" + BS + "projects";
const wslRoot = (d, flavour = "wsl.localhost") => BS + BS + flavour + BS + d + BS + "home";

const utf16 = (text, bom = true) =>
  Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);

/** Fake runner: replies by argument list, records every call. */
function makeRunner(replies) {
  const calls = [];
  const run = async (args) => {
    calls.push([...args]);
    const key = args.join(" ");
    const r = replies[key];
    if (r instanceof Error) throw r;
    if (!r) throw new Error("unexpected wsl call: " + key);
    return r;
  };
  run.calls = calls;
  return run;
}
const LIST = "-l -q";
const RUNNING = "-l --running -q";
const ok = (text) => ({ status: 0, stdout: utf16(text.split(NL).join(CR + NL)) });

const discover = (over) =>
  S.discoverClaudeProjects({
    platform: "win32",
    homedir: WIN_HOME,
    now: () => NOW,
    salt: SALT,
    ...over
  });

test("Windows projects: label is the last cwd folder, mtime is the newest transcript", async () => {
  const fs = makeFs();
  const cwd = "C:" + BS + "work" + BS + "proj-demo";
  addProject(fs, WIN_ROOT, "C--work-proj-demo", "C:" + BS + "old" + BS + "stale-demo", T1);
  fs.file(
    WIN_ROOT + BS + "C--work-proj-demo" + BS + "newer.jsonl",
    JSON.stringify({ cwd }) + NL,
    T2
  );
  fs.file(WIN_ROOT + BS + "C--work-proj-demo" + BS + "note.txt", "x", T2 + 5000);
  fs.dir(WIN_ROOT + BS + "empty-one");
  fs.file(WIN_ROOT + BS + "only-text" + BS + "a.txt", "x");
  fs.dir(WIN_ROOT + BS + "nested" + BS + "deep");
  fs.file(WIN_ROOT + BS + "nested" + BS + "deep" + BS + "a.jsonl", "{}");
  fs.link(WIN_ROOT + BS + "linked");
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r.projects.length, 1);
  const p = r.projects[0];
  assert.equal(p.label, "proj-demo");
  assert.equal(p.sourceTag, "windows");
  assert.equal(p.mtime, T2);
  assert.match(p.id, /^cc-[0-9a-f]{12}$/);
  assert.equal(p.path, WIN_ROOT + BS + "C--work-proj-demo");
  assert.equal("path" in S.publicView(r).projects[0], false);
  assert.ok(!JSON.stringify(S.publicView(r)).includes("work"), "the full cwd is not exposed");
});

test("(a) a stopped distro is skipped with a note and no fs or wsl call reaches it", async () => {
  const fs = makeFs();
  addProject(
    fs,
    wslRoot("Debian") + BS + "user" + BS + ".claude" + BS + "projects",
    "p1",
    "/home/user/app"
  );
  fs.dir(wslRoot("Ubuntu") + BS + "user"); // exists, but must never be touched
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu" + NL + "Debian"), [RUNNING]: ok("Debian") });
  const r = await discover({ fs, runWsl });
  assert.deepEqual(runWsl.calls, [
    ["-l", "-q"],
    ["-l", "--running", "-q"]
  ]);
  assert.ok(
    r.notes.some((n) => n.text === "Ubuntu skipped: not running" && n.code === "not-running")
  );
  assert.ok(!r.notes.some((n) => /Debian skipped/.test(n.text)));
  assert.equal(fs.calls.filter(([, p]) => /ubuntu/i.test(p)).length, 0, "no fs path names Ubuntu");
  for (const [, p] of fs.calls) {
    assert.ok(/^(\\\\wsl\.localhost\\Debian\\|C:\\)/.test(p), "unexpected root: " + p);
  }
  assert.ok(
    !fs.calls.some(([, p]) => p === BS + BS + "wsl$" || p === BS + BS + "wsl.localhost"),
    "never lists the wsl root"
  );
  assert.deepEqual(
    r.projects.map((p) => p.sourceTag),
    ["wsl:Debian"]
  );
});

test("a 'none running' non-zero exit is not read as WSL missing", async () => {
  const fs = makeFs();
  const runWsl = makeRunner({
    [LIST]: ok("Ubuntu"),
    [RUNNING]: { status: 1, stdout: Buffer.from("There are no running distributions.") }
  });
  const r = await discover({ fs, runWsl });
  assert.deepEqual(
    r.notes.filter((n) => n.distro).map((n) => n.text),
    ["Ubuntu skipped: not running"]
  );
  assert.ok(!r.notes.some((n) => /not installed|unavailable|not responding/.test(n.text)));
  assert.equal(fs.calls.filter(([, p]) => /ubuntu/i.test(p)).length, 0);
});

test("a non-zero --running reply is never trusted, even if it names a distro", async () => {
  const fs = makeFs();
  fs.dir(wslRoot("Ubuntu") + BS + "u1");
  const runWsl = makeRunner({
    [LIST]: ok("Ubuntu"),
    [RUNNING]: { status: 1, stdout: utf16("Ubuntu") }
  });
  const r = await discover({ fs, runWsl });
  assert.ok(
    r.notes.some((n) => n.text === "Ubuntu skipped: not running" && n.code === "not-running")
  );
  assert.equal(fs.calls.filter(([, p]) => /ubuntu/i.test(p)).length, 0);
});

test("(b) WSL missing or failing: right note, Windows projects still listed, no throw", async () => {
  const timeout = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
  const killed = Object.assign(new Error("k"), { killed: true });
  const cases = [
    ["ENOENT", { [LIST]: Object.assign(new Error("x"), { code: "ENOENT" }) }, "WSL not installed"],
    ["non-zero", { [LIST]: { status: 1, stdout: Buffer.from("") } }, "WSL unavailable"],
    ["timeout code", { [LIST]: timeout }, "WSL not responding"],
    ["killed", { [LIST]: killed }, "WSL not responding"],
    [
      "garbage",
      { [LIST]: { status: 0, stdout: Buffer.from([1, 2, 3, 250, 251, 10, 0, 9]) } },
      "WSL unavailable"
    ],
    ["other error", { [LIST]: new Error("boom") }, "WSL unavailable"],
    ["undefined reply", { [LIST]: { status: 0, stdout: undefined } }, null],
    ["running call times out", { [LIST]: ok("Ubuntu"), [RUNNING]: timeout }, "WSL not responding"],
    [
      "running call missing",
      { [LIST]: ok("Ubuntu"), [RUNNING]: Object.assign(new Error("x"), { code: "ENOENT" }) },
      "WSL not installed"
    ]
  ];
  for (const [label, replies, text] of cases) {
    const fs = makeFs();
    addProject(fs, WIN_ROOT, "p1", "C:" + BS + "work" + BS + "proj-demo");
    const runWsl = makeRunner(replies);
    const r = await discover({ fs, runWsl });
    assert.equal(r.projects.length, 1, label + ": Windows project kept");
    if (text)
      assert.ok(
        r.notes.some((n) => n.text === text),
        label + ": " + JSON.stringify(r.notes)
      );
    assert.ok(runWsl.calls.length <= 2, label + ": at most two calls");
    assert.equal(fs.calls.filter(([, p]) => /wsl/i.test(p)).length, 0, label + ": no wsl fs call");
  }
  // a runner that throws something that is not even an Error
  const r = await discover({
    fs: makeFs(),
    runWsl: async () => {
      throw null;
    }
  });
  assert.ok(r.notes.some((n) => n.text === "WSL unavailable"));
});

test("a non-Windows platform skips WSL without a note or a call", async () => {
  const fs = makeFs();
  const root = "/home/user/.claude/projects";
  addProject(fs, root, "p1", "/home/user/app", T1, "/");
  const runWsl = makeRunner({});
  const r = await S.discoverClaudeProjects({
    platform: "linux",
    homedir: "/home/user",
    fs,
    runWsl,
    now: () => NOW
  });
  assert.equal(runWsl.calls.length, 0);
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].label, "app");
  assert.ok(!r.notes.some((n) => /WSL/.test(n.text)));
});

test("(c) raw paths: no path, username or planted word reaches any public field or note", async () => {
  const cwds = [
    "C:" + BS + "Users" + BS + PLANTED + BS + "proj-demo",
    "/c/Users/" + PLANTED + "/proj-demo",
    "/home/" + PLANTED + "/proj-demo",
    "/Users/" + PLANTED + "/proj-demo",
    BS + BS + "wsl.localhost" + BS + "Ubuntu" + BS + "home" + BS + PLANTED + BS + "proj-demo",
    BS + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + PLANTED + BS + "proj-demo",
    "//wsl$/Ubuntu/home/" + PLANTED + "/proj-demo",
    "C:" + BS + "Users" + BS + PLANTED,
    "/home/" + PLANTED,
    "/Users/" + PLANTED + "/",
    "c:/users/" + PLANTED,
    BS + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + PLANTED,
    "//wsl.localhost/Ubuntu/home/" + PLANTED,
    BS + BS + "wsl.localhost" + BS + "Ubuntu" + BS + "root",
    ...RARE_HOMES(PLANTED),
    ...RARE_HOMES(PLANTED).map((h) => h + "/proj-demo")
  ];
  const folders = [
    "-home-" + PLANTED + "-proj-demo",
    "C--Users-" + PLANTED + "-proj-demo",
    "-home-" + PLANTED,
    "-mnt-c-Users-" + PLANTED + "-proj-demo",
    "-Users-" + PLANTED,
    "C--Users-" + PLANTED + "-SyncDir-a-b-proj",
    "-home-" + PLANTED + "-smith-proj-demo"
  ];
  const homes = [
    "C:" + BS + "Users" + BS + PLANTED,
    "/c/Users/" + PLANTED,
    "/cygdrive/c/Users/" + PLANTED,
    "C:/Users/" + PLANTED,
    "//wsl$/Ubuntu/home/" + PLANTED,
    BS + BS + "wsl.localhost" + BS + "Ubuntu" + BS + "home" + BS + PLANTED
  ];
  for (const home of homes) {
    for (const flavour of ["wsl.localhost", "wsl$"]) {
      const fs = makeFs();
      const winRoot = path_win32_join(home);
      cwds.forEach((c, i) => addProject(fs, winRoot, "w" + i, c));
      folders.forEach((f, i) => addProject(fs, winRoot, f + "-" + i, null));
      const base = wslRoot("Ubuntu", flavour) + BS + PLANTED + BS + ".claude" + BS + "projects";
      cwds.forEach((c, i) => addProject(fs, base, "u" + i, c));
      folders.forEach((f) => addProject(fs, base, f, null));
      fs.dir(wslRoot("Ubuntu", flavour === "wsl$" ? "wsl.localhost" : "wsl$") + BS + "x");
      const runWsl = makeRunner({ [LIST]: ok("Ubuntu" + NL + "Debian"), [RUNNING]: ok("Ubuntu") });
      const r = await discover({ fs, runWsl, homedir: home });
      const pub = JSON.stringify(S.publicView(r));
      assert.ok(!pub.toLowerCase().includes(PLANTED), "planted word leaked: " + home);
      assert.ok(!PRIVATE.test(pub), "privacy pattern hit for " + home + ": " + pub.slice(0, 200));
      assert.ok(!/proj-demo.*proj-demo.*[\\/]/.test(pub));
    }
  }
});

function path_win32_join(home) {
  // Mirrors how the module builds the Windows root so the fake fs holds the same path.
  const path = require("path");
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(home);
  const h = m ? m[1].toUpperCase() + ":" + (m[2] || "/").split("/").join(BS) : home;
  return path.win32.join(h, ".claude", "projects");
}

test("a label is only the last folder of the cwd, never the cwd itself", async () => {
  const fs = makeFs();
  const cwd = "/home/user/code/deep/nested/proj-demo";
  addProject(fs, WIN_ROOT, "p1", cwd);
  addProject(fs, WIN_ROOT, "p2", "C:" + BS + "a" + BS + "b" + BS + "other-demo");
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.deepEqual(r.projects.map((p) => p.label).sort(), ["other-demo", "proj-demo"]);
  for (const p of r.projects) assert.ok(!p.label.includes("/") && !p.label.includes(BS));
});

test("home-folder names get a stable 6-hex hash label (Windows, WSL, macOS forms)", async () => {
  const forms = [
    "C:" + BS + "Users" + BS + "user",
    "c:" + BS + "users" + BS + "user",
    "C:/Users/user",
    "/home/user",
    "/Users/user",
    "/mnt/c/Users/user",
    "/c/Users/user",
    "/home/user/",
    BS + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + "user",
    "//wsl.localhost/Ubuntu/home/user",
    BS + BS + "wsl.localhost" + BS + "Ubuntu" + BS + "root",
    "/root",
    ...RARE_HOMES("user")
  ];
  const fs = makeFs();
  forms.forEach((c, i) => addProject(fs, WIN_ROOT, "h" + i, c));
  const run = () => discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const a = await run();
  const b = await run();
  assert.equal(a.projects.length, forms.length);
  assert.deepEqual(
    a.projects.map((p) => [p.id, p.label]),
    b.projects.map((p) => [p.id, p.label]),
    "stable across two runs"
  );
  const byPath = new Map(a.projects.map((p) => [p.path, p.label]));
  forms.forEach((c, i) => {
    const label = byPath.get(WIN_ROOT + BS + "h" + i);
    assert.match(label, /^[0-9a-f]{6}$/, c);
    assert.equal(label, hash6(c), "HMAC of the full cwd with the salt: " + c);
    assert.notEqual(label, "user");
  });
  // the raw rarer forms are what the shared privacy patterns exist to catch
  for (const h of RARE_HOMES("bob")) assert.ok(PRIVATE.test(h), "pattern misses " + h);
  // a folder that merely sits under a home is a normal label
  const fs2 = makeFs();
  addProject(fs2, WIN_ROOT, "x", "/home/user/proj-demo");
  addProject(fs2, WIN_ROOT, "y", "/var/home/user/proj2-demo");
  addProject(
    fs2,
    WIN_ROOT,
    "z",
    BS + BS + "?" + BS + "C:" + BS + "Users" + BS + "user" + BS + "app-demo"
  );
  const c = await discover({ fs: fs2, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.deepEqual(c.projects.map((p) => p.label).sort(), ["app-demo", "proj-demo", "proj2-demo"]);
});

test("labels that collide in one source get the hash label; other sources keep theirs", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "a", "C:" + BS + "one" + BS + "app");
  addProject(fs, WIN_ROOT, "b", "C:" + BS + "two" + BS + "APP");
  addProject(fs, WIN_ROOT, "c", "C:" + BS + "three" + BS + "solo");
  const wsl = wslRoot("Ubuntu") + BS + "user" + BS + ".claude" + BS + "projects";
  addProject(fs, wsl, "d", "/srv/app");
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu"), [RUNNING]: ok("Ubuntu") });
  const r = await discover({ fs, runWsl });
  const win = r.projects.filter((p) => p.sourceTag === "windows");
  const labels = win.map((p) => p.label).sort();
  assert.equal(new Set(labels).size, 3);
  assert.ok(labels.includes("solo"));
  const collided = win.filter((p) => p.label !== "solo");
  for (const p of collided) {
    assert.match(p.label, /^(app|APP) #[0-9a-f]{6}$/);
    assert.ok(p.label.endsWith("#" + hash6(p.path)), "hash of the project folder");
  }
  assert.equal(r.projects.find((p) => p.sourceTag === "wsl:Ubuntu").label, "app");
});

test("invalid distro names are dropped with a note and never reach the fs", async () => {
  const bad = ["Ubu ntu", "-lead", "a".repeat(65), "x" + BS + "y", "..", "a/b", "dist$ro"];
  const fs = makeFs();
  const runWsl = makeRunner({
    [LIST]: ok(["Ubuntu", ...bad].join(NL)),
    [RUNNING]: ok(["Ubuntu", ...bad].join(NL))
  });
  const r = await discover({ fs, runWsl });
  const note = r.notes.find((n) => n.code === "invalid-distro-name");
  assert.ok(note && /^7 WSL distro names skipped/.test(note.text), JSON.stringify(r.notes));
  assert.ok(fs.calls.every(([, p]) => !bad.some((b) => p.includes(b))));
  assert.ok(r.notes.some((n) => n.text === "Ubuntu: no Claude Code projects") || fs.calls.length);
  // a 64-char name is the longest allowed
  const longest = "a" + "b".repeat(63);
  const r2 = await discover({
    fs: makeFs(),
    runWsl: makeRunner({ [LIST]: ok(longest), [RUNNING]: ok(longest) })
  });
  assert.ok(r2.notes.some((n) => n.text === longest + ": home folders unreadable"));
});

test("cwd read is bounded: one read of at most 16 KB, 20 lines, never a whole-file read", async () => {
  assert.equal(S.READ_BYTES, 16384);
  assert.equal(S.READ_LINES, 20);
  const fs = makeFs();
  const big = JSON.stringify({ type: "x", pad: "p".repeat(1000000) }) + NL; // a 1 MB first line
  fs.file(
    WIN_ROOT + BS + "big" + BS + "s.jsonl",
    big + JSON.stringify({ cwd: "/a/late-demo" }),
    T1
  );
  addProject(fs, WIN_ROOT, "ok", "/a/early-demo");
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(fs.reads.length, 2, "one read per transcript");
  assert.ok(fs.reads.every((n) => n <= S.READ_BYTES));
  const labels = r.projects.map((p) => p.label).sort();
  // the cwd on line 2 is behind a cut-off first line: no cwd, so the hash label of the folder
  assert.equal(labels.length, 2);
  assert.ok(labels.includes("early-demo"));
  assert.ok(labels.includes(hash6(WIN_ROOT + BS + "big")));
});

/** A transcript of filler lines (like last-prompt, queue-operation, ai-title) then a cwd line. */
function lineProject(fs, name, before, padBytes, cwd) {
  const filler = [];
  for (let i = 0; i < before; i++) {
    filler.push(JSON.stringify({ type: "last-prompt", pad: "q".repeat(padBytes) }));
  }
  const lines = [
    ...filler,
    JSON.stringify({ type: "user", cwd }),
    JSON.stringify({ cwd: "/b/later" })
  ];
  fs.file(WIN_ROOT + BS + name + BS + "s.jsonl", lines.join(NL) + NL, T1);
}

test("cwd on line 12 is found; past the 20-line cap or the 16 KB cap it is not (hash label)", async () => {
  const fs = makeFs();
  lineProject(fs, "l12", 11, 20, "/work/deep/secretpath-demo/line12-demo"); // cwd on line 12
  lineProject(fs, "l20", 19, 20, "/work/l20-demo"); // line 20: the last line read
  lineProject(fs, "l21", 20, 20, "/work/l21-demo"); // line 21: one past the line cap
  lineProject(fs, "b6", 6, 2000, "/work/b6-demo"); // starts near 12 KB: inside the byte cap
  lineProject(fs, "b9", 9, 2000, "/work/b9-demo"); // starts near 18 KB: past the byte cap
  // a partial last line (cut by the byte cap) after a found cwd is tolerated
  fs.file(
    WIN_ROOT + BS + "cut" + BS + "s.jsonl",
    JSON.stringify({ cwd: "/work/cut-demo" }) + NL + '{"type":"x","pad":"' + "z".repeat(40000),
    T1
  );
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const label = (n) => r.projects.find((p) => p.path === WIN_ROOT + BS + n).label;
  assert.equal(label("l12"), "line12-demo");
  assert.equal(label("l20"), "l20-demo");
  assert.equal(label("l21"), hash6(WIN_ROOT + BS + "l21"), "past the line cap");
  assert.equal(label("b6"), "b6-demo");
  assert.equal(label("b9"), hash6(WIN_ROOT + BS + "b9"), "past the byte cap");
  assert.equal(label("cut"), "cut-demo");
  assert.ok(fs.reads.every((n) => n <= S.READ_BYTES));
  const pub = JSON.stringify(S.publicView(r));
  for (const w of ["secretpath", "deep", "/work", "work" + BS]) assert.ok(!pub.includes(w), w);
});

test("a line is only used when it is valid JSON with a non-empty string cwd", async () => {
  const fs = makeFs();
  const text = [
    "not json",
    JSON.stringify({ cwd: 5 }),
    JSON.stringify({ cwd: "" }),
    JSON.stringify({ cwd: ["/x/arr-demo"] }),
    '{"cwd":"/x/cut-demo"',
    JSON.stringify({ cwd: "/x/good-demo" })
  ].join(NL);
  fs.file(WIN_ROOT + BS + "p" + BS + "s.jsonl", text, T1);
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r.projects[0].label, "good-demo");
});

test("no cwd: the label is the hash of the folder path, nothing from the folder name", async () => {
  const names = [
    "C--Users-user-SyncDir-a-b-proj",
    "C--Users-user-SyncDir-Desktop-Projects-secretco-app",
    "-home-bob-smith-proj-demo",
    "C--Users-jane-doe-site",
    "-home-bob",
    "-Users-bob",
    "-root"
  ];
  const fs = makeFs();
  for (const name of names) addProject(fs, WIN_ROOT, name, null);
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r.projects.length, names.length);
  for (const name of names) {
    const full = WIN_ROOT + BS + name;
    const p = r.projects.find((x) => x.path === full);
    assert.match(p.label, /^[0-9a-f]{6}$/, name);
    assert.equal(p.label, hash6(full), name);
  }
  const pub = JSON.stringify(S.publicView(r));
  for (const w of ["SyncDir", "a-b", "secretco", "smith", "doe", "jane", "bob", "Desktop"]) {
    assert.ok(!pub.includes(w), "leaked " + w);
  }
});

test("collision suffix only for real names; a username-form label stays a bare hash", async () => {
  const fs = makeFs();
  // two projects whose cwd is the same home folder: same hash label, still no suffix
  addProject(fs, WIN_ROOT, "h1", "/home/user");
  addProject(fs, WIN_ROOT, "h2", "/home/user");
  addProject(fs, WIN_ROOT, "h3", "C:" + BS + "Users" + BS + "user");
  addProject(fs, WIN_ROOT, "n1", "C:" + BS + "one" + BS + "app");
  addProject(fs, WIN_ROOT, "n2", "C:" + BS + "two" + BS + "app");
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const label = (n) => r.projects.find((p) => p.path === WIN_ROOT + BS + n).label;
  assert.equal(label("h1"), hash6("/home/user"));
  assert.equal(label("h2"), hash6("/home/user"));
  assert.equal(label("h3"), hash6("C:" + BS + "Users" + BS + "user"));
  for (const n of ["n1", "n2"]) {
    assert.equal(label(n), "app #" + hash6(WIN_ROOT + BS + n));
  }
});

test("labels lose control and bidi characters and are capped", async () => {
  const bidi = String.fromCharCode(0x202e);
  const zw = String.fromCharCode(0x200b);
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "a", "/x/ab" + bidi + "cd" + zw + String.fromCharCode(7) + "ef");
  addProject(fs, WIN_ROOT, "b", "/x/" + "z".repeat(200));
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const labels = r.projects.map((p) => p.label).sort();
  assert.ok(labels.includes("abcdef"));
  assert.ok(labels.includes("z".repeat(60)));
});

test("running distro: first root, then the other spelling; unreadable homes are counted", async () => {
  const fs = makeFs();
  const second = wslRoot("Ubuntu", "wsl$");
  addProject(fs, second + BS + "u1" + BS + ".claude" + BS + "projects", "p", "/srv/one-demo");
  fs.dir(second + BS + "u2");
  fs.put(second + BS + "u3", { dir: true, deniedStat: true });
  fs.put(second + BS + "u4" + BS + ".claude" + BS + "projects", { dir: true, denied: true });
  fs.link(second + BS + "u5");
  fs.file(second + BS + "notahome", "x");
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu"), [RUNNING]: ok("Ubuntu") });
  const r = await discover({ fs, runWsl });
  assert.deepEqual(
    r.projects.map((p) => p.label),
    ["one-demo"]
  );
  assert.ok(
    r.notes.some((n) => n.text === "Ubuntu: 2 home folders unreadable"),
    JSON.stringify(r.notes)
  );
  const calls = fs.calls.map(([, p]) => p);
  const firstTry = calls.indexOf(wslRoot("Ubuntu"));
  assert.ok(firstTry >= 0 && firstTry < calls.indexOf(second), "localhost spelling tried first");
});

test("a running distro with no projects says so", async () => {
  const fs = makeFs();
  fs.dir(wslRoot("Ubuntu") + BS + "u1");
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu"), [RUNNING]: ok("Ubuntu") });
  const r = await discover({ fs, runWsl });
  assert.ok(r.notes.some((n) => n.text === "Ubuntu: no Claude Code projects"));
  assert.ok(r.notes.some((n) => n.text === "Windows: no Claude Code projects"));
});

test("caps: 64 homes per distro and 500 projects per source add a truncated note", async () => {
  const fs = makeFs();
  const lo = wslRoot("Ubuntu");
  for (let i = 0; i < 65; i++) {
    addProject(
      fs,
      lo + BS + "h" + String(i).padStart(2, "0") + BS + ".claude" + BS + "projects",
      "p",
      "/s/p" + i
    );
  }
  for (let i = 0; i < 501; i++) addProject(fs, WIN_ROOT, "w" + i, "/s/w" + i);
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu"), [RUNNING]: ok("Ubuntu") });
  const r = await discover({ fs, runWsl });
  assert.equal(r.projects.filter((p) => p.sourceTag === "wsl:Ubuntu").length, 64);
  assert.equal(r.projects.filter((p) => p.sourceTag === "windows").length, 500);
  assert.ok(r.notes.some((n) => n.text === "Ubuntu: list truncated"));
  assert.ok(r.notes.some((n) => n.text === "Windows: list truncated"));
  // exactly at the cap: no note
  const fs2 = makeFs();
  for (let i = 0; i < 500; i++) addProject(fs2, WIN_ROOT, "w" + i, "/s/w" + i);
  const r2 = await discover({ fs: fs2, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r2.projects.length, 500);
  assert.ok(!r2.notes.some((n) => /truncated/.test(n.text)));
  // a plain file or an empty folder past the cap is not a project: no note
  fs2.file(WIN_ROOT + BS + "zz-plain-file", "x");
  fs2.dir(WIN_ROOT + BS + "zz-empty-dir");
  const r3 = await discover({ fs: fs2, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r3.projects.length, 500);
  assert.ok(!r3.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(r3.notes));
});

/** Fills one distro home with projects (names given) whose transcript mtime comes from mtimeOf. */
function wslHome(fs, distro, home, names, mtimeOf) {
  const base = wslRoot(distro) + BS + home + BS + ".claude" + BS + "projects";
  for (const n of names) addProject(fs, base, n, "/s/" + home + "-" + n, mtimeOf(n));
}
const range = (n, pre = "p") => Array.from({ length: n }, (_, i) => pre + i);

test("the 500 cap is per source, not per projects root: one distro, two homes", async () => {
  const run = async (perHome) => {
    const fs = makeFs();
    wslHome(fs, "Ubuntu", "a", range(perHome), () => T1);
    wslHome(fs, "Ubuntu", "b", range(perHome), () => T1);
    const runWsl = makeRunner({ [LIST]: ok("Ubuntu"), [RUNNING]: ok("Ubuntu") });
    const r = await discover({ fs, runWsl });
    return { r, fs };
  };
  const over = await run(300); // 600 candidates
  assert.equal(over.r.projects.filter((p) => p.sourceTag === "wsl:Ubuntu").length, 500);
  assert.ok(over.r.notes.some((n) => n.text === "Ubuntu: list truncated" && n.distro === "Ubuntu"));
  const opens = over.fs.calls.filter(([k, p]) => k === "open" && /wsl/.test(p)).length;
  assert.equal(opens, 500, "the cwd is read only for projects that survive the cap");
  const exact = await run(250); // 500 exactly
  assert.equal(exact.r.projects.filter((p) => p.sourceTag === "wsl:Ubuntu").length, 500);
  assert.ok(!exact.r.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(exact.r.notes));
});

test("the cap keeps the newest transcripts, not the newest folders or the first in directory order", async () => {
  const fs = makeFs();
  const mk = (name, folderMtime, transcriptMtime) => {
    fs.put(WIN_ROOT + BS + name, { dir: true, mtimeMs: folderMtime });
    addProject(fs, WIN_ROOT, name, "/s/" + name, transcriptMtime);
  };
  mk("newfolder-oldtranscript", T2 * 2, T1 - 1000); // oldest transcript, newest folder
  for (let i = 0; i < 499; i++) mk("f" + i, T2 + i, T1 + i);
  mk("oldfolder-newtranscript", 1, T2 + 100000); // newest transcript, oldest folder, listed last
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const labels = r.projects.map((p) => p.label);
  assert.equal(r.projects.length, 500);
  assert.equal(labels[0], "oldfolder-newtranscript", "newest transcript first");
  assert.ok(!labels.includes("newfolder-oldtranscript"), "the oldest transcript is dropped");
  assert.ok(labels.includes("f0") && labels.includes("f498"));
  assert.ok(r.projects.every((p, i, a) => !i || a[i - 1].mtime >= p.mtime));
  assert.ok(r.notes.some((n) => n.text === "Windows: list truncated"));
});

test("the cap tie-break is deterministic whatever the directory order", async () => {
  const names = range(501);
  const survivors = async (order) => {
    const fs = makeFs();
    for (const n of order) addProject(fs, WIN_ROOT, n, "/s/" + n, T1);
    const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
    return r.projects.map((p) => p.id + " " + p.label);
  };
  const fwd = await survivors(names);
  const rev = await survivors(names.slice().reverse());
  const odd = names.filter((_, i) => i % 2);
  const even = names.filter((_, i) => !(i % 2));
  const mixed = await survivors([...odd, ...even]);
  assert.equal(fwd.length, 500);
  assert.deepEqual(fwd, rev);
  assert.deepEqual(fwd, mixed);
  // equal mtimes: the folder path decides, so the last path in sort order is the one dropped
  const dropped = names.slice().sort().pop();
  assert.ok(!fwd.some((x) => x.endsWith(" " + dropped)));
});

test("overall cap: the merged list stops at 2000 (newest kept) with a truncated note", async () => {
  const distros = ["Ubuntu", "Debian", "Alpine", "Arch"];
  const run = async (n) => {
    const fs = makeFs();
    const roots = [WIN_ROOT];
    for (const d of distros) roots.push(wslRoot(d) + BS + "u" + BS + ".claude" + BS + "projects");
    let t = 0;
    for (const root of roots) {
      for (let i = 0; i < n; i++) addProject(fs, root, "p" + i, "/s/p" + i, T1 + t++);
    }
    const list = distros.join(NL);
    return discover({ fs, runWsl: makeRunner({ [LIST]: ok(list), [RUNNING]: ok(list) }) });
  };
  const over = await run(500); // 5 sources x 500 = 2500
  assert.equal(over.projects.length, 2000);
  assert.ok(over.notes.some((n) => n.text === "Projects: list truncated"));
  assert.ok(
    over.projects.every((p, i, a) => !i || a[i - 1].mtime >= p.mtime),
    "newest first"
  );
  assert.equal(over.projects[0].mtime, T1 + 2499);
  assert.equal(over.projects[1999].mtime, T1 + 500);
  const exact = await run(400); // 5 x 400 = 2000 exactly
  assert.equal(exact.projects.length, 2000);
  assert.ok(!exact.notes.some((n) => /Projects: list truncated/.test(n.text)));
});

test("the outer catch names the real platform", async () => {
  const boom = {
    toString() {
      throw new Error("boom");
    }
  };
  const r = await S.discoverClaudeProjects({
    platform: "linux",
    homedir: boom,
    fs: makeFs(),
    now: () => NOW
  });
  assert.ok(
    r.notes.some((n) => n.text === "Local: projects folder unreadable"),
    JSON.stringify(r.notes)
  );
});

test("default wsl.exe runner: wsl.exe, no shell, hidden window, 3s timeout, allowed args only", async () => {
  const calls = [];
  const fake = (reply) => (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    reply(cb);
  };
  const run = S.makeRunWsl(
    fake((cb) => cb(null, Buffer.from("x"))),
    { env: {} }
  );
  const res = await run(["-l", "-q"]);
  assert.equal(res.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, WSL_DEFAULT);
  assert.deepEqual(calls[0].args, ["-l", "-q"]);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout, 3000);
  assert.ok(!calls[0].opts.shell, "no shell");
  await run(["-l", "--running", "-q"]);
  assert.deepEqual(calls[1].args, ["-l", "--running", "-q"]);
  // disallowed argument lists reject without calling execFile
  for (const bad of [["-d", "x"], ["-l"], ["-l", "-q", "-d", "x"], ["--exec", "ls"], []]) {
    await assert.rejects(run(bad), /not allowed/);
  }
  assert.equal(calls.length, 2);
  // killed or signalled: a timeout
  const err = (props) => Object.assign(new Error("e"), props);
  const killed = S.makeRunWsl(fake((cb) => cb(err({ killed: true }), "")));
  await assert.rejects(killed(["-l", "-q"]), (e) => e.code === "ETIMEDOUT");
  const sig = S.makeRunWsl(fake((cb) => cb(err({ signal: "SIGTERM" }), "")));
  await assert.rejects(sig(["-l", "-q"]), (e) => e.code === "ETIMEDOUT");
  // a numeric exit code resolves as a status
  const out = Buffer.from("none");
  const code = S.makeRunWsl(fake((cb) => cb(err({ code: 1 }), out)));
  assert.deepEqual(await code(["-l", "--running", "-q"]), { status: 1, stdout: out });
  // a non-numeric code that is not ENOENT still resolves with status 1
  const odd = S.makeRunWsl(fake((cb) => cb(err({ code: "EPERM" }), out)));
  assert.equal((await odd(["-l", "-q"])).status, 1);
  // ENOENT rejects with its own code
  const gone = S.makeRunWsl(fake((cb) => cb(err({ code: "ENOENT" }))));
  await assert.rejects(gone(["-l", "-q"]), (e) => e.code === "ENOENT");
  assert.equal(typeof S.defaultRunWsl, "function");
});

test("the Windows home comes from the injected homedir; Git Bash roots become drive paths", async () => {
  const fs = makeFs();
  addProject(
    fs,
    "C:" + BS + "Users" + BS + "user" + BS + ".claude" + BS + "projects",
    "p",
    "/s/app"
  );
  const r = await discover({
    fs,
    homedir: "/c/Users/user",
    runWsl: makeRunner({ [LIST]: ok("") })
  });
  assert.equal(r.projects.length, 1);
  assert.equal(
    fs.calls[0][1],
    "C:" + BS + "Users" + BS + "user" + BS + ".claude" + BS + "projects"
  );
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "C:" + BS + "elsewhere";
  try {
    const fs2 = makeFs();
    const r2 = await discover({ fs: fs2, runWsl: makeRunner({ [LIST]: ok("") }) });
    assert.ok(fs2.calls.every(([, p]) => !p.includes("elsewhere")));
    assert.equal(r2.projects.length, 0);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("decodeLines handles UTF-16LE with and without a BOM, UTF-8, CRLF and NULs", () => {
  assert.deepEqual(S.decodeLines(utf16("Ubuntu\r\nDebian\r\n")), ["Ubuntu", "Debian"]);
  assert.deepEqual(S.decodeLines(utf16("Ubuntu\r\nDebian\r\n", false)), ["Ubuntu", "Debian"]);
  assert.deepEqual(S.decodeLines(Buffer.from("Ubuntu\r\n\r\nDebian")), ["Ubuntu", "Debian"]);
  assert.deepEqual(S.decodeLines("A\nB"), ["A", "B"]);
  assert.deepEqual(S.decodeLines(undefined), []);
});

test("ids are opaque and stable; hash labels are 6 hex", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/app");
  const a = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const id = "cc-" + hmacHex(SALT, "windows" + String.fromCharCode(0) + a.projects[0].path);
  assert.equal(a.projects[0].id, id.slice(0, 15));
  assert.match(a.projects[0].id, /^cc-[0-9a-f]{12}$/);
  assert.match(S.hashLabel("anything", SALT), /^[0-9a-f]{6}$/);
  assert.match(S.hashLabel("anything"), /^[0-9a-f]{6}$/);
});

test("paths test: every Claude Code mode response body passes the shared privacy patterns", async () => {
  // Unit 4 owns the real /api/projects, /api/status and /api/events routes and must re-run
  // this check against them. Here the bodies come from the public-view helpers.
  const fs = makeFs();
  const cwds = [
    "C:" + BS + "Users" + BS + PLANTED + BS + "proj-demo",
    "/home/" + PLANTED,
    BS + BS + "wsl$" + BS + "Ubuntu" + BS + "home" + BS + PLANTED + BS + "x-demo"
  ];
  cwds.forEach((c, i) => addProject(fs, WIN_ROOT, "w" + i, c));
  const base = wslRoot("Ubuntu") + BS + PLANTED + BS + ".claude" + BS + "projects";
  addProject(fs, base, "u", "/home/" + PLANTED + "/proj-demo");
  const runWsl = makeRunner({ [LIST]: ok("Ubuntu" + NL + "Debian"), [RUNNING]: ok("Ubuntu") });
  const r = await discover({ fs, runWsl, homedir: WIN_HOME });
  const sample = [{ role: "worker", type: "turn", message: "Edit app", sessionId: "s1" }];
  const bodies = {
    projects: S.toProjectsResponse(r),
    status: S.toStatusResponse(r),
    events: S.toEventsResponse(r, sample)
  };
  for (const [name, body] of Object.entries(bodies)) {
    const text = JSON.stringify(body);
    assert.ok(!PRIVATE.test(text), name + " matched a privacy pattern");
    assert.ok(!text.toLowerCase().includes(PLANTED), name + " carries the planted word");
    assert.ok(!text.includes('"path"'), name + " carries a path field");
    assert.equal(body.source, "claude-code");
  }
  assert.equal(bodies.status.projectCount, r.projects.length);
  assert.ok(bodies.projects.notes.some((n) => n.text === "Debian skipped: not running"));
  // the matcher really catches a path, so the check above is not vacuous
  assert.ok(PRIVATE.test(JSON.stringify({ path: WIN_HOME })));
  assert.ok(PRIVATE.test("x " + PLANTED));
});

/** Same fs, but every directory listing comes back in reverse order. */
const reversed = (fs) => ({ ...fs, readdir: async (p) => (await fs.readdir(p)).reverse() });

test("overall sort: equal mtimes from different sources order by id, whatever the listing order", async () => {
  const build = () => {
    const fs = makeFs();
    for (let i = 0; i < 4; i++) addProject(fs, WIN_ROOT, "w" + i, "/s/w" + i, T1);
    const base = wslRoot("distro-a") + BS + "user" + BS + ".claude" + BS + "projects";
    for (let i = 0; i < 4; i++) addProject(fs, base, "l" + i, "/s/l" + i, T1);
    return fs;
  };
  const replies = { [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") };
  const a = await discover({ fs: build(), runWsl: makeRunner(replies) });
  const b = await discover({ fs: reversed(build()), runWsl: makeRunner(replies) });
  assert.equal(a.projects.length, 8);
  assert.deepEqual(
    a.projects.map((p) => [p.id, p.label, p.sourceTag]),
    b.projects.map((p) => [p.id, p.label, p.sourceTag])
  );
  const ids = a.projects.map((p) => p.id);
  assert.deepEqual(ids, ids.slice().sort());
  assert.ok(new Set(a.projects.map((p) => p.sourceTag)).size === 2);
});

test("a symlinked .jsonl is skipped: a project with only a link is not listed", async () => {
  const fs = makeFs();
  fs.put(WIN_ROOT + BS + "only-link" + BS + "s1.jsonl", {
    file: true,
    link: true,
    text: "{}",
    mtimeMs: T2
  });
  addProject(fs, WIN_ROOT, "both", "/s/real-demo", T1);
  fs.put(WIN_ROOT + BS + "both" + BS + "s0.jsonl", {
    file: true,
    link: true,
    text: "{}",
    mtimeMs: T2
  });
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].label, "real-demo");
  assert.equal(r.projects[0].mtime, T1, "the newer link does not set the mtime");
  assert.ok(
    fs.calls.every(([k, p]) => k !== "open" || !p.endsWith("s0.jsonl")),
    "link not opened"
  );
});

test("unreadable notes carry no path, no home, no drive and no distro-qualified path", async () => {
  const fs = makeFs();
  fs.put(WIN_ROOT, { dir: true, denied: true });
  fs.put(wslRoot("distro-a") + BS + "user", { dir: true, deniedStat: true });
  const runWsl = makeRunner({
    [LIST]: ok("distro-a" + NL + "distro-b"),
    [RUNNING]: ok("distro-a")
  });
  const r = await discover({ fs, runWsl });
  const codes = r.notes.map((n) => n.code);
  assert.ok(codes.filter((c) => c === "home-unreadable").length >= 2, JSON.stringify(r.notes));
  const text = JSON.stringify(r.notes) + JSON.stringify(S.publicView(r));
  assert.ok(!text.includes(BS), "no backslash at all, so no UNC or drive path");
  for (const bad of ["/home", "C:", "wsl$", "wsl.localhost", "distro-a/", "Users", ".claude"]) {
    assert.ok(!text.includes(bad), bad + " in " + text);
  }
  // distro whose home root cannot be listed at all
  const r2 = await discover({ fs: makeFs(), runWsl });
  const t2 = JSON.stringify(r2.notes) + JSON.stringify(S.publicView(r2));
  assert.ok(r2.notes.some((n) => n.distro === "distro-a" && n.code === "home-unreadable"));
  assert.ok(!t2.includes(BS) && !t2.includes("/home") && !t2.includes("C:"), t2);
});

test("home forms (item list) get the hashed label; a plain folder keeps its name", async () => {
  const forms = [
    "/export/home/user",
    "/usr/home/user",
    "/mnt/wsl/home/user",
    BS + BS + "server" + BS + "c$" + BS + "Users" + BS + "user",
    "C:" + BS + "Users" + BS + "user",
    "/home/user",
    "/var/home/user",
    "a/b/../home/user",
    "/HOME/user",
    "/home/user/proj-demo/..",
    "/home/user/x/../.",
    "/root",
    "D:" + BS + "x" + BS + "home" + BS + "app" // accepted false positive
  ];
  const fs = makeFs();
  forms.forEach((c, i) => addProject(fs, WIN_ROOT, "h" + i, c));
  const r = await discover({ fs, runWsl: makeRunner({ [LIST]: ok("") }) });
  const byPath = new Map(r.projects.map((p) => [p.path, p.label]));
  forms.forEach((c, i) => {
    const label = byPath.get(WIN_ROOT + BS + "h" + i);
    assert.equal(label, hash6(c), c);
    assert.match(label, /^[0-9a-f]{6}$/);
  });
  const fs2 = makeFs();
  addProject(fs2, WIN_ROOT, "a", "/srv/proj-demo");
  addProject(fs2, WIN_ROOT, "b", "/p/x/..");
  addProject(fs2, WIN_ROOT, "c", "/home/../etc/proj2-demo");
  addProject(fs2, WIN_ROOT, "d", "/p/..");
  const r2 = await discover({ fs: fs2, runWsl: makeRunner({ [LIST]: ok("") }) });
  const lab = (n) => r2.projects.find((p) => p.path === WIN_ROOT + BS + n).label;
  assert.equal(lab("a"), "proj-demo");
  assert.equal(lab("b"), "p", "a trailing .. is resolved, never used as a label");
  assert.equal(lab("c"), "proj2-demo");
  assert.match(lab("d"), /^[0-9a-f]{6}$/, "resolves to the root: no name, hash label");
  assert.ok(r2.projects.every((p) => p.label !== ".."));
});

test("HMAC labels and ids: stable per salt, different across salts, not the old fixed hash", async () => {
  const build = () => {
    const fs = makeFs();
    addProject(fs, WIN_ROOT, "h", "/home/user");
    addProject(fs, WIN_ROOT, "n", null);
    return fs;
  };
  const run = (salt) => discover({ fs: build(), salt, runWsl: makeRunner({ [LIST]: ok("") }) });
  const a = await run(SALT);
  const b = await run(SALT);
  const c = await run(SALT2);
  const view = (r) => r.projects.map((p) => [p.path, p.id, p.label]);
  assert.deepEqual(view(a), view(b));
  const other = view(c);
  view(a).forEach(([path, id, label], i) => {
    assert.equal(other[i][0], path);
    assert.notEqual(other[i][1], id, "id differs with another salt");
    assert.notEqual(other[i][2], label, "label differs with another salt");
  });
  const old = crypto
    .createHash("sha256")
    .update("/home/user" + "cc-label-v1")
    .digest("hex")
    .slice(0, 6);
  assert.notEqual(a.projects.find((p) => p.path.endsWith(BS + "h")).label, old);
  assert.equal(S.hashLabel("/home/user", SALT), hash6("/home/user"));
  // an invalid salt is ignored (process salt used), not used as given
  const bad = await run(Buffer.alloc(5, 1));
  assert.deepEqual(view(bad), view(await run(undefined)));
  assert.notDeepEqual(view(bad), view(a));
});

test("no salt given: a random per-process salt, never a fixed one", () => {
  const { execFileSync } = require("child_process");
  const code =
    "const S=require(process.argv[1]);process.stdout.write(S.hashLabel('/home/user')+S.hashLabel('/home/user'))";
  const lib = require.resolve("../../lib/claude-code-sources.js");
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const out = execFileSync(process.execPath, ["-e", code, lib]).toString();
    assert.equal(out.slice(0, 6), out.slice(6), "stable inside one process");
    seen.add(out.slice(0, 6));
  }
  assert.ok(seen.size > 1, "labels differ across processes: " + [...seen]);
});

test("loadOrCreateSalt: creates a 0600 16-byte file, reuses it, replaces a corrupt one", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "salt-test-"));
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const a = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.equal(a.note, undefined);
    assert.equal(a.salt.length, 16);
    assert.deepEqual(nodeFs.readFileSync(file), a.salt);
    if (process.platform !== "win32") assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"], "no temp file left behind");
    const b = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.deepEqual(b.salt, a.salt, "second call reuses the file");
    nodeFs.writeFileSync(file, Buffer.alloc(5, 1));
    const c = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.equal(c.salt.length, 16);
    assert.equal(c.note, undefined);
    assert.notDeepEqual(c.salt, a.salt);
    assert.deepEqual(nodeFs.readFileSync(file), c.salt, "the corrupt file was replaced");
    nodeFs.writeFileSync(file, Buffer.alloc(40, 1));
    assert.equal(S.loadOrCreateSalt({ dir, fs: nodeFs }).salt.length, 16);
    assert.equal(nodeFs.readFileSync(file).length, 16);
    // a folder that does not exist yet is created
    const sub = nodePath.join(dir, "new", "cfg");
    assert.equal(S.loadOrCreateSalt({ dir: sub, fs: nodeFs }).salt.length, 16);
    assert.ok(nodeFs.existsSync(nodePath.join(sub, "label-salt.bin")));
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: a present file that cannot be read right now is never overwritten", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "salt-busy-"));
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const first = S.loadOrCreateSalt({ dir, fs: nodeFs });
    for (const code of ["EBUSY", "EACCES", "EPERM", "EIO"]) {
      const writes = [];
      const flaky = {
        ...nodeFs,
        readFileSync: () => {
          throw Object.assign(new Error(code), { code });
        },
        writeFileSync: (...a) => (writes.push(a[0]), nodeFs.writeFileSync(...a)),
        renameSync: (...a) => (writes.push("rename"), nodeFs.renameSync(...a))
      };
      const r = S.loadOrCreateSalt({ dir, fs: flaky });
      assert.equal(r.salt.length, 16, code);
      assert.deepEqual(r.note, { code: "labels-unstable", text: "Labels change after restart" });
      assert.deepEqual(writes, [], code + ": nothing written");
      assert.deepEqual(
        nodeFs.readFileSync(file),
        first.salt,
        code + ": the file on disk is intact"
      );
    }
    // a restart that can read it again gets the original salt
    assert.deepEqual(S.loadOrCreateSalt({ dir, fs: nodeFs }).salt, first.salt);
    // a valid file is never rewritten
    const writes = [];
    const spy = {
      ...nodeFs,
      writeFileSync: (...a) => (writes.push(a[0]), nodeFs.writeFileSync(...a)),
      renameSync: (...a) => (writes.push("rename"), nodeFs.renameSync(...a))
    };
    S.loadOrCreateSalt({ dir, fs: spy });
    assert.deepEqual(writes, [], "a valid salt file is read, not rewritten");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: unreadable or unwritable gives a random in-memory salt and a note", () => {
  const boom = () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  const failing = {
    readFileSync: boom,
    mkdirSync: boom,
    writeFileSync: boom,
    renameSync: boom,
    unlinkSync: boom
  };
  const a = S.loadOrCreateSalt({ dir: "x", fs: failing });
  const b = S.loadOrCreateSalt({ dir: "x", fs: failing });
  for (const r of [a, b]) {
    assert.equal(r.salt.length, 16);
    assert.deepEqual(r.note, { code: "labels-unstable", text: "Labels change after restart" });
  }
  assert.notDeepEqual(a.salt, b.salt, "two sessions never share a fallback salt");
  // a rename that fails after the write also falls back; the write went to a temp file (an fd)
  const written = [];
  const renameFails = {
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    mkdirSync: () => {},
    openSync: () => 7,
    writeFileSync: (p) => written.push(p),
    fsyncSync: () => {},
    closeSync: () => {},
    linkSync: boom,
    renameSync: boom,
    unlinkSync: () => {}
  };
  assert.equal(S.loadOrCreateSalt({ dir: "x", fs: renameFails }).note.code, "labels-unstable");
  assert.deepEqual(written, [7], "only the temp file descriptor was written, never the final name");
});

function saltScratch(prefix) {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  return nodeFs.mkdtempSync(nodePath.join(base, prefix));
}

test("loadOrCreateSalt: two first starts at once agree on the salt on disk", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const dir = saltScratch("salt-race-");
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    let other = null;
    // process A looks, sees no file; before A writes anything, process B starts and finishes
    const fsA = {
      ...nodeFs,
      readFileSync: (...args) => {
        if (!other) {
          other = S.loadOrCreateSalt({ dir, fs: nodeFs });
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return nodeFs.readFileSync(...args);
      }
    };
    const a = S.loadOrCreateSalt({ dir, fs: fsA });
    assert.ok(other, "the other process ran in the gap");
    assert.deepEqual(a.salt, other.salt, "A uses the salt B already put on disk");
    assert.deepEqual(a.salt, nodeFs.readFileSync(file));
    assert.equal(a.note, undefined);
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"], "no temp file left behind");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: the temp file is flushed before it is published, on both paths", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const dir = saltScratch("salt-sync-");
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const spyFs = (log) => ({
      ...nodeFs,
      openSync: (...a) => {
        const fd = nodeFs.openSync(...a);
        log.push(["open", fd]);
        return fd;
      },
      fsyncSync: (fd) => (log.push(["fsync", fd]), nodeFs.fsyncSync(fd)),
      closeSync: (fd) => (log.push(["close", fd]), nodeFs.closeSync(fd)),
      linkSync: (...a) => (log.push(["publish"]), nodeFs.linkSync(...a)),
      renameSync: (...a) => (log.push(["publish"]), nodeFs.renameSync(...a))
    });
    const kinds = (log) => log.map((x) => x[0]);
    // missing file: link path
    const log1 = [];
    S.loadOrCreateSalt({ dir, fs: spyFs(log1) });
    assert.deepEqual(kinds(log1), ["open", "fsync", "close", "publish"]);
    assert.equal(log1[0][1], log1[1][1], "the flushed descriptor is the one that was opened");
    // corrupt file: rename path
    nodeFs.writeFileSync(file, Buffer.alloc(3, 1));
    const log2 = [];
    S.loadOrCreateSalt({ dir, fs: spyFs(log2) });
    // the lock file is opened and closed first, then the temp file is flushed before publishing
    assert.deepEqual(kinds(log2), ["open", "close", "open", "fsync", "close", "publish"]);
    assert.equal(log2[2][1], log2[3][1], "the flushed descriptor is the temp file's");
    // no hard links on this disk: falls back to a rename and still returns what is on disk
    nodeFs.rmSync(file);
    const noLink = {
      ...nodeFs,
      linkSync: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
    };
    const c = S.loadOrCreateSalt({ dir, fs: noLink });
    assert.equal(c.note, undefined);
    assert.deepEqual(c.salt, nodeFs.readFileSync(file));
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"]);
    // what is on disk after publishing is not a valid salt: say so instead of claiming it is stable
    nodeFs.rmSync(file);
    let reads = 0;
    const odd = {
      ...nodeFs,
      readFileSync: () => {
        reads += 1;
        if (reads === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Buffer.alloc(2, 9);
      }
    };
    const d = S.loadOrCreateSalt({ dir, fs: odd });
    assert.equal(d.salt.length, 16);
    assert.equal(d.note.code, "labels-unstable");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: a corrupt file is replaced only under the lock", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const dir = saltScratch("salt-lock-");
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const lock = file + ".lock";
    const corrupt = () => nodeFs.writeFileSync(file, Buffer.alloc(3, 1));
    const clock = (start) => {
      let t = start;
      return { now: () => t, mono: () => t, sleep: (ms) => (t += ms) };
    };
    const names = () => nodeFs.readdirSync(dir).sort();

    // a fresh lock held by someone else: we wait, give up, and replace nothing
    corrupt();
    nodeFs.writeFileSync(lock, "");
    const c1 = clock(Date.now());
    const r1 = S.loadOrCreateSalt({ dir, fs: nodeFs, ...c1, lockWaitMs: 200 });
    assert.equal(r1.salt.length, 16);
    assert.equal(r1.note.code, "labels-unstable");
    assert.deepEqual(nodeFs.readFileSync(file), Buffer.alloc(3, 1), "the file was not replaced");
    assert.ok(nodeFs.existsSync(lock), "someone else's fresh lock is left alone");

    // a lock left by a crashed process (old mtime) is removed after the stale timeout
    const old = new Date(Date.now() - 60000);
    nodeFs.utimesSync(lock, old, old);
    const r2 = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.equal(r2.note, undefined);
    assert.deepEqual(r2.salt, nodeFs.readFileSync(file));
    assert.deepEqual(names(), ["label-salt.bin"], "no lock or temp file left");

    // the holder fixes the file while we wait: we use its salt and write nothing
    corrupt();
    nodeFs.writeFileSync(lock, "");
    const fixed = Buffer.alloc(16, 7);
    let slept = 0;
    const writes = [];
    const watching = {
      ...nodeFs,
      renameSync: (...a) => (writes.push("rename"), nodeFs.renameSync(...a)),
      linkSync: (...a) => (writes.push("link"), nodeFs.linkSync(...a))
    };
    const r3 = S.loadOrCreateSalt({
      dir,
      fs: watching,
      now: Date.now,
      sleep: () => {
        slept += 1;
        nodeFs.writeFileSync(file, fixed);
        nodeFs.rmSync(lock);
      }
    });
    assert.equal(slept, 1);
    assert.deepEqual(r3.salt, fixed);
    assert.equal(r3.note, undefined);
    assert.deepEqual(writes, [], "nothing was published");
    assert.deepEqual(nodeFs.readFileSync(file), fixed);

    // the lock is released when the replace fails too
    corrupt();
    const renameBoom = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
    };
    const r4 = S.loadOrCreateSalt({ dir, fs: renameBoom });
    assert.equal(r4.note.code, "labels-unstable");
    assert.deepEqual(names(), ["label-salt.bin"], "lock and temp file are gone after a failure");

    // a folder where the lock cannot be created: no replace, a note
    corrupt();
    const noLock = {
      ...nodeFs,
      openSync: (p, ...a) => {
        if (String(p).endsWith(".lock"))
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return nodeFs.openSync(p, ...a);
      }
    };
    const r5 = S.loadOrCreateSalt({ dir, fs: noLock });
    assert.equal(r5.note.code, "labels-unstable");
    assert.deepEqual(nodeFs.readFileSync(file), Buffer.alloc(3, 1));
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: a lock file that cannot be read or removed never hangs startup", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const dir = saltScratch("salt-nohang-");
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const lock = file + ".lock";
    const epermAt =
      (name, counter, cap) =>
      (p, ...a) => {
        if (String(p).includes(".lock")) {
          counter.n += 1;
          if (counter.n > cap) return nodeFs[name](p, ...a); // a regression ends here, and fails the count
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        return nodeFs[name](p, ...a);
      };
    const corrupt = () => nodeFs.writeFileSync(file, Buffer.alloc(3, 1));
    const old = () => {
      const d = new Date(Date.now() - 60000);
      nodeFs.writeFileSync(lock, "dead");
      nodeFs.utimesSync(lock, d, d);
    };
    const check = (r, counter, label) => {
      assert.equal(r.salt.length, 16, label);
      assert.equal(r.note.code, "labels-unstable", label);
      assert.ok(counter.n <= 3, label + ": gave up at once, calls=" + counter.n);
      assert.deepEqual(nodeFs.readFileSync(file), Buffer.alloc(3, 1), label + ": file untouched");
    };
    // the lock cannot be looked at
    corrupt();
    nodeFs.writeFileSync(lock, "x");
    let c = { n: 0 };
    check(
      S.loadOrCreateSalt({ dir, fs: { ...nodeFs, statSync: epermAt("statSync", c, 50) } }),
      c,
      "stat fails"
    );
    // the lock is old but cannot be linked or removed
    old();
    c = { n: 0 };
    check(
      S.loadOrCreateSalt({
        dir,
        fs: {
          ...nodeFs,
          linkSync: epermAt("linkSync", c, 50),
          unlinkSync: epermAt("unlinkSync", c, 50)
        }
      }),
      c,
      "stale lock cannot be removed"
    );
    // the lock is old but cannot be read
    c = { n: 0 };
    check(
      S.loadOrCreateSalt({ dir, fs: { ...nodeFs, readFileSync: epermAt("readFileSync", c, 50) } }),
      c,
      "stale lock cannot be read"
    );
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: lock ownership, takeover, future-dated locks and the wait clock", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const dir = saltScratch("salt-owner-");
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    const lock = file + ".lock";
    const corrupt = () => nodeFs.writeFileSync(file, Buffer.alloc(3, 1));
    const setAge = (ms) => {
      const d = new Date(Date.now() - ms);
      nodeFs.utimesSync(lock, d, d);
    };

    // we never release a lock that has someone else's token in it
    corrupt();
    const swapped = {
      ...nodeFs,
      renameSync: (...a) => {
        nodeFs.writeFileSync(lock, "someone-else");
        return nodeFs.renameSync(...a);
      }
    };
    const r1 = S.loadOrCreateSalt({ dir, fs: swapped });
    assert.equal(r1.note, undefined);
    assert.equal(nodeFs.readFileSync(lock, "utf8"), "someone-else", "their lock is left alone");
    nodeFs.rmSync(lock);

    // our own lock is released
    corrupt();
    S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.ok(!nodeFs.existsSync(lock));

    // a fresh lock slips in over the stale one we judged: the real lock is never moved or deleted
    corrupt();
    nodeFs.writeFileSync(lock, "old-holder");
    setAge(60000);
    let swappedOnce = false;
    const takeover = {
      ...nodeFs,
      linkSync: (from, to) => {
        if (!swappedOnce && String(from).endsWith(".lock")) {
          swappedOnce = true;
          nodeFs.writeFileSync(from, "fresh-holder"); // a new lock, made just now
        }
        return nodeFs.linkSync(from, to);
      }
    };
    let t = Date.now();
    const r2 = S.loadOrCreateSalt({
      dir,
      fs: takeover,
      now: () => t,
      mono: () => t,
      sleep: (ms) => (t += ms),
      lockWaitMs: 200
    });
    assert.ok(swappedOnce);
    assert.equal(r2.note.code, "labels-unstable", "the fresh holder keeps the lock");
    assert.equal(nodeFs.readFileSync(lock, "utf8"), "fresh-holder", "its lock was never touched");
    assert.deepEqual(nodeFs.readFileSync(file), Buffer.alloc(3, 1), "file untouched");
    assert.deepEqual(
      nodeFs.readdirSync(dir).sort(),
      ["label-salt.bin", "label-salt.bin.lock"],
      "no .stale- file left"
    );
    nodeFs.rmSync(lock);

    // the process that was removing a stale lock died after linking it: its old link is cleared
    corrupt();
    nodeFs.writeFileSync(lock, "dead-holder");
    setAge(60000);
    let linked = 0;
    const deadWinner = {
      ...nodeFs,
      linkSync: (from, to) => {
        linked += 1;
        if (linked === 1) {
          nodeFs.linkSync(from, to); // the other process's link, left behind
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        return nodeFs.linkSync(from, to);
      },
      statSync: (p, ...a) => {
        const st = nodeFs.statSync(p, ...a);
        return String(p).includes(".stale-") ? { ...st, ctimeMs: Date.now() - 60000 } : st;
      }
    };
    const r5 = S.loadOrCreateSalt({ dir, fs: deadWinner, sleep: () => {} });
    assert.equal(r5.note, undefined, "the stale lock was broken after all");
    assert.deepEqual(r5.salt, nodeFs.readFileSync(file));
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"], "no lock or link left");

    // a lock dated far in the future (clock went back after a crash) counts as stale
    corrupt();
    nodeFs.writeFileSync(lock, "from-the-future");
    const fut = new Date(Date.now() + 3600000);
    nodeFs.utimesSync(lock, fut, fut);
    const r3 = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.equal(r3.note, undefined);
    assert.deepEqual(r3.salt, nodeFs.readFileSync(file));
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"]);

    // the wait uses its own steady clock: a wall clock that stands still cannot extend it
    corrupt();
    nodeFs.writeFileSync(lock, "busy");
    const wall = Date.now();
    let steady = 0;
    let sleeps = 0;
    const r4 = S.loadOrCreateSalt({
      dir,
      fs: nodeFs,
      now: () => wall,
      mono: () => steady,
      sleep: (ms) => {
        sleeps += 1;
        if (sleeps > 100) throw new Error("waited past the limit");
        steady += ms;
      },
      lockWaitMs: 100
    });
    assert.equal(r4.note.code, "labels-unstable");
    assert.ok(sleeps >= 1 && sleeps <= 6, "waited about lockWaitMs, sleeps=" + sleeps);
    assert.equal(nodeFs.readFileSync(lock, "utf8"), "busy");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: six real processes on a corrupt file (and a dead process's lock) all end on the same salt", async () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const { spawn } = require("child_process");
  const dir = saltScratch("salt-procs-");
  const code = [
    "const S = require(process.argv[1]);",
    "const go = Number(process.argv[3]);",
    "while (Date.now() < go) {}",
    "const r = S.loadOrCreateSalt({ dir: process.argv[2] });",
    "process.stdout.write(JSON.stringify({ salt: r.salt.toString('hex'), note: r.note || null }));"
  ].join(" ");
  const run = (go) =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "-e",
          code,
          nodePath.join(__dirname, "..", "..", "lib", "claude-code-sources.js"),
          dir,
          String(go)
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("close", () => resolve(JSON.parse(out)));
    });
  try {
    const file = nodePath.join(dir, "label-salt.bin");
    for (let round = 0; round < 6; round++) {
      nodeFs.writeFileSync(file, Buffer.alloc(3, 1));
      if (round % 2 === 1) {
        // a lock left by a process that died: all six try to break it at once
        const lockFile = file + ".lock";
        nodeFs.writeFileSync(lockFile, "dead-process");
        const long = new Date(Date.now() - 60000);
        nodeFs.utimesSync(lockFile, long, long);
      }
      const go = Date.now() + 1500;
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => run(go)));
      const disk = nodeFs.readFileSync(file).toString("hex");
      assert.equal(disk.length, 32, "round " + round + ": a valid salt is on disk");
      for (const r of results) {
        assert.equal(r.salt, disk, "round " + round + ": every process uses the salt on disk");
        assert.equal(r.note, null, "round " + round + ": and none reports instability");
      }
      assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"], "no lock or temp left");
    }
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wsl.exe runs by its System32 path, read at call time; other argument lists still fail", async () => {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push(file);
    cb(null, Buffer.from("x"));
  };
  const env = { SystemRoot: "D:" + BS + "Win" };
  const run = S.makeRunWsl(exec, { env });
  await run(["-l", "-q"]);
  assert.equal(calls[0], "D:" + BS + "Win" + BS + "System32" + BS + "wsl.exe");
  delete env.SystemRoot;
  await run(["-l", "--running", "-q"]);
  assert.equal(calls[1], "C:" + BS + "Windows" + BS + "System32" + BS + "wsl.exe");
  await assert.rejects(run(["-d", "x"]), /not allowed/);
  await assert.rejects(run(["-l", "-q", "--exec", "ls"]), /not allowed/);
  assert.equal(calls.length, 2);
});

test("homes are sorted before the 64 cap: the first 64 in code-unit order are kept", async () => {
  const fs = makeFs();
  const lo = wslRoot("distro-a");
  for (let i = 69; i >= 0; i--) {
    const h = "h" + String(i).padStart(2, "0");
    addProject(fs, lo + BS + h + BS + ".claude" + BS + "projects", "p", "/s/" + h);
  }
  const runWsl = makeRunner({ [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") });
  for (const f of [fs, reversed(fs)]) {
    const r = await discover({ fs: f, runWsl });
    const labels = r.projects.map((p) => p.label).sort();
    assert.equal(labels.length, 64);
    assert.deepEqual(
      labels,
      Array.from({ length: 64 }, (_, i) => "h" + String(i).padStart(2, "0"))
    );
    assert.ok(r.notes.some((n) => n.text === "distro-a: list truncated"));
  }
});

// ---- async fs, bounds, timeout, cache ----

const later = () => new Promise((resolve) => setImmediate(resolve));
const hangForever = () => new Promise(() => {});
const readdirCount = (fs, p) => fs.calls.filter(([k, q]) => k === "readdir" && q === p).length;
const noWsl = () => makeRunner({ [LIST]: ok("") });

test("the event loop stays free: other callbacks run between fs calls", async () => {
  const fs = makeFs();
  for (let i = 0; i < 30; i++) addProject(fs, WIN_ROOT, "p" + i, "/s/p" + i);
  let ticks = 0;
  let stop = false;
  const spin = () => {
    if (stop) return;
    ticks++;
    setImmediate(spin);
  };
  setImmediate(spin);
  const seen = [];
  fs.hold = async () => {
    seen.push(ticks);
    await later();
  };
  const r = await discover({ fs, runWsl: noWsl() });
  stop = true;
  assert.equal(r.projects.length, 30);
  assert.ok(seen.length > 100, "many fs calls: " + seen.length);
  assert.ok(seen[seen.length - 1] - seen[0] >= 5, "the loop ran between the first and last call");
  assert.ok(new Set(seen).size > 5, "the counter moved between many separate fs calls");
});

test("at most 16 fs calls are in flight, and the limit is really used", async () => {
  const fs = makeFs();
  for (let i = 0; i < 80; i++) addProject(fs, WIN_ROOT, "p" + i, "/s/p" + i);
  const base = wslRoot("distro-a");
  for (let h = 0; h < 5; h++) {
    for (let i = 0; i < 30; i++) {
      addProject(fs, base + BS + "h" + h + BS + ".claude" + BS + "projects", "p" + i, "/s/x" + i);
    }
  }
  fs.hold = later;
  const runWsl = makeRunner({ [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") });
  const r = await discover({ fs, runWsl });
  assert.equal(S.MAX_CONCURRENCY, 16);
  assert.equal(r.projects.length, 80 + 150);
  assert.equal(fs.stats.max, 16);
  assert.equal(fs.stats.inflight, 0);
});

test("one directory listing is cut to 2000 names in code-unit order; the rest is never checked", async () => {
  assert.equal(S.MAX_DIR_ENTRIES, 2000);
  const name = (i) => "f" + String(i).padStart(4, "0");
  // projects root: 2001 plain files
  const fs = makeFs();
  for (let i = 0; i <= 2000; i++) fs.file(WIN_ROOT + BS + name(i));
  const r = await discover({ fs, runWsl: noWsl() });
  const stated = fs.calls.filter(([k]) => k === "lstat").map(([, p]) => p);
  assert.equal(stated.length, 2000);
  assert.ok(stated.includes(WIN_ROOT + BS + name(1999)));
  assert.ok(!stated.includes(WIN_ROOT + BS + name(2000)), "entry 2001 never stat'ed");
  assert.ok(r.notes.some((n) => n.text === "Windows: list truncated" && n.code === "truncated"));
  // exactly 2000: no note
  const fs2 = makeFs();
  for (let i = 0; i < 2000; i++) fs2.file(WIN_ROOT + BS + name(i));
  const r2 = await discover({ fs: fs2, runWsl: noWsl() });
  assert.ok(!r2.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(r2.notes));
  // one project folder with 2001 transcripts
  const fs3 = makeFs();
  for (let i = 0; i <= 2000; i++) fs3.file(WIN_ROOT + BS + "big" + BS + "s" + name(i) + ".jsonl");
  const r3 = await discover({ fs: fs3, runWsl: noWsl() });
  const files = fs3.calls.filter(([k, p]) => k === "lstat" && p.endsWith(".jsonl"));
  assert.equal(files.length, 2000);
  assert.ok(!files.some(([, p]) => p.endsWith("s" + name(2000) + ".jsonl")));
  assert.equal(r3.projects.length, 1, "the project is still listed");
  assert.ok(r3.notes.some((n) => n.text === "Windows: list truncated"));
  const fs4 = makeFs();
  for (let i = 0; i < 2000; i++) fs4.file(WIN_ROOT + BS + "big" + BS + "s" + name(i) + ".jsonl");
  const r4 = await discover({ fs: fs4, runWsl: noWsl() });
  assert.ok(!r4.notes.some((n) => /truncated/.test(n.text)));
  // a home folder list past 2000 is cut too (the 64-home cap would hide it, so look at lstat)
  const fs5 = makeFs();
  for (let i = 0; i <= 2000; i++) fs5.file(wslRoot("distro-a") + BS + name(i));
  const runWsl = makeRunner({ [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") });
  const r5 = await discover({ fs: fs5, runWsl });
  assert.equal(fs5.calls.filter(([k]) => k === "lstat").length, 64);
  assert.ok(r5.notes.some((n) => n.text === "distro-a: list truncated"));
});

test("timeout: a hung fs returns in time, with the note and no projects", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  fs.hold = hangForever;
  const t0 = Date.now();
  const r = await discover({ fs, runWsl: noWsl(), timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r.projects, []);
  assert.deepEqual(
    r.notes.filter((n) => n.code === "discovery-timeout"),
    [{ code: "discovery-timeout", text: "Discovery timed out" }]
  );
  assert.deepEqual(S.publicView(r).notes, r.notes);
});

test("timeout: partial results are kept, and late completions change nothing and start nothing", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  const dist = wslRoot("distro-a") + BS + "user" + BS + ".claude" + BS + "projects";
  addProject(fs, dist, "q", "/s/wsl-demo");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fs.hold = (kind, p) => (/wsl/.test(p) ? gate : undefined);
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runWsl = makeRunner({ [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") });
    const r = await discover({ fs, runWsl, timeoutMs: 50 });
    assert.deepEqual(
      r.projects.map((p) => p.label),
      ["win-demo"]
    );
    assert.ok(r.notes.some((n) => n.code === "discovery-timeout"));
    const before = JSON.stringify(r);
    const callsBefore = fs.calls.length;
    release();
    for (let i = 0; i < 30; i++) await later();
    assert.equal(JSON.stringify(r), before, "the returned object did not change");
    assert.equal(fs.calls.length, callsBefore, "no new fs call started after the deadline");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("timeout: a wsl.exe call that finishes late cannot add notes to the returned result", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runWsl = async (args) => {
    if (args.join(" ") === LIST) return ok("distro-a" + NL + "distro-b");
    await gate;
    return ok("distro-b");
  };
  const r = await discover({ fs, runWsl, timeoutMs: 50 });
  const before = JSON.stringify(r);
  assert.ok(!before.includes("not running"));
  release();
  for (let i = 0; i < 30; i++) await later();
  assert.equal(JSON.stringify(r), before);
});

test("a finished discovery leaves no timer behind", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  await discover({ fs, runWsl: noWsl(), timeoutMs: 60000 });
  const timers = process.getActiveResourcesInfo().filter((x) => x === "Timeout");
  assert.equal(timers.length, 0, "no pending timer");
});

test("determinism: the same result whatever order the fs calls finish in", async () => {
  const build = () => {
    const fs = makeFs();
    for (let i = 0; i < 24; i++) {
      addProject(fs, WIN_ROOT, "w" + i, "/s/" + (i % 3 ? "w" + i : "same"), T1 + (i % 4) * 1000);
    }
    for (const h of ["a", "b"]) {
      const root = wslRoot("distro-a") + BS + h + BS + ".claude" + BS + "projects";
      for (let i = 0; i < 12; i++) addProject(fs, root, "p" + i, "/s/same", T1 + (i % 3) * 1000);
    }
    fs.dir(wslRoot("distro-a") + BS + "c");
    return fs;
  };
  const replies = { [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") };
  const hashOf = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const run = async (seed) => {
    const fs = build();
    const order = [];
    if (seed) {
      fs.hold = async (kind, p) => {
        const n = ((hashOf(p) * seed) >>> 3) % 9;
        for (let i = 0; i < n; i++) await later();
        order.push(kind + p);
      };
    }
    const r = await discover({ fs, runWsl: makeRunner(replies) });
    return { json: JSON.stringify(r), order };
  };
  const base = await run(0);
  const a = await run(3);
  const b = await run(11);
  assert.ok(JSON.parse(base.json).projects.length > 30);
  assert.notDeepEqual(a.order, b.order, "the two runs really finished in different orders");
  assert.equal(a.json, base.json);
  assert.equal(b.json, base.json);
});

test("a source that is not running makes zero fs calls, even while others are scanned", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  fs.dir(wslRoot("distro-a") + BS + "u");
  fs.dir(wslRoot("distro-b") + BS + "u");
  fs.hold = later;
  const runWsl = makeRunner({ [LIST]: ok("distro-a" + NL + "distro-b"), [RUNNING]: ok("") });
  const r = await discover({ fs, runWsl });
  assert.equal(r.projects.length, 1);
  assert.ok(fs.calls.length > 0);
  assert.ok(
    fs.calls.every(([, p]) => p.startsWith("C:")),
    "only the Windows root was touched"
  );
  assert.deepEqual(
    r.notes.filter((n) => n.code === "not-running").map((n) => n.text),
    ["distro-a skipped: not running", "distro-b skipped: not running"]
  );
});

test("default fs is the promise API: a real folder is discovered", async () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "disc-test-"));
  try {
    const root = nodePath.join(dir, ".claude", "projects");
    nodeFs.mkdirSync(nodePath.join(root, "proj-a"), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(root, "empty-one"));
    nodeFs.writeFileSync(
      nodePath.join(root, "proj-a", "s1.jsonl"),
      JSON.stringify({ cwd: "/s/app-demo" }) + NL
    );
    const r = await S.discoverClaudeProjects({ platform: "linux", homedir: dir, salt: SALT });
    assert.deepEqual(
      r.projects.map((p) => [p.label, p.sourceTag]),
      [["app-demo", "local"]]
    );
    const missing = await S.discoverClaudeProjects({
      platform: "linux",
      homedir: nodePath.join(dir, "nope"),
      salt: SALT
    });
    assert.ok(missing.notes.some((n) => n.text === "Local: no Claude Code projects"));
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("makeDiscoverer: concurrent calls share a scan; a result is reused for the ttl", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  const base = { platform: "win32", homedir: WIN_HOME, now: () => NOW, salt: SALT, fs };
  base.runWsl = noWsl();
  const clock = { v: 1000 };
  const d = S.makeDiscoverer(base, { ttlMs: 5000, now: () => clock.v });
  const [a, b] = await Promise.all([d.discover(), d.discover()]);
  assert.equal(a, b, "one shared result");
  assert.equal(readdirCount(fs, WIN_ROOT), 1, "one scan for two calls");
  clock.v = 5999;
  assert.equal(await d.discover(), a, "reused inside the ttl");
  assert.equal(readdirCount(fs, WIN_ROOT), 1);
  clock.v = 6000;
  const c = await d.discover();
  assert.notEqual(c, a, "rescanned at the ttl");
  assert.equal(readdirCount(fs, WIN_ROOT), 2);
  d.invalidate();
  await d.discover();
  assert.equal(readdirCount(fs, WIN_ROOT), 3, "invalidate forces a rescan");
  // a scan that was running when invalidate() came is not kept
  d.invalidate();
  const running = d.discover();
  d.invalidate();
  await running;
  await d.discover();
  assert.equal(readdirCount(fs, WIN_ROOT), 5);
  assert.equal(a.projects.length, 1);
});

test("makeDiscoverer: a clock that goes backwards does not keep reusing a result", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  const base = { platform: "win32", homedir: WIN_HOME, now: () => NOW, salt: SALT, fs };
  base.runWsl = noWsl();
  const clock = { v: 100000 };
  const d = S.makeDiscoverer(base, { ttlMs: 5000, now: () => clock.v });
  const a = await d.discover();
  clock.v = 1; // jumped far back: the age is negative
  const b = await d.discover();
  assert.notEqual(b, a, "a negative age is a miss");
  assert.equal(readdirCount(fs, WIN_ROOT), 2);
  assert.equal(await d.discover(), b, "and the new result is reused again");
  assert.equal(readdirCount(fs, WIN_ROOT), 2);
});

test("makeDiscoverer: a timed-out or rejected scan is not reused", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  let hang = true;
  fs.hold = () => (hang ? hangForever() : undefined);
  const base = {
    platform: "win32",
    homedir: WIN_HOME,
    now: () => NOW,
    salt: SALT,
    fs,
    runWsl: noWsl(),
    timeoutMs: 30
  };
  const d = S.makeDiscoverer(base, { ttlMs: 60000, now: () => 1 });
  const slow = await d.discover();
  assert.ok(slow.notes.some((n) => n.code === "discovery-timeout"));
  hang = false;
  const fast = await d.discover();
  assert.ok(!fast.notes.some((n) => n.code === "discovery-timeout"), "not the timed-out result");
  assert.equal(fast.projects.length, 1);
  assert.equal(await d.discover(), fast, "a good result is reused");
  // a scan that rejects
  let boom = true;
  const bad = {
    get platform() {
      if (boom) {
        boom = false;
        throw new Error("boom");
      }
      return "win32";
    },
    homedir: WIN_HOME,
    now: () => NOW,
    salt: SALT,
    fs: makeFs(),
    runWsl: noWsl()
  };
  const d2 = S.makeDiscoverer(bad);
  await assert.rejects(d2.discover(), /boom/);
  const again = await d2.discover();
  assert.ok(Array.isArray(again.projects), "the next call scans again");
});

// ---- hardening items ----

test("loadOrCreateSalt without a usable dir writes nothing, not even into the cwd", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "salt-cwd-"));
  const saved = process.cwd();
  try {
    process.chdir(dir);
    const salts = [];
    for (const d of [undefined, "", null, 5, {}]) {
      const r = S.loadOrCreateSalt({ dir: d });
      assert.equal(r.salt.length, 16);
      assert.deepEqual(r.note, { code: "labels-unstable", text: "Labels change after restart" });
      salts.push(r.salt.toString("hex"));
    }
    assert.equal(S.loadOrCreateSalt().salt.length, 16);
    assert.equal(new Set(salts).size, salts.length, "a fresh random salt each time");
    assert.deepEqual(nodeFs.readdirSync(dir), [], "nothing was written into the cwd");
  } finally {
    process.chdir(saved);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateSalt: a folder in the salt file's place gives a note and leaves no temp file", () => {
  const nodeFs = require("fs");
  const nodePath = require("path");
  const base = nodePath.join(__dirname, "..", "..", ".scratch");
  nodeFs.mkdirSync(base, { recursive: true });
  const dir = nodeFs.mkdtempSync(nodePath.join(base, "salt-block-"));
  try {
    nodeFs.mkdirSync(nodePath.join(dir, "label-salt.bin"));
    const r = S.loadOrCreateSalt({ dir, fs: nodeFs });
    assert.equal(r.salt.length, 16);
    assert.deepEqual(r.note, { code: "labels-unstable", text: "Labels change after restart" });
    assert.deepEqual(nodeFs.readdirSync(dir), ["label-salt.bin"], "the temp file was removed");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wsl.exe: SystemRoot is used only as a clean drive-absolute path, else the default", async () => {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push(file);
    cb(null, Buffer.from("x"));
  };
  const dflt = "C:" + BS + "Windows" + BS + "System32" + BS + "wsl.exe";
  const bad = [
    "Windows",
    BS + "Windows",
    BS + BS + "srv" + BS + "share",
    BS + BS + "srv" + BS + "share" + BS + "Windows",
    "C:",
    "C:Windows",
    "C:/Windows",
    "C:" + BS + "Windows" + BS + ".." + BS + "x",
    "C:" + BS + ".." + BS + "x",
    "C:" + BS + "a/../b",
    "C:" + BS + "Win" + String.fromCharCode(10) + "x",
    "C:" + BS + "Win" + String.fromCharCode(0),
    "",
    undefined,
    5
  ];
  for (const SystemRoot of bad) {
    const run = S.makeRunWsl(exec, { env: { SystemRoot } });
    await run(["-l", "-q"]);
    assert.equal(calls[calls.length - 1], dflt, JSON.stringify(SystemRoot));
  }
  const good = [
    "D:" + BS + "Win",
    "c:" + BS + "Windows",
    "C:" + BS,
    "E:" + BS + "a b" + BS + "W.x"
  ];
  for (const SystemRoot of good) {
    const run = S.makeRunWsl(exec, { env: { SystemRoot } });
    await run(["-l", "-q"]);
    const want = require("path").win32.join(SystemRoot, "System32", "wsl.exe");
    assert.equal(calls[calls.length - 1], want, SystemRoot);
  }
  assert.equal(
    calls[calls.length - good.length],
    "D:" + BS + "Win" + BS + "System32" + BS + "wsl.exe"
  );
});

test("home folders written drive-relative, or with trailing dots or spaces, still get the hashed label", async () => {
  const forms = [
    "C:Users" + BS + "user",
    "c:users" + BS + "user",
    "C:" + BS + "Users." + BS + "user",
    "C:" + BS + "Users " + BS + "user",
    "C:" + BS + "Users. ." + BS + "user",
    "C:Users." + BS + "user",
    "/home./user",
    "/Users /user",
    "C:" + BS + "Documents and Settings." + BS + "user"
  ];
  const fs = makeFs();
  forms.forEach((c, i) => addProject(fs, WIN_ROOT, "h" + i, c));
  addProject(fs, WIN_ROOT, "n1", "C:Users" + BS + "user" + BS + "proj-demo");
  addProject(fs, WIN_ROOT, "n2", "C:" + BS + "Users." + BS + "user" + BS + "proj2-demo");
  addProject(fs, WIN_ROOT, "n3", "C:" + BS + "Userspace" + BS + "app3-demo");
  const r = await discover({ fs, runWsl: noWsl() });
  const label = (n) => r.projects.find((p) => p.path === WIN_ROOT + BS + n).label;
  forms.forEach((c, i) => assert.equal(label("h" + i), hash6(c), c));
  assert.equal(label("n1"), "proj-demo", "a folder under a home keeps its name");
  assert.equal(label("n2"), "proj2-demo");
  assert.equal(label("n3"), "app3-demo", "Userspace is not Users");
});

// ---- rework round 1 ----

const WSL_PROJECTS = wslRoot("distro-a") + BS + "user" + BS + ".claude" + BS + "projects";
const wslRunner = () => makeRunner({ [LIST]: ok("distro-a"), [RUNNING]: ok("distro-a") });

test("timeout: with only the cwd open held, a late completion cannot change the returned result", async () => {
  const fs = makeFs();
  addProject(fs, WIN_ROOT, "p", "/s/win-demo");
  addProject(fs, WSL_PROJECTS, "q", "/s/wsl-demo");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // the home and projects listings and every lstat finish; only the cwd open waits
  fs.hold = (kind, p) => (kind === "open" && /wsl/.test(p) ? gate : undefined);
  const r = await discover({ fs, runWsl: wslRunner(), timeoutMs: 30 });
  assert.ok(r.notes.some((n) => n.code === "discovery-timeout"));
  const before = JSON.stringify(r);
  assert.ok(!before.includes("wsl-demo"));
  assert.ok(before.includes("win-demo"));
  assert.equal(fs.handles.opened, 1, "only the Windows cwd was opened so far");
  release();
  for (let i = 0; i < 30; i++) await later();
  assert.equal(fs.handles.opened, 2, "the late open really completed");
  assert.equal(JSON.stringify(r), before, "the returned object did not change");
  assert.ok(!r.projects.some((p) => p.sourceTag === "wsl:distro-a"));
});

test("makeDiscoverer: invalidate drops a scan that is still running", async () => {
  const mk = () => {
    const fs = makeFs();
    addProject(fs, WIN_ROOT, "p", "/s/win-demo");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fs.hold = (kind) => (kind === "readdir" ? gate : undefined);
    const base = { platform: "win32", homedir: WIN_HOME, now: () => NOW, salt: SALT, fs };
    base.runWsl = noWsl();
    return { fs, release, d: S.makeDiscoverer(base, { ttlMs: 60000, now: () => 1 }) };
  };
  // a call after invalidate() starts its own scan while the first is still held
  const a = mk();
  const p1 = a.d.discover();
  a.d.invalidate();
  const p2 = a.d.discover();
  await later();
  assert.notEqual(p1, p2, "the dropped scan is not handed out again");
  assert.equal(readdirCount(a.fs, WIN_ROOT), 2, "two scans, both still waiting");
  a.release();
  await Promise.all([p1, p2]);
  // the dropped scan's result is not cached
  const b = mk();
  const q1 = b.d.discover();
  b.d.invalidate();
  b.release();
  await q1;
  await b.d.discover();
  assert.equal(readdirCount(b.fs, WIN_ROOT), 2, "the dropped result was not reused");
});

test("WSL: a cut listing inside one home adds the distro's truncated note", async () => {
  const name = (i) => "f" + String(i).padStart(4, "0");
  // the projects folder of the home holds 2001 entries
  const fs = makeFs();
  for (let i = 0; i <= 2000; i++) fs.file(WSL_PROJECTS + BS + name(i));
  const r = await discover({ fs, runWsl: wslRunner() });
  assert.ok(r.notes.some((n) => n.text === "distro-a: list truncated" && n.distro === "distro-a"));
  // one project folder with 2001 transcripts
  const fs2 = makeFs();
  for (let i = 0; i <= 2000; i++) fs2.file(WSL_PROJECTS + BS + "big" + BS + name(i) + ".jsonl");
  const r2 = await discover({ fs: fs2, runWsl: wslRunner() });
  assert.ok(r2.notes.some((n) => n.text === "distro-a: list truncated"));
  assert.equal(r2.projects.filter((p) => p.sourceTag === "wsl:distro-a").length, 1);
  // exactly 2000: no note
  const fs3 = makeFs();
  for (let i = 0; i < 2000; i++) fs3.file(WSL_PROJECTS + BS + "big" + BS + name(i) + ".jsonl");
  const r3 = await discover({ fs: fs3, runWsl: wslRunner() });
  assert.ok(!r3.notes.some((n) => /truncated/.test(n.text)));
});

test("every opened file handle is closed: normal run, a failing read, a late open", async () => {
  const fs = makeFs();
  for (let i = 0; i < 6; i++) addProject(fs, WIN_ROOT, "p" + i, "/s/p" + i);
  await discover({ fs, runWsl: noWsl() });
  assert.equal(fs.handles.opened, 6);
  assert.equal(fs.handles.closed, 6);
  // read throws EIO
  const fs2 = makeFs();
  for (let i = 0; i < 3; i++) addProject(fs2, WIN_ROOT, "p" + i, "/s/p" + i);
  fs2.hold = (kind) => {
    if (kind === "read") throw Object.assign(new Error("EIO"), { code: "EIO" });
    return undefined;
  };
  const r2 = await discover({ fs: fs2, runWsl: noWsl() });
  assert.equal(r2.projects.length, 3, "projects are listed with hash labels");
  assert.equal(fs2.handles.opened, 3);
  assert.equal(fs2.handles.closed, 3);
  // open resolves after the deadline
  const fs3 = makeFs();
  addProject(fs3, WIN_ROOT, "p", "/s/win-demo");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fs3.hold = (kind) => (kind === "open" ? gate : undefined);
  const r3 = await discover({ fs: fs3, runWsl: noWsl(), timeoutMs: 30 });
  assert.ok(r3.notes.some((n) => n.code === "discovery-timeout"));
  assert.equal(fs3.handles.opened, 0);
  release();
  for (let i = 0; i < 30; i++) await later();
  assert.equal(fs3.handles.opened, 1);
  assert.equal(fs3.handles.closed, 1, "the late handle was closed");
});

test("timeoutMs is clamped to the largest timer delay: huge values do not fire at once", async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    for (const timeoutMs of [Infinity, 3e9, 2 ** 31, 2147483647, 2147483648]) {
      const fs = makeFs();
      addProject(fs, WIN_ROOT, "p", "/s/win-demo");
      fs.hold = (kind) =>
        kind === "readdir" ? new Promise((resolve) => setTimeout(resolve, 15)) : undefined;
      const t0 = Date.now();
      const r = await discover({ fs, runWsl: noWsl(), timeoutMs });
      const tag = "timeoutMs " + timeoutMs;
      assert.ok(!r.notes.some((n) => n.code === "discovery-timeout"), tag);
      assert.deepEqual(
        r.projects.map((p) => p.label),
        ["win-demo"],
        tag
      );
      assert.ok(Date.now() - t0 < 2000, tag);
      assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, 0, tag);
    }
    for (let i = 0; i < 10; i++) await later();
    assert.deepEqual(warnings, [], "no TimeoutOverflowWarning");
  } finally {
    process.off("warning", onWarning);
  }
});

test("timeoutMs: zero, negative and NaN fall back to the default, not to an instant timeout", async () => {
  for (const timeoutMs of [0, -5, NaN, "x"]) {
    const fs = makeFs();
    addProject(fs, WIN_ROOT, "p", "/s/win-demo");
    fs.hold = (kind) =>
      kind === "readdir" ? new Promise((resolve) => setTimeout(resolve, 15)) : undefined;
    const r = await discover({ fs, runWsl: noWsl(), timeoutMs });
    assert.equal(r.projects.length, 1, "timeoutMs " + timeoutMs);
    assert.ok(!r.notes.some((n) => n.code === "discovery-timeout"));
  }
});

test("project folder cap counts only .jsonl names; session sub-folders never count", async () => {
  const name = (i) => "f" + String(i).padStart(4, "0");
  const stats = (fs) => fs.calls.filter(([k]) => k === "lstat").map(([, p]) => p);
  const big = WIN_ROOT + BS + "big";
  // (a) 2001 .jsonl names plus 3000 folders: cut to 2000 .jsonl, note, the 2001st never stat'ed
  const fsA = makeFs();
  for (let i = 0; i <= 2000; i++) fsA.file(big + BS + name(i) + ".jsonl");
  for (let i = 0; i < 3000; i++) fsA.dir(big + BS + "d" + name(i));
  const rA = await discover({ fs: fsA, runWsl: noWsl() });
  const stA = stats(fsA);
  assert.equal(stA.filter((p) => p.endsWith(".jsonl")).length, 2000);
  assert.ok(!stA.includes(big + BS + name(2000) + ".jsonl"), "the 2001st name was never stat'ed");
  assert.equal(stA.filter((p) => p.startsWith(big + BS + "d")).length, 0, "folders never stat'ed");
  assert.ok(rA.notes.some((n) => n.text === "Windows: list truncated"));
  assert.equal(rA.projects.length, 1);
  // (b) exactly 2000 .jsonl plus 3000 folders: nothing cut, no note
  const fsB = makeFs();
  for (let i = 0; i < 2000; i++) fsB.file(big + BS + name(i) + ".jsonl");
  for (let i = 0; i < 3000; i++) fsB.dir(big + BS + "d" + name(i));
  const rB = await discover({ fs: fsB, runWsl: noWsl() });
  assert.equal(stats(fsB).filter((p) => p.endsWith(".jsonl")).length, 2000);
  assert.ok(!rB.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(rB.notes));
  // (c) 5 .jsonl plus 3000 folders: no note; the newest .jsonl (last in name order) sets mtime
  const fsC = makeFs();
  for (let i = 0; i < 4; i++) fsC.file(big + BS + name(i) + ".jsonl", "{}", T1);
  fsC.file(big + BS + "zz-new.jsonl", JSON.stringify({ cwd: "/s/new-demo" }) + NL, T2);
  for (let i = 0; i < 3000; i++) fsC.dir(big + BS + "d" + name(i));
  const rC = await discover({ fs: fsC, runWsl: noWsl() });
  assert.ok(!rC.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(rC.notes));
  assert.equal(stats(fsC).filter((p) => p.endsWith(".jsonl")).length, 5);
  assert.deepEqual(
    rC.projects.map((p) => [p.label, p.mtime]),
    [["new-demo", T2]]
  );
  // the same through a WSL home
  const fsD = makeFs();
  fsD.file(WSL_PROJECTS + BS + "big" + BS + "a.jsonl", "{}", T1);
  for (let i = 0; i < 3000; i++) fsD.dir(WSL_PROJECTS + BS + "big" + BS + "d" + name(i));
  const rD = await discover({ fs: fsD, runWsl: wslRunner() });
  assert.ok(!rD.notes.some((n) => /truncated/.test(n.text)), JSON.stringify(rD.notes));
});
