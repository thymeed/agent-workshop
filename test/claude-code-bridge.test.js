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

const PLANTED = "zqplanted";
const SCRATCH = path.join(__dirname, "..", ".scratch", "u4-cc-bridge");
const HOME = path.join(SCRATCH, "home");
const CURSOR_ROOT = path.join(SCRATCH, "cursor-projects");
const LOG_DIR = path.join(SCRATCH, "app-data");
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
    async waitFor(needle) {
      for (let i = 0; i < 100; i++) {
        if (text.includes(needle)) return;
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
    assert.strictEqual(counted.counter.calls, 0, "switching alone does not scan");

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

async function testSalt() {
  // unreadable app-data folder (a file stands where the folder should be)
  const badDir = path.join(SCRATCH, "not-a-folder");
  fs.writeFileSync(badDir, "x");
  await withBridge({ eventLogDir: badDir, claudeCode: claudeBag() }, async (port) => {
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
    withBridge({ claudeCode: claudeBag() }, async (port) => {
      await post(port, "/api/source", { source: "claude-code" });
      return listing(port);
    });
  const first = await run();
  assert.ok(
    fs.existsSync(path.join(LOG_DIR, "label-salt.bin")),
    "salt file is in the app-data dir"
  );
  const second = await run();
  assert.ok(!first.notes.some((n) => n.code === "labels-unstable"));
  assert.deepStrictEqual(second.ids, first.ids, "ids and labels survive a restart");
  assert.strictEqual(first.ids.length, 3);
}

async function main() {
  buildTrees();
  try {
    await testSwitching();
    await testTimeout();
    await testSalt();
    // every Claude Code body and stream chunk, checked together
    assert.ok(seen.length >= 10, "expected many recorded bodies, got " + seen.length);
    for (const { label, text } of seen) {
      assert.ok(!FORBIDDEN.test(text), label + " leaks a path or planted name: " + text);
      assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path: " + text);
      assert.ok(!text.includes(PLANTED), label + " carries the planted name");
    }
    console.log("claude-code-bridge OK · switch, select, guards, privacy, salt, timeout");
  } finally {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
