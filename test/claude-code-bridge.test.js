/**
 * Claude Code mode of the real bridge: the source switch, project discovery and select, and
 * proof that no route or stream carries a path. Everything lives in a folder under the
 * worktree's .scratch/ (never system temp); discovery runs on a fake home with platform
 * "linux", so wsl.exe is never touched and the real home is never read.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { buildForbidden } = require("./helpers/privacy-patterns");
const L = require("./helpers/claude-lines");

const PLANTED = "zqplanted";
const SCRATCH = path.join(__dirname, "..", ".scratch", "u4-cc-bridge");
const HOME = path.join(SCRATCH, "home");
const CURSOR_ROOT = path.join(SCRATCH, "cursor-projects");
const LOG_DIR = path.join(SCRATCH, "app-data");
const SALT_DIR = path.join(SCRATCH, "config");
const HEADERS = {
  "Content-Type": "application/json",
  "Sec-Fetch-Site": "same-origin",
  "X-Cursor-Bridge": "1"
};
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);

/** Forbidden words come from the test's real paths, plus the planted name and the generic patterns. */
const FORBIDDEN = buildForbidden(
  [PLANTED, HOME, SCRATCH, CURSOR_ROOT, LOG_DIR, jsonEsc(HOME), jsonEsc(SCRATCH), "/home/"].filter(
    Boolean
  )
);
const DRIVE_PATH = /[A-Za-z]:(\\|\/)/;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {}
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Every response body and stream chunk seen in Claude Code mode, checked for paths at the end. */
const seen = [];
function record(label, text) {
  seen.push({ label, text });
}

const get = async (port, p, track) => {
  const res = await request(port, { path: p });
  if (track) record("GET " + p, res.body);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
};
const post = async (port, p, body, track, headers) => {
  const res = await request(port, {
    method: "POST",
    path: p,
    headers: headers || HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  if (track) record("POST " + p, res.body);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_e) {
    /* keep null */
  }
  return { status: res.status, json };
};

function openStream(port) {
  let text = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" });
  req.on("response", (res) => res.on("data", (d) => (text += d)));
  req.on("error", () => {});
  return {
    text: () => text,
    async waitFor(needle, from) {
      for (let i = 0; i < 100; i++) {
        if (text.indexOf(needle, from || 0) !== -1) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("stream never showed " + needle + ": " + text);
    },
    close: () => req.destroy()
  };
}

function writeJsonl(file, cwd, mtimeSec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd, sessionId: "s1" }) + "\n");
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

/** fs.promises with every call counted; `blocked` makes all calls hang forever. */
function countingFs(blocked) {
  const counter = { calls: 0 };
  const proxy = new Proxy(fs.promises, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args) => {
        counter.calls++;
        return blocked ? new Promise(() => {}) : v.apply(target, args);
      };
    }
  });
  return { fs: proxy, counter };
}

function buildTrees() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const base = Math.floor(Date.now() / 1000) - 1000;
  const proj = path.join(HOME, ".claude", "projects");
  writeJsonl(path.join(proj, "enc-a", "a.jsonl"), "/home/" + PLANTED + "/proj-demo", base + 30);
  writeJsonl(path.join(proj, "enc-b", "b.jsonl"), "/srv/other-demo", base + 20);
  writeJsonl(path.join(proj, "enc-c", "c.jsonl"), "/home/" + PLANTED, base + 10);
  for (const [name, off] of [
    ["cur-a", 10],
    ["cur-b", 20]
  ]) {
    const dir = path.join(CURSOR_ROOT, name, "agent-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.utimesSync(dir, base + off, base + off);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

async function withBridge(opts, fn) {
  const { startBridge, stopBridge } = require("../live-bridge.js");
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: CURSOR_ROOT,
    // a named Cursor folder starts Cursor mode; the Claude Code default is pinned by testDefaultSource
    dir: path.join(CURSOR_ROOT, "cur-b", "agent-transcripts"),
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    ...opts
  });
  try {
    return await fn(port);
  } finally {
    await stopBridge();
  }
}

const claudeBag = (extra) => ({ platform: "linux", homedir: HOME, ...extra });

async function testGuards(port, label) {
  for (const p of ["/api/source", "/api/select"]) {
    const g = await request(port, { path: p, headers: HEADERS });
    assert.strictEqual(g.status, 405, `${label} GET ${p}: expected 405`);
    const noHeader = await request(port, {
      method: "POST",
      path: p,
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: '{"source":"cursor","id":"x"}'
    });
    assert.strictEqual(noHeader.status, 403, `${label} POST ${p} without header: expected 403`);
    for (const extra of [
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example" }
    ]) {
      const bad = await request(port, {
        method: "POST",
        path: p,
        headers: { ...HEADERS, ...extra },
        body: '{"source":"cursor","id":"x"}'
      });
      assert.strictEqual(bad.status, 403, `${label} POST ${p} ${JSON.stringify(extra)}: 403`);
    }
  }
}

async function testSwitching() {
  const counted = countingFs(false);
  await withBridge({ claudeCode: claudeBag({ fs: counted.fs }) }, async (port) => {
    // Cursor stays the default and its routes still carry what they always did
    const st0 = (await get(port, "/api/status")).json;
    assert.strictEqual(st0.source, "cursor");
    assert.strictEqual(st0.projectId, "cur-b");
    assert.ok(st0.transcripts.includes("cur-b"), "cursor status keeps transcripts");
    assert.strictEqual(typeof st0.exists, "boolean");
    const cursorProjects = (await get(port, "/api/projects")).json;
    assert.ok(cursorProjects.transcripts && cursorProjects.projects[0].path, "cursor keeps paths");
    const pickA = await post(port, "/api/select", { id: "cur-a" });
    assert.strictEqual(pickA.status, 200);
    assert.ok(pickA.json.transcripts.includes("cur-a"));
    assert.strictEqual(counted.counter.calls, 0, "discovery never runs in Cursor mode");
    const hist0 = await get(port, "/api/history");
    assert.ok(Array.isArray(hist0.json.events) && !hist0.json.notes, "cursor history unchanged");

    // invalid values
    for (const body of ['{"source":"nope"}', '{"source":5}', "{}", "{", '{"source":null}']) {
      const r = await post(port, "/api/source", body);
      assert.strictEqual(r.status, 400, "source " + body + ": expected 400");
    }
    assert.strictEqual((await get(port, "/api/status")).json.source, "cursor");
    await testGuards(port, "cursor mode");

    // switch
    const stream = openStream(port);
    await stream.waitFor("event: hello");
    const sw = await post(port, "/api/source", { source: "claude-code" }, true);
    assert.strictEqual(sw.status, 200);
    assert.deepStrictEqual(sw.json, { ok: true, source: "claude-code" });
    await stream.waitFor("event: reset");
    assert.ok(counted.counter.calls > 0, "switching runs discovery to pick the newest project");

    const listed = await get(port, "/api/projects", true);
    assert.ok(counted.counter.calls > 0, "discovery runs in Claude Code mode");
    const body = listed.json;
    assert.strictEqual(body.source, "claude-code");
    assert.strictEqual(body.transcripts, undefined);
    assert.strictEqual(body.projects.length, 3);
    for (const p of body.projects) {
      assert.deepStrictEqual(Object.keys(p).sort(), ["id", "label", "mtime", "sourceTag"]);
    }
    const labels = body.projects.map((p) => p.label);
    assert.ok(labels.includes("proj-demo") && labels.includes("other-demo"), labels.join());
    const hashed = body.projects.find((p) => !["proj-demo", "other-demo"].includes(p.label));
    assert.ok(hashed && !hashed.label.includes(PLANTED), "home folder gets a hashed label");
    const byLabel = (l) => body.projects.find((p) => p.label === l);

    // select: only ids from the last discovery
    const realDir = path.join(HOME, ".claude", "projects", "enc-a");
    for (const bad of [realDir, "../x", "unknown-id", "__proto__", HOME, "enc-a"]) {
      const r = await post(port, "/api/select", { id: bad }, true);
      assert.strictEqual(r.status, 400, "select " + bad + ": expected 400");
      assert.strictEqual(r.json.error, "Unknown or disallowed project id");
    }
    assert.strictEqual((await post(port, "/api/select", {}, true)).status, 400);
    const sel = await post(port, "/api/select", { id: byLabel("proj-demo").id }, true);
    assert.strictEqual(sel.status, 200);
    assert.deepStrictEqual(sel.json, {
      ok: true,
      projectId: byLabel("proj-demo").id,
      projectLabel: "proj-demo",
      source: "claude-code"
    });
    await stream.waitFor("watching proj-demo");
    assert.ok(stream.text().includes('"source":"claude-code"'));

    // every other route in this mode
    const status = (await get(port, "/api/status", true)).json;
    assert.strictEqual(status.source, "claude-code");
    assert.strictEqual(status.projectLabel, "proj-demo");
    assert.strictEqual(status.projectCount, 3);
    for (const k of ["transcripts", "exists"]) assert.ok(!(k in status), k + " must be absent");
    assert.strictEqual(status.drift.lastSample, "");
    const evs = (await get(port, "/api/events", true)).json;
    assert.strictEqual(evs.source, "claude-code");
    assert.strictEqual(evs.transcripts, undefined);
    assert.ok(evs.events.some((e) => e.message === "bridge online · watching proj-demo"));
    assert.ok(!evs.events.some((e) => /cur[ -]/.test(e.message)), "no Cursor event leaks in");
    const hist = (await get(port, "/api/history", true)).json;
    assert.deepStrictEqual(hist, {
      events: [],
      latestSessionId: null,
      notes: [{ code: "history-off", text: "History is not available for Claude Code yet" }]
    });
    assert.strictEqual((await get(port, "/api/alerts", true)).status, 200);
    assert.strictEqual((await post(port, "/api/snooze", { snoozed: false }, true)).status, 200);
    await testGuards(port, "claude-code mode");

    // history clear must not wipe the Cursor log from Claude Code mode
    const { recordHistoryEvent, clearHistory } = require("../live-bridge.js");
    const kept = recordHistoryEvent({
      ts: new Date().toISOString(),
      sessionId: "keep-session",
      agentId: "keep-agent",
      name: "Worker",
      model: "sonnet",
      type: "spawn",
      inputTokens: 1,
      outputTokens: 1,
      files: []
    });
    assert.ok(kept, "the seeded event was recorded");
    const refused = await post(port, "/api/history/clear", {});
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.json.ok, false);
    assert.deepStrictEqual(clearHistory(), { ok: false, cleared: false });
    const onDisk = fs
      .readdirSync(LOG_DIR)
      .map((f) => fs.readFileSync(path.join(LOG_DIR, f), "utf8"))
      .join(String.fromCharCode(10));
    assert.ok(onDisk.includes("keep-agent"), "the Cursor event log survived the refused clear");

    // a second stream connecting now sees a path-free hello and backlog
    const late = openStream(port);
    await late.waitFor("watching proj-demo");
    record("SSE hello+backlog", late.text());
    record("SSE reset+after", stream.text().slice(stream.text().indexOf("event: reset")));
    assert.ok(!late.text().includes('"transcripts"'));
    assert.ok(
      !stream.text().slice(stream.text().indexOf("event: reset")).includes('"transcripts"')
    );
    late.close();

    // back to Cursor: the earlier Cursor project and a fresh watch state return
    const back = await post(port, "/api/source", { source: "cursor" });
    assert.deepStrictEqual(back.json, { ok: true, source: "cursor" });
    const st1 = (await get(port, "/api/status")).json;
    assert.strictEqual(st1.source, "cursor");
    assert.strictEqual(st1.projectId, "cur-a", "previous Cursor project restored");
    assert.ok(st1.transcripts.includes("cur-a"));
    const ev1 = (await get(port, "/api/events")).json;
    assert.ok(ev1.events.some((e) => e.message === "bridge online · watching cur a"));
    assert.ok(!ev1.events.some((e) => /proj-demo/.test(e.message)));
    assert.ok(ev1.transcripts.includes("cur-a"));
    assert.strictEqual((await get(port, "/api/projects")).json.selectedId, "cur-a");

    // and into Claude Code again: its selection was kept
    await post(port, "/api/source", { source: "claude-code" });
    assert.strictEqual((await get(port, "/api/status")).json.projectLabel, "proj-demo");
    stream.close();
  });
}

async function testTimeout() {
  const hang = countingFs(true);
  await withBridge({ claudeCode: claudeBag({ fs: hang.fs, timeoutMs: 60 }) }, async (port) => {
    await post(port, "/api/source", { source: "claude-code" });
    const r = await request(port, { path: "/api/projects" });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.deepStrictEqual(j.projects, []);
    assert.ok(
      j.notes.some((n) => n.code === "discovery-timeout"),
      r.body
    );
    const s = await request(port, { path: "/api/status" });
    assert.strictEqual(s.status, 200);
    for (const t of [r.body, s.body]) assert.ok(!FORBIDDEN.test(t) && !DRIVE_PATH.test(t), t);
  });
}

/** The SSE hello names the source in both modes; the dashboard reconciles on it. */
async function helloOf(port) {
  const stream = openStream(port);
  try {
    await stream.waitFor("event: hello\ndata: ");
    await stream.waitFor("}\n\n");
    const m = /event: hello\ndata: (.*)\n\n/.exec(stream.text());
    if (!m) throw new Error("no hello in stream: " + stream.text());
    return { json: JSON.parse(m[1]), text: m[1] };
  } finally {
    stream.close();
  }
}

/**
 * A fresh bridge reads Claude Code. A named Cursor folder (opts.dir, CURSOR_TRANSCRIPTS or
 * --dir) is an explicit ask for Cursor and starts Cursor mode instead.
 */
async function testDefaultSource() {
  const cursorDir = path.join(CURSOR_ROOT, "cur-b", "agent-transcripts");
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  const savedArgv = process.argv.slice();
  delete process.env.CURSOR_TRANSCRIPTS;
  try {
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      const st = (await get(port, "/api/status", true)).json;
      assert.strictEqual(st.source, "claude-code", "no options: status reads Claude Code");
      assert.strictEqual(st.transcripts, undefined, "claude-code status has no Cursor folder");
      const hello = (await helloOf(port)).json;
      assert.strictEqual(hello.source, "claude-code", "no options: hello names Claude Code");
      assert.strictEqual(hello.transcripts, undefined);
      const projects = (await get(port, "/api/projects", true)).json;
      assert.ok(
        projects.projects.every((p) => p.id !== "cur-a" && p.id !== "cur-b"),
        "the project list is Claude Code's, not the Cursor tree"
      );
      assert.ok(projects.projects.length >= 1, "Claude Code projects are listed at launch");
    });

    await withBridge({ dir: cursorDir, claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual((await get(port, "/api/status")).json.source, "cursor", "opts.dir");
      assert.strictEqual((await helloOf(port)).json.source, "cursor", "opts.dir hello");
    });

    process.env.CURSOR_TRANSCRIPTS = cursorDir;
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual(
        (await get(port, "/api/status")).json.source,
        "cursor",
        "CURSOR_TRANSCRIPTS"
      );
    });
    delete process.env.CURSOR_TRANSCRIPTS;

    process.argv.push("--dir", cursorDir);
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual((await get(port, "/api/status")).json.source, "cursor", "--dir");
    });
  } finally {
    process.argv.length = 0;
    process.argv.push(...savedArgv);
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
  }
}

/**
 * explicitDir: true in /api/status and the SSE hello when the process started with a Cursor
 * folder (opts.dir, CURSOR_TRANSCRIPTS or --dir), false otherwise. A boolean only (no folder),
 * and it describes the start, so it stays true after a switch to Claude Code and back.
 */
async function testExplicitDirFlag() {
  const cursorDir = path.join(CURSOR_ROOT, "cur-b", "agent-transcripts");
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  const savedArgv = process.argv.slice();
  delete process.env.CURSOR_TRANSCRIPTS;
  const check = async (port, want, label) => {
    const st = (await get(port, "/api/status", want === false)).json;
    assert.strictEqual(st.explicitDir, want, label + ": status explicitDir");
    const hello = await helloOf(port);
    assert.strictEqual(hello.json.explicitDir, want, label + ": hello explicitDir");
  };
  try {
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      await check(port, false, "no options");
      const raw = (await request(port, { path: "/api/status" })).body;
      record("status explicitDir (claude-code)", raw);
    });
    await withBridge({ dir: cursorDir, claudeCode: claudeBag() }, async (port) => {
      await check(port, true, "opts.dir");
      assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
      const st = (await get(port, "/api/status", true)).json;
      assert.strictEqual(st.source, "claude-code");
      assert.strictEqual(st.explicitDir, true, "still true in Claude Code mode");
      const hello = await helloOf(port);
      assert.strictEqual(hello.json.explicitDir, true);
      assert.strictEqual(hello.json.transcripts, undefined);
      record("SSE hello explicitDir (claude-code)", hello.text);
      record("status explicitDir (claude-code, switched)", JSON.stringify(st));
      assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
      await check(port, true, "after switching back");
    });
    process.env.CURSOR_TRANSCRIPTS = cursorDir;
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      await check(port, true, "CURSOR_TRANSCRIPTS");
    });
    delete process.env.CURSOR_TRANSCRIPTS;
    process.argv.push("--dir", cursorDir);
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      await check(port, true, "--dir");
    });
    process.argv.length = 0;
    process.argv.push(...savedArgv);
    // a restart without a folder forgets it
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      await check(port, false, "restart without a folder");
    });
  } finally {
    process.argv.length = 0;
    process.argv.push(...savedArgv);
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
  }
}

async function testHelloSource() {
  await withBridge({ claudeCode: claudeBag() }, async (port) => {
    const cursorHello = (await helloOf(port)).json;
    assert.strictEqual(cursorHello.source, "cursor", "cursor mode hello names its source");
    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
    const ccHello = await helloOf(port);
    assert.strictEqual(ccHello.json.source, "claude-code", "claude-code hello names its source");
    assert.strictEqual(ccHello.json.transcripts, undefined, "claude-code hello has no transcripts");
    record("SSE hello (claude-code)", ccHello.text);
  });
}

async function testCursorResetNamesSource() {
  await withBridge({ claudeCode: claudeBag() }, async (port) => {
    const stream = openStream(port);
    try {
      await stream.waitFor("event: hello\ndata: ");
      assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
      await stream.waitFor('"source":"claude-code"');
      assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
      const resets = [];
      const last = () => resets[resets.length - 1];
      const done = () => resets.length >= 2 && last().source === "cursor";
      for (let i = 0; i < 100 && !done(); i++) {
        resets.length = 0;
        for (const m of stream.text().matchAll(/event: reset\ndata: (.*)\n\n/g)) {
          resets.push(JSON.parse(m[1]));
        }
        if (!done()) await new Promise((r) => setTimeout(r, 30));
      }
      // the switch to Claude Code resets once, and once more if it auto-selects a project
      assert.ok(resets.length >= 2, "a reset per switch");
      assert.strictEqual(resets[0].source, "claude-code", "claude-code reset names its source");
      assert.ok(
        resets.slice(0, -1).every((r) => r.source === "claude-code"),
        "only the last reset is Cursor's"
      );
      assert.strictEqual(last().source, "cursor", "cursor reset names its source");
    } finally {
      stream.close();
    }
  });
}

function testSaltLoadOptions() {
  const { saltLoadOptions } = require("../live-bridge.js");
  const { resolveSaltDir } = require("../lib/claude-code-sources.js");
  const { resolveLogDir } = require("../lib/event-log.js");
  const logDir = path.join(SCRATCH, "some-log-folder");
  // under BRIDGE_TEST=1 with no saltDir: nothing to read or write, so no real config path
  assert.strictEqual(saltLoadOptions({ eventLogDir: logDir }, { BRIDGE_TEST: "1" }), null);
  assert.strictEqual(saltLoadOptions({}, { BRIDGE_TEST: "1" }), null);
  // an explicit saltDir is used even under BRIDGE_TEST=1, and the log folder is the old one
  const explicit = saltLoadOptions(
    { saltDir: SALT_DIR, eventLogDir: logDir },
    { BRIDGE_TEST: "1" }
  );
  assert.deepStrictEqual(explicit, {
    dir: path.resolve(SALT_DIR),
    oldDir: resolveLogDir({ logDir })
  });
  // a real run: the config folder, never the log folder; the log folder is where to migrate from
  for (const env of [{}, { BRIDGE_TEST: "0" }, { CURSOR_EVENT_LOG_DIR: logDir }]) {
    const got = saltLoadOptions({ eventLogDir: logDir }, env);
    assert.ok(got, "options for a real run");
    assert.strictEqual(got.dir, resolveSaltDir({ env }));
    assert.strictEqual(got.oldDir, resolveLogDir({ logDir }));
    assert.notStrictEqual(got.dir, got.oldDir, "the salt is not kept in the event-log folder");
    assert.ok(got.dir.endsWith("cursor-agents-model-routing-config"), got.dir);
  }
  const noLog = saltLoadOptions({}, {});
  assert.strictEqual(noLog.oldDir, resolveLogDir({ logDir: undefined }));
  assert.strictEqual(noLog.dir, resolveSaltDir({ env: {} }));
  // a relative saltDir becomes an absolute one
  const rel = saltLoadOptions({ saltDir: "rel/x" }, {});
  assert.ok(path.isAbsolute(rel.dir), rel.dir);
  assert.strictEqual(rel.dir, path.resolve("rel/x"));
  // under BRIDGE_TEST=1 with a saltDir but no eventLogDir: never the real log folder
  assert.strictEqual(saltLoadOptions({ saltDir: SALT_DIR }, { BRIDGE_TEST: "1" }).oldDir, "");
  assert.strictEqual(
    saltLoadOptions({ saltDir: SALT_DIR, eventLogDir: "" }, { BRIDGE_TEST: "1" }).oldDir,
    ""
  );
}

/** A test process that names no salt folder is refused; AW_TEST=1 may name one in AW_SALT_DIR. */
function testSaltGuard() {
  const { saltLoadOptions } = require("../live-bridge.js");
  for (const env of [{ NODE_TEST_CONTEXT: "child-v8" }, { AW_TEST: "1" }]) {
    assert.throws(() => saltLoadOptions({}, env), /tests must pass an explicit saltDir/);
    assert.throws(() => saltLoadOptions({ eventLogDir: LOG_DIR }, env), /explicit saltDir/);
    assert.strictEqual(saltLoadOptions({ saltDir: SALT_DIR }, env).dir, path.resolve(SALT_DIR));
  }
  // BRIDGE_TEST=1 keeps its own rule (no salt file at all) and never throws
  assert.strictEqual(saltLoadOptions({}, { BRIDGE_TEST: "1", NODE_TEST_CONTEXT: "x" }), null);
  // AW_SALT_DIR is honored only with AW_TEST=1
  assert.strictEqual(
    saltLoadOptions({}, { AW_TEST: "1", AW_SALT_DIR: SALT_DIR }).dir,
    path.resolve(SALT_DIR)
  );
  assert.throws(
    () => saltLoadOptions({}, { NODE_TEST_CONTEXT: "x", AW_SALT_DIR: SALT_DIR }),
    /explicit saltDir/
  );
  // AW_TEST="0" is not a test marker: no throw, and AW_SALT_DIR is ignored
  const off = saltLoadOptions(
    {},
    { AW_TEST: "0", AW_SALT_DIR: SALT_DIR, XDG_CONFIG_HOME: SCRATCH }
  );
  assert.notStrictEqual(off.dir, path.resolve(SALT_DIR));
  const env0 = { AW_TEST: "0", AW_SALT_DIR: SALT_DIR, XDG_CONFIG_HOME: SCRATCH };
  assert.strictEqual(
    off.dir,
    require("../lib/claude-code-sources.js").resolveSaltDir({ env: env0 })
  );
  // opts.saltDir wins over AW_SALT_DIR
  const other = path.join(SCRATCH, "other-salt");
  assert.strictEqual(
    saltLoadOptions({ saltDir: other }, { AW_TEST: "1", AW_SALT_DIR: SALT_DIR }).dir,
    path.resolve(other)
  );
  // BRIDGE_TEST=1 with AW_TEST=1 and AW_SALT_DIR (no opts.saltDir) uses AW_SALT_DIR
  assert.strictEqual(
    saltLoadOptions({}, { BRIDGE_TEST: "1", AW_TEST: "1", AW_SALT_DIR: SALT_DIR }).dir,
    path.resolve(SALT_DIR)
  );
  // an ordinary run (no test markers) still uses the real config folder
  assert.ok(saltLoadOptions({}, { XDG_CONFIG_HOME: path.resolve(SCRATCH, "x") }).dir);
}

/** Under BRIDGE_TEST=1 with no saltDir the salt is random per start, never a fixed value. */
async function testBridgeTestSaltIsRandom() {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    await withBridge({ claudeCode: claudeBag() }, async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      const r = await request(port, { path: "/api/projects" });
      ids.push(JSON.parse(r.body).projects.map((p) => p.id));
    });
  }
  assert.strictEqual(ids[0].length, 3);
  for (let k = 0; k < 3; k++) {
    assert.notStrictEqual(ids[0][k], ids[1][k], "project id " + k + " differs between starts");
  }
}

/** BRIDGE_TEST=1 with no saltDir: no salt file or config folder appears anywhere under a fake home. */
async function testBridgeTestSaltIsolation() {
  const fakeHome = path.join(SCRATCH, "iso-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const keys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = fakeHome;
  try {
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      const r = await request(port, { path: "/api/projects" });
      assert.strictEqual(JSON.parse(r.body).projects.length, 3, "discovery works");
    });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "label-salt.bin" || e.name === "cursor-agents-model-routing-config") {
        found.push(path.join(d, e.name));
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(fakeHome);
  assert.deepStrictEqual(found, [], "no salt file or config folder under the fake home");
  assert.deepStrictEqual(fs.readdirSync(fakeHome), [], "the fake home is untouched");
}

async function testSalt() {
  // unreadable app-data folder (a file stands where the folder should be)
  const badDir = path.join(SCRATCH, "not-a-folder");
  fs.writeFileSync(badDir, "x");
  await withBridge({ saltDir: badDir, claudeCode: claudeBag() }, async (port) => {
    await post(port, "/api/source", { source: "claude-code" });
    const r = await request(port, { path: "/api/projects" });
    const j = JSON.parse(r.body);
    assert.deepStrictEqual(
      j.notes.filter((n) => n.code === "labels-unstable"),
      [{ code: "labels-unstable", text: "Labels change after restart" }]
    );
    assert.strictEqual(j.projects.length, 3, "discovery still works with an in-memory salt");
    const s = JSON.parse((await request(port, { path: "/api/status" })).body);
    assert.ok(s.notes.some((n) => n.code === "labels-unstable"));
    assert.ok(!FORBIDDEN.test(r.body) && !DRIVE_PATH.test(r.body), r.body);
  });

  // a good folder: no note, and the same ids and labels after a restart
  const listing = (port) =>
    request(port, { path: "/api/projects" }).then((r) => {
      const j = JSON.parse(r.body);
      return { notes: j.notes, ids: j.projects.map((p) => [p.id, p.label]) };
    });
  const run = () =>
    withBridge({ saltDir: SALT_DIR, claudeCode: claudeBag() }, async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      return listing(port);
    });
  const first = await run();
  assert.ok(
    fs.existsSync(path.join(SALT_DIR, "label-salt.bin")),
    "salt file is in the config folder"
  );
  assert.ok(
    !fs.readdirSync(LOG_DIR).some((n) => n.startsWith("label-salt")),
    "no salt file in the event-log folder"
  );
  const second = await run();
  assert.ok(!first.notes.some((n) => n.code === "labels-unstable"));
  assert.deepStrictEqual(second.ids, first.ids, "ids and labels survive a restart");
  assert.strictEqual(first.ids.length, 3);

  // an earlier version kept the salt in the event-log folder: the same ids come back from the
  // config folder, the old file is gone and a neighbour in that folder is untouched
  const oldSalt = fs.readFileSync(path.join(SALT_DIR, "label-salt.bin"));
  const freshDir = path.join(SCRATCH, "config-migrated");
  fs.writeFileSync(path.join(LOG_DIR, "label-salt.bin"), oldSalt);
  fs.writeFileSync(path.join(LOG_DIR, "neighbour.txt"), "keep");
  const migrated = await withBridge(
    { saltDir: freshDir, claudeCode: claudeBag() },
    async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      return listing(port);
    }
  );
  assert.deepStrictEqual(migrated.ids, first.ids, "migration keeps ids and labels");
  assert.deepStrictEqual(fs.readFileSync(path.join(freshDir, "label-salt.bin")), oldSalt);
  assert.ok(!fs.existsSync(path.join(LOG_DIR, "label-salt.bin")), "old salt file removed");
  assert.strictEqual(fs.readFileSync(path.join(LOG_DIR, "neighbour.txt"), "utf8"), "keep");
  fs.rmSync(path.join(LOG_DIR, "neighbour.txt"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_WAIT_MS = 2 * 900 + 400; // more than 2x the bridge's POLL_MS (900)

async function waitUntil(fn, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(100);
  }
}

const userLine = (t) =>
  JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "<user_query>" + t + "</user_query>" }] }
  }) + "\n";
const TERMINAL_OK = JSON.stringify({ type: "turn_ended", status: "success" }) + "\n";
const TERMINAL_ERR = JSON.stringify({ type: "turn_ended", status: "error" }) + "\n";
const LEAK_TEXT = PLANTED + " /home/" + PLANTED + "/x C:\\Users\\" + PLANTED + "\\y";

/** Records unhandled rejections for the duration of one test. */
function rejectionRecorder() {
  const list = [];
  const fn = (err) => list.push(err);
  process.on("unhandledRejection", fn);
  return { list, stop: () => process.removeListener("unhandledRejection", fn) };
}

/** fs.promises where every call waits `ms` first. */
function delayedFs(ms) {
  return new Proxy(fs.promises, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args) => sleep(ms).then(() => v.apply(target, args));
    }
  });
}

/**
 * Cursor transcripts must never reach Claude Code mode (the poll guard), Cursor alerts are
 * tagged by source, and lastScanAt keeps moving in Claude Code mode.
 */
async function testCursorIsolation() {
  const S = "11111111-2222-4333-8444-555555555555";
  const dir = path.join(CURSOR_ROOT, "cur-a", "agent-transcripts", S);
  const parentFile = path.join(dir, S + ".jsonl");
  const subFile = path.join(dir, "subagents", PLANTED + "-sub.jsonl");
  const sub2File = path.join(dir, "subagents", PLANTED + "-sub2.jsonl");
  try {
    await withBridge({ claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual((await post(port, "/api/select", { id: "cur-a" })).status, 200);
      fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
      fs.writeFileSync(parentFile, userLine(LEAK_TEXT));
      fs.writeFileSync(subFile, userLine(LEAK_TEXT) + TERMINAL_OK);

      const cursorAlerts = await waitUntil(
        async () => {
          const r = await request(port, { path: "/api/alerts" });
          const j = JSON.parse(r.body);
          return j.alerts.some((a) => a.status === "finished") ? r.body : null;
        },
        10000,
        "a Cursor finished alert"
      );
      const cursorList = JSON.parse(cursorAlerts).alerts;
      assert.deepStrictEqual(Object.keys(cursorList[0]), ["id", "ts", "name", "status", "agentId"]);
      assert.strictEqual(cursorList[0].agentId, PLANTED + "-sub");
      const curEvents = (await request(port, { path: "/api/events" })).body;
      assert.ok(curEvents.includes(PLANTED), "the Cursor poll does ingest this transcript");

      const stream = openStream(port);
      await stream.waitFor("event: hello");
      assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
      await stream.waitFor("event: reset");
      const cut = stream.text().indexOf("event: reset");

      // alerts: the Cursor one is hidden, not deleted
      const hidden = await get(port, "/api/alerts", true);
      assert.deepStrictEqual(hidden.json, { alerts: [] });

      // more Cursor bytes land while Claude Code mode is on, for more than 2x POLL_MS
      const st1 = (await get(port, "/api/status", true)).json;
      fs.appendFileSync(parentFile, userLine(LEAK_TEXT));
      fs.appendFileSync(subFile, userLine(LEAK_TEXT));
      fs.writeFileSync(sub2File, userLine(LEAK_TEXT) + TERMINAL_ERR);
      await sleep(POLL_WAIT_MS);
      const st2 = (await get(port, "/api/status", true)).json;
      const evs = await get(port, "/api/events", true);
      const al = await get(port, "/api/alerts", true);
      assert.deepStrictEqual(al.json, { alerts: [] }, "no Cursor-side alert appears in this mode");
      const tail = stream.text().slice(cut);
      record("SSE isolation tail", tail);
      for (const [label, text] of [
        ["status", JSON.stringify(st2)],
        ["events", JSON.stringify(evs.json)],
        ["stream", tail]
      ]) {
        assert.ok(!text.includes(PLANTED), label + " carries the planted name: " + text);
        assert.ok(!text.includes("/home/"), label + " carries a home path");
        assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path");
      }
      assert.ok(!tail.includes("event: alert"), "no alert frame in Claude Code mode");
      assert.ok(
        evs.json.events.every((e) => e.source === "bridge"),
        "only bridge rows exist: " + JSON.stringify(evs.json.events.map((e) => e.source))
      );

      // the HUD's sync age keeps moving (the poll ticks without reading Cursor files)
      assert.ok(st1.lastScanAt && st2.lastScanAt, "lastScanAt is set");
      assert.ok(
        Date.parse(st2.lastScanAt) > Date.parse(st1.lastScanAt),
        "lastScanAt advances in Claude Code mode: " + st1.lastScanAt + " -> " + st2.lastScanAt
      );
      stream.close();

      // back to Cursor: the same alert list returns, shape unchanged
      await post(port, "/api/source", { source: "cursor" });
      const back = JSON.parse((await request(port, { path: "/api/alerts" })).body);
      assert.deepStrictEqual(back.alerts, cursorList);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** checkStalledAgents is for Cursor only; a Cursor agent tracked before a switch never stalls later. */
async function testStallGate() {
  const { checkStalledAgents, recordHistoryEvent } = require("../live-bridge.js");
  const S = "22222222-3333-4444-8555-666666666666";
  const dir = path.join(CURSOR_ROOT, "cur-b", "agent-transcripts", S);
  const stallFile = path.join(dir, "subagents", PLANTED + "-stall.jsonl");
  try {
    await withBridge({ claudeCode: claudeBag(), stallMs: 300 }, async (port) => {
      assert.strictEqual((await post(port, "/api/select", { id: "cur-b" })).status, 200);
      fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
      fs.writeFileSync(stallFile, userLine("work"));
      await waitUntil(
        async () => {
          const h = (await get(port, "/api/history")).json;
          return h.events.some((e) => e.agentId === PLANTED + "-stall");
        },
        10000,
        "the Cursor agent to be tracked"
      );
      const stream = openStream(port);
      await stream.waitFor("event: hello");
      await post(port, "/api/source", { source: "claude-code" });
      await stream.waitFor("event: reset");
      await sleep(400);
      checkStalledAgents();
      assert.deepStrictEqual((await get(port, "/api/alerts", true)).json, { alerts: [] });

      // back in Cursor, the agent tracked before the switch is gone: it must not stall now
      await post(port, "/api/source", { source: "cursor" });
      await sleep(400);
      checkStalledAgents();
      const cur = (await get(port, "/api/alerts")).json.alerts;
      assert.ok(
        !cur.some((a) => a.status === "stalled"),
        "stale Cursor agent stalled: " + JSON.stringify(cur)
      );

      // an agent that is tracked while Claude Code mode is on is still never reported
      await post(port, "/api/source", { source: "claude-code" });
      recordHistoryEvent({
        ts: new Date().toISOString(),
        sessionId: S,
        agentId: PLANTED + "-seeded",
        parentId: "parent:parent",
        name: "Worker",
        model: "sonnet",
        type: "spawn",
        inputTokens: 1,
        outputTokens: 1,
        files: []
      });
      await sleep(400);
      checkStalledAgents();
      assert.deepStrictEqual((await get(port, "/api/alerts", true)).json, { alerts: [] });
      assert.ok(!stream.text().includes("event: alert"), "no alert frame on the stream");
      stream.close();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** stopBridge -> startBridge starts in Cursor mode with a fresh Claude Code state; selectProject refuses. */
async function testRestartAndSelectProject() {
  const { selectProject } = require("../live-bridge.js");
  let firstId;
  await withBridge({ claudeCode: claudeBag() }, async (port) => {
    const curId = (await get(port, "/api/status")).json.projectId;
    firstId = curId;
    await post(port, "/api/source", { source: "claude-code" });
    const list = (await get(port, "/api/projects")).json;
    const pick = await post(port, "/api/select", { id: list.projects[0].id });
    assert.strictEqual(pick.status, 200);
    assert.strictEqual((await get(port, "/api/status")).json.source, "claude-code");

    // the exported selectProject refuses outside Cursor mode and changes nothing
    const refused = selectProject(curId === "cur-a" ? "cur-b" : "cur-a");
    assert.strictEqual(refused.ok, false);
    await post(port, "/api/source", { source: "cursor" });
    const st = (await get(port, "/api/status")).json;
    assert.strictEqual(st.projectId, curId, "Cursor project unchanged by the refused select");
    assert.ok(st.transcripts.includes(curId));
    await post(port, "/api/source", { source: "claude-code" });
  }); // stopBridge runs here, still in Claude Code mode with a selection

  await withBridge({ claudeCode: claudeBag() }, async (port) => {
    const st = (await get(port, "/api/status")).json;
    assert.strictEqual(st.source, "cursor", "a restart begins in Cursor mode");
    assert.ok(typeof st.transcripts === "string" && st.transcripts.includes(firstId));
    await post(port, "/api/source", { source: "claude-code" });
    const cc = (await get(port, "/api/status")).json;
    assert.strictEqual(cc.projectId, null, "the Claude Code selection does not survive a restart");
    assert.ok(cc.projectCount > 0, "and the mode is rebuilt and discovers again");
  });
}

/** Under BRIDGE_TEST=1 a missing bag, or a missing key, never reaches the real home or wsl.exe. */
async function testInertBag() {
  const inertHome = path.join(SCRATCH, "inert-home");
  writeJsonl(
    path.join(inertHome, ".claude", "projects", "enc-x", "x.jsonl"),
    "/srv/inert-demo",
    Math.floor(Date.now() / 1000) - 100
  );
  const keys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = inertHome;
  process.env.USERPROFILE = inertHome;
  process.env.APPDATA = path.join(inertHome, "AppData");
  process.env.XDG_CONFIG_HOME = path.join(inertHome, ".config");
  try {
    const projectsOf = async (opts) =>
      withBridge(opts, async (port) => {
        await post(port, "/api/source", { source: "claude-code" });
        return (await get(port, "/api/projects")).json.projects;
      });
    assert.deepStrictEqual(await projectsOf({}), [], "no bag: inert");
    assert.deepStrictEqual(await projectsOf({ claudeCode: {} }), [], "empty bag: inert");
    assert.deepStrictEqual(
      await projectsOf({ claudeCode: { platform: "linux" } }),
      [],
      "bag without homedir: inert"
    );
    // wsl.exe is never run: a win32 bag without runWsl gets the blocked runner (a visible note),
    // and an empty bag gets platform "linux" (no WSL step at all)
    const notesOf = (opts) =>
      withBridge(opts, async (port) => {
        await post(port, "/api/source", { source: "claude-code" });
        return (await get(port, "/api/projects")).json.notes.map((n) => n.code);
      });
    assert.ok((await notesOf({ claudeCode: { platform: "win32" } })).includes("wsl-unavailable"));
    assert.ok(!(await notesOf({ claudeCode: {} })).some((c) => c.startsWith("wsl-")));
    // explicit values are kept: the named home is read with the real fs
    const kept = await projectsOf({ claudeCode: { platform: "linux", homedir: inertHome } });
    assert.deepStrictEqual(
      kept.map((p) => p.label),
      ["inert-demo"]
    );
    const counted = countingFs(false);
    const keptFs = await projectsOf({
      claudeCode: { platform: "linux", homedir: inertHome, fs: counted.fs }
    });
    assert.strictEqual(keptFs.length, 1);
    assert.ok(counted.counter.calls > 0, "an explicit fs is used");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** A select that loses a race with a source switch is refused and stores nothing. */
async function testSelectRaceKeepsSelection() {
  let id;
  await withBridge({ claudeCode: claudeBag() }, async (port) => {
    await post(port, "/api/source", { source: "claude-code" });
    const list = (await get(port, "/api/projects")).json.projects;
    id = list.find((p) => p.label === "proj-demo").id;
  });
  await withBridge({ claudeCode: claudeBag({ fs: delayedFs(30), ttlMs: 1 }) }, async (port) => {
    await post(port, "/api/source", { source: "claude-code" });
    const racing = post(port, "/api/select", { id });
    await sleep(5);
    await post(port, "/api/source", { source: "cursor" });
    const res = await racing;
    assert.strictEqual(res.status, 400, "the racing select is refused");
    await post(port, "/api/source", { source: "claude-code" });
    const st = (await get(port, "/api/status")).json;
    assert.strictEqual(st.projectId, null, "the refused select left no selection behind");
    assert.strictEqual(st.projectLabel, null);
  });
}

/** stopBridge while discovery is in flight: no unhandled rejection, and the client is answered or closed. */
async function testStopDuringDiscovery() {
  const { stopBridge } = require("../live-bridge.js");
  const rec = rejectionRecorder();
  try {
    for (const route of ["/api/projects", "/api/status", "/api/events"]) {
      await stopDuringRoute(route, rec);
    }
  } finally {
    rec.stop();
    await stopBridge();
  }
}

async function stopDuringRoute(route, rec) {
  const { startBridge, stopBridge } = require("../live-bridge.js");
  {
    const port = await getFreePort();
    await startBridge({
      port,
      quiet: true,
      projectsRoot: CURSOR_ROOT,
      eventLogDir: LOG_DIR,
      reuseExisting: false,
      claudeCode: claudeBag({ fs: delayedFs(40), ttlMs: 1 })
    });
    await post(port, "/api/source", { source: "claude-code" });
    const pending = request(port, { path: route }).then(
      (r) => ({ answered: true, status: r.status }),
      () => ({ answered: false })
    );
    await sleep(5);
    await stopBridge();
    const out = await Promise.race([pending, sleep(2000).then(() => ({ hung: true }))]);
    assert.ok(!out.hung, route + ": neither answered nor closed within 2000 ms");
    if (out.answered) assert.strictEqual(out.status, 200, route + ": an answer is a normal 200");
    await sleep(400);
    assert.deepStrictEqual(rec.list, [], route + " unhandled rejection: " + rec.list.map(String));
  }
}

/** A throw while building an async Claude Code response becomes a fixed 500, not a hang. */
async function testRouteFailureAnswers500() {
  const { pushEvent, resetWatchState } = require("../live-bridge.js");
  const rec = rejectionRecorder();
  try {
    await withBridge({ claudeCode: claudeBag() }, async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      try {
        // a BigInt cannot be serialised: the events route fails while it builds the body
        pushEvent({ role: "parent", kind: "status", message: "x", tokensDelta: 1n });
      } catch (_e) {
        /* the SSE broadcast may throw too; the event is already stored */
      }
      try {
        const r = await request(port, { path: "/api/events" });
        assert.strictEqual(r.status, 500);
        assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: "Internal error" });
        await sleep(100);
        assert.deepStrictEqual(rec.list, [], "unhandled rejection: " + rec.list.map(String));
      } finally {
        resetWatchState(); // drop the unserialisable event for later tests
      }
    });
  } finally {
    rec.stop();
  }
}

/** The drift sample is Cursor transcript text: Claude Code status must not carry it. */
async function testStatusHidesDriftSample() {
  const S = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const dir = path.join(CURSOR_ROOT, "cur-a", "agent-transcripts", S);
  const SAMPLE = "drift-sample-not-json";
  try {
    await withBridge({ claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual((await post(port, "/api/select", { id: "cur-a" })).status, 200);
      await sleep(POLL_WAIT_MS); // warm-up done: lines that arrive now count as drift
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, S + ".jsonl"), SAMPLE + " {" + String.fromCharCode(10));
      const cursorStatus = await waitUntil(
        async () => {
          const j = (await get(port, "/api/status")).json;
          return j.drift.lastSample ? j : null;
        },
        10000,
        "a drift sample in Cursor mode"
      );
      assert.ok(cursorStatus.drift.lastSample.includes(SAMPLE), "Cursor status shows its sample");
      // the Claude Code status body, called directly while the sample is still set
      const { claudeStatusPayload } = require("../live-bridge.js");
      const stub = {
        selection: () => ({ id: null, label: null }),
        statusBody: async () => ({ source: "claude-code", notes: [] })
      };
      const direct = await claudeStatusPayload(stub);
      assert.ok(direct.drift.unparsed >= 1, "the drift counters are non-zero here");
      assert.strictEqual(direct.drift.lastSample, "");
      assert.ok(!JSON.stringify(direct).includes(SAMPLE));
      assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
      const cc = await get(port, "/api/status", true);
      assert.strictEqual(cc.json.source, "claude-code");
      assert.strictEqual(cc.json.drift.lastSample, "");
      assert.ok(!JSON.stringify(cc.json).includes(SAMPLE));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A second switch to Claude Code is a refresh: it drops the cached discovery. */
async function testRepeatedSwitchRediscovers() {
  const counted = countingFs(false);
  await withBridge({ claudeCode: claudeBag({ fs: counted.fs, ttlMs: 600000 }) }, async (port) => {
    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
    assert.strictEqual((await get(port, "/api/projects", true)).status, 200);
    const afterFirst = counted.counter.calls;
    assert.ok(afterFirst > 0, "the first request discovers");
    await get(port, "/api/projects", true);
    assert.strictEqual(counted.counter.calls, afterFirst, "within the ttl the result is reused");
    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
    assert.strictEqual((await get(port, "/api/projects", true)).status, 200);
    assert.ok(counted.counter.calls > afterFirst, "the second switch triggered a fresh discovery");
  });
}

async function waitForValue(fn, what, ms) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(40);
  }
}

/** A second fake home: proj-new (newest, with a finished child) and proj-old. */
function buildAutoHome() {
  const home = path.join(SCRATCH, "auto-home");
  const proj = path.join(home, ".claude", "projects");
  const base = Math.floor(Date.now() / 1000) - 500;
  const head = (cwd) => JSON.stringify({ type: "user", cwd, sessionId: L.SESSION });
  const newFile = path.join(proj, "enc-new", L.SESSION + ".jsonl");
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.writeFileSync(
    newFile,
    [
      head("/home/" + PLANTED + "/proj-new"),
      L.userTurn("do it"),
      L.assistant([L.agentCall("toolu_1", "worker", "sonnet")]),
      L.agentResult("toolu_1", "agent1"),
      L.notification("toolu_1", "agent1", "completed")
    ].join("\n") + "\n"
  );
  fs.utimesSync(newFile, base + 50, base + 50);
  writeJsonl(path.join(proj, "enc-old", "o.jsonl"), "/home/" + PLANTED + "/proj-old", base + 40);
  return home;
}

/** Claude Code mode with nothing selected picks the newest project, once, and never overrides. */
async function testAutoSelectNewest() {
  const home = buildAutoHome();
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  delete process.env.CURSOR_TRANSCRIPTS;
  const toasts = [];
  try {
    // (a) the bridge starts in Claude Code
    await withBridge(
      {
        dir: undefined,
        onAgentAlert: (a) => toasts.push(a),
        claudeCode: claudeBag({ homedir: home })
      },
      async (port) => {
        const listed = () => get(port, "/api/projects", true).then((r) => r.json);
        const first = (await listed()).projects;
        const newest = first.find((p) => p.label === "proj-new");
        const older = first.find((p) => p.label === "proj-old");
        assert.ok(newest && older, "both projects are listed");
        assert.strictEqual(first[0].id, newest.id, "the picker's first entry is the newest");
        await waitForValue(
          async () => (await get(port, "/api/status", true)).json.projectId === newest.id,
          "auto-selected newest project"
        );
        const st = (await get(port, "/api/status", true)).json;
        assert.strictEqual(st.projectLabel, "proj-new");
        const pl = await listed();
        assert.strictEqual(pl.selectedId, newest.id, "the picker list reports the selection");
        const hello = (await helloOf(port)).json;
        assert.strictEqual(hello.projectId, newest.id, "hello reports the selection");
        assert.strictEqual(hello.projectLabel, "proj-new");

        // the session replays silently: rows marked replay, no alert, no toast
        const done = await waitForValue(async () => {
          const evs = (await get(port, "/api/events", true)).json.events;
          return evs.find((e) => e.type === "done");
        }, "replayed done row");
        assert.strictEqual(done.replay, true, "the first session replays");
        await sleep(300);
        assert.deepStrictEqual((await get(port, "/api/alerts", true)).json.alerts, []);
        assert.deepStrictEqual(toasts, [], "no desktop toast for replayed rows");

        // a later user pick is kept, also across a switch away and back
        const pick = await post(port, "/api/select", { id: older.id }, true);
        assert.strictEqual(pick.status, 200);
        assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
        assert.strictEqual(
          (await post(port, "/api/source", { source: "claude-code" })).status,
          200
        );
        await sleep(300);
        const after = (await get(port, "/api/status", true)).json;
        assert.strictEqual(after.projectId, older.id, "the user's pick is not overridden");
      }
    );

    // (b) a bridge that starts in Cursor and is switched to Claude Code
    await withBridge({ claudeCode: claudeBag({ homedir: home }) }, async (port) => {
      assert.strictEqual((await get(port, "/api/status")).json.source, "cursor");
      assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
      const st = await waitForValue(async () => {
        const j = (await get(port, "/api/status", true)).json;
        return j.projectLabel === "proj-new" ? j : null;
      }, "newest project after the switch");
      const listed = (await get(port, "/api/projects", true)).json;
      assert.strictEqual(listed.selectedId, st.projectId);
      assert.strictEqual(listed.projects[0].id, st.projectId);
    });

    // (c) no projects, and (d) a discovery that fails: nothing selected, no error
    const empty = path.join(SCRATCH, "empty-home");
    fs.mkdirSync(path.join(empty, ".claude", "projects"), { recursive: true });
    const failing = new Proxy({}, { get: () => () => Promise.reject(new Error("blocked")) });
    for (const bag of [claudeBag({ homedir: empty }), claudeBag({ homedir: home, fs: failing })]) {
      await withBridge({ dir: undefined, claudeCode: bag }, async (port) => {
        await sleep(300);
        const st = await get(port, "/api/status", true);
        assert.strictEqual(st.status, 200);
        assert.strictEqual(st.json.projectId, null);
        assert.strictEqual(st.json.ingest, null, "nothing selected: no ingest runs");
        const pl = await get(port, "/api/projects", true);
        assert.strictEqual(pl.status, 200);
        assert.strictEqual(pl.json.selectedId, null);
      });
    }
  } finally {
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
  }
}

/** fs.promises whose FIRST call hangs until release(); every later call passes straight through. */
function gatedFs() {
  let release;
  let onBlocked;
  const hold = new Promise((r) => (release = r));
  const blocked = new Promise((r) => (onBlocked = r));
  let first = true;
  const proxy = new Proxy(fs.promises, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args) => {
        if (first) {
          first = false;
          onBlocked();
          return hold.then(() => v.apply(target, args));
        }
        return v.apply(target, args);
      };
    }
  });
  return { fs: proxy, blocked, release };
}

/** First "event: reset" payload in a stream text, or null. */
function firstReset(text) {
  const m = /event: reset\ndata: (.*)\n\n/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}

/**
 * autoSelectNewestClaude re-checks that it still owns the selection after its (slow) discovery.
 * The first discovery is held open while the world changes; it is then released and must change
 * nothing. (The second re-check, after cc.select returns, cannot be reached: select stores its
 * selection and returns within one microtask, and canApply already refuses a stale caller.)
 */
async function testAutoSelectStaleGuards() {
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  delete process.env.CURSOR_TRANSCRIPTS;
  try {
    // (a) the source is switched to Cursor while discovery is pending
    const a = gatedFs();
    await withBridge(
      { dir: undefined, claudeCode: claudeBag({ fs: a.fs, ttlMs: 1 }) },
      async (port) => {
        await a.blocked;
        const stream = openStream(port);
        try {
          await stream.waitFor("event: hello");
          assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
          await stream.waitFor("event: reset");
          const mark = stream.text().length;
          a.release();
          await sleep(500);
          assert.ok(
            !stream.text().slice(mark).includes("event: reset"),
            "a stale auto-select changed the watch after the switch to Cursor"
          );
          const back = stream.text().length;
          assert.strictEqual(
            (await post(port, "/api/source", { source: "claude-code" })).status,
            200
          );
          await stream.waitFor("event: reset", back);
          const reset = firstReset(stream.text().slice(back));
          assert.strictEqual(reset.source, "claude-code");
          assert.strictEqual(reset.projectId, null, "no selection was stored by the stale run");
        } finally {
          stream.close();
        }
      }
    );

    // (b) the user picks a project while discovery is pending: the pick stays
    const b = gatedFs();
    await withBridge(
      { dir: undefined, claudeCode: claudeBag({ fs: b.fs, ttlMs: 1 }) },
      async (port) => {
        await b.blocked;
        // same source: drops the pending discovery so the next request discovers afresh
        assert.strictEqual(
          (await post(port, "/api/source", { source: "claude-code" })).status,
          200
        );
        const list = (await get(port, "/api/projects", true)).json.projects;
        const newest = list[0];
        const other = list.find((p) => p.label === "other-demo");
        assert.ok(other && other.id !== newest.id, "a non-newest project to pick");
        assert.strictEqual((await post(port, "/api/select", { id: other.id }, true)).status, 200);
        b.release();
        await sleep(500);
        const st = (await get(port, "/api/status", true)).json;
        assert.strictEqual(
          st.projectId,
          other.id,
          "the pending auto-select must not replace a pick"
        );
      }
    );

    // (c) the bridge is stopped and a new one started while discovery is pending
    const { startBridge, stopBridge } = require("../live-bridge.js");
    const empty = path.join(SCRATCH, "empty-home");
    fs.mkdirSync(path.join(empty, ".claude", "projects"), { recursive: true });
    const c = gatedFs();
    const first = await getFreePort();
    await startBridge({
      port: first,
      quiet: true,
      projectsRoot: CURSOR_ROOT,
      eventLogDir: LOG_DIR,
      reuseExisting: false,
      claudeCode: claudeBag({ fs: c.fs, ttlMs: 1 })
    });
    await c.blocked;
    await stopBridge();
    await withBridge(
      { dir: undefined, claudeCode: claudeBag({ homedir: empty }) },
      async (port) => {
        const stream = openStream(port);
        try {
          await stream.waitFor("event: hello");
          await sleep(200);
          const mark = stream.text().length;
          c.release();
          await sleep(500);
          assert.ok(
            !stream.text().slice(mark).includes("event: reset"),
            "the old bridge's auto-select reached the new bridge"
          );
          assert.strictEqual((await get(port, "/api/status", true)).json.projectId, null);
        } finally {
          stream.close();
        }
      }
    );
  } finally {
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
  }
}

/** Claude Code mode watches no Cursor tree at startup: no inventory walk of the Cursor folder. */
async function testNoCursorSnapshotInClaudeStart() {
  const sub = path.join(CURSOR_ROOT, "cur-b", "agent-transcripts", "zz-snap-sub");
  fs.mkdirSync(sub, { recursive: true });
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  delete process.env.CURSOR_TRANSCRIPTS;
  const realReaddir = fs.readdirSync;
  let walked = 0;
  fs.readdirSync = function (p, ...rest) {
    if (String(p).endsWith("zz-snap-sub")) walked++;
    return realReaddir.call(this, p, ...rest);
  };
  try {
    await withBridge({ dir: undefined, claudeCode: claudeBag() }, async (port) => {
      assert.strictEqual((await get(port, "/api/status")).json.source, "claude-code");
      await sleep(200);
    });
    assert.strictEqual(walked, 0, "Claude Code start does not inventory the Cursor folder");
    await withBridge(
      { dir: path.join(CURSOR_ROOT, "cur-b", "agent-transcripts"), claudeCode: claudeBag() },
      async (port) => {
        assert.strictEqual((await get(port, "/api/status")).json.source, "cursor");
      }
    );
    assert.ok(walked > 0, "control: a Cursor start does inventory it (the spy sees the walk)");
  } finally {
    fs.readdirSync = realReaddir;
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
    fs.rmSync(sub, { recursive: true, force: true });
  }
}

/** A request already in flight on a kept-alive socket when the bridge stops. */
async function testRequestAfterStop() {
  const { startBridge, stopBridge } = require("../live-bridge.js");
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: CURSOR_ROOT,
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    claudeCode: claudeBag()
  });
  const sock = net.connect(port, "127.0.0.1");
  let reply = "";
  sock.on("data", (d) => (reply += d));
  sock.on("error", () => {});
  await new Promise((r) => sock.once("connect", r));
  sock.write("GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n");
  await sleep(100);
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    await stopBridge();
    sock.write("\r\n");
    await sleep(300);
  } finally {
    process.off("uncaughtException", onUncaught);
    sock.destroy();
  }
  assert.deepStrictEqual(uncaught, [], "a late request must not throw inside the server");
  assert.ok(reply.startsWith("HTTP/1.1 503"), "answered 503, got: " + reply.slice(0, 40));
  assert.ok(reply.includes("Bridge stopped"), "body is Bridge stopped, got: " + reply.slice(-60));
}

/**
 * autoSelectNewestClaude re-checks the bridge after `await cc.select(...)`. select stores its
 * selection and returns in one step, so only a microtask can run between the store and the
 * continuation, and an HTTP request cannot. stopBridge and startBridge both change their state
 * before their first await, so a restart can land in that gap. Armed once discovery is held
 * open, the spy on the stored project lookup queues the restart in that gap. The stale
 * continuation must not reset or tail the new bridge: its event list never gains the "choose a
 * Claude Code project" status that resetClaudeWatch would push. (A switch to Cursor cannot land
 * in the gap: setSource only runs from an HTTP handler.)
 */
async function testAutoSelectRestartInSelectGap() {
  const { startBridge, stopBridge } = require("../live-bridge.js");
  const savedEnv = process.env.CURSOR_TRANSCRIPTS;
  delete process.env.CURSOR_TRANSCRIPTS;
  const empty = path.join(SCRATCH, "empty-home-gap");
  fs.mkdirSync(path.join(empty, ".claude", "projects"), { recursive: true });
  const held = gatedFs();
  const second = await getFreePort();
  const realGet = Map.prototype.get;
  let armed = false;
  let restarted = null;
  Map.prototype.get = function (k) {
    const v = realGet.call(this, k);
    if (armed && !restarted && v && typeof v === "object" && v.path && v.label) {
      restarted = true; // the lookup inside cc.select: the continuation is queued after this
      queueMicrotask(() => {
        void stopBridge();
        restarted = startBridge({
          port: second,
          quiet: true,
          projectsRoot: CURSOR_ROOT,
          eventLogDir: LOG_DIR,
          reuseExisting: false,
          claudeCode: claudeBag({ homedir: empty })
        });
      });
    }
    return v;
  };
  const first = await getFreePort();
  try {
    await startBridge({
      port: first,
      quiet: true,
      projectsRoot: CURSOR_ROOT,
      eventLogDir: LOG_DIR,
      reuseExisting: false,
      claudeCode: claudeBag({ fs: held.fs, ttlMs: 1 })
    });
    await held.blocked;
    armed = true;
    held.release();
    for (let i = 0; i < 100 && !(restarted && restarted.then); i++) await sleep(10);
    assert.ok(restarted && restarted.then, "the restart did not land in the select gap");
    await restarted;
    await sleep(300);
    const evs = JSON.stringify((await get(second, "/api/events")).json);
    assert.ok(
      !evs.includes("choose a Claude Code project"),
      "the old auto-select reset the new bridge: " + evs.slice(0, 200)
    );
    assert.strictEqual((await get(second, "/api/status", true)).json.projectId, null);
  } finally {
    Map.prototype.get = realGet;
    await stopBridge();
    if (savedEnv === undefined) delete process.env.CURSOR_TRANSCRIPTS;
    else process.env.CURSOR_TRANSCRIPTS = savedEnv;
  }
}

async function main() {
  buildTrees();
  try {
    await testDefaultSource();
    await testAutoSelectNewest();
    await testAutoSelectStaleGuards();
    await testAutoSelectRestartInSelectGap();
    await testNoCursorSnapshotInClaudeStart();
    await testRequestAfterStop();
    await testSwitching();
    await testHelloSource();
    await testExplicitDirFlag();
    await testCursorResetNamesSource();
    await testTimeout();
    testSaltLoadOptions();
    testSaltGuard();
    await testSalt();
    await testBridgeTestSaltIsolation();
    await testBridgeTestSaltIsRandom();
    await testCursorIsolation();
    await testStallGate();
    await testRestartAndSelectProject();
    await testInertBag();
    await testSelectRaceKeepsSelection();
    await testStopDuringDiscovery();
    await testRouteFailureAnswers500();
    await testStatusHidesDriftSample();
    await testRepeatedSwitchRediscovers();
    // every Claude Code body and stream chunk, checked together
    assert.ok(seen.length >= 10, "expected many recorded bodies, got " + seen.length);
    for (const { label, text } of seen) {
      assert.ok(!FORBIDDEN.test(text), label + " leaks a path or planted name: " + text);
      assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path: " + text);
      assert.ok(!text.includes(PLANTED), label + " carries the planted name");
    }
    console.log(
      "claude-code-bridge OK · switch, hello source, select, guards, privacy, salt, timeout, isolation, alerts, restart, stop race"
    );
  } finally {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
