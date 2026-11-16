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

async function main() {
  buildTrees();
  try {
    await testSwitching();
    await testTimeout();
    await testSalt();
    await testCursorIsolation();
    await testStallGate();
    await testRestartAndSelectProject();
    await testInertBag();
    await testSelectRaceKeepsSelection();
    await testStopDuringDiscovery();
    await testRouteFailureAnswers500();
    // every Claude Code body and stream chunk, checked together
    assert.ok(seen.length >= 10, "expected many recorded bodies, got " + seen.length);
    for (const { label, text } of seen) {
      assert.ok(!FORBIDDEN.test(text), label + " leaks a path or planted name: " + text);
      assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path: " + text);
      assert.ok(!text.includes(PLANTED), label + " carries the planted name");
    }
    console.log(
      "claude-code-bridge OK · switch, select, guards, privacy, salt, timeout, isolation, alerts, restart, stop race"
    );
  } finally {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
