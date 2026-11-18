/**
 * Claude Code session rows through the REAL bridge: a planted project is selected, its
 * transcript rows reach /api/events and the SSE stream, the replay never alerts, a live finish
 * does, a newer session clears and replays, the Cursor event log is never touched, and every
 * body stays free of the planted paths and prompt text. Everything lives under the worktree's
 * gitignored .scratch/ (never system temp); discovery runs on a fake home with platform
 * "linux", so wsl.exe and the real home are never touched.
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
const PROMPT = "zqprompttoken";
const SCRATCH = path.join(__dirname, "..", ".scratch", "u6b-wire-bridge");
const HOME = path.join(SCRATCH, "home");
const CURSOR_ROOT = path.join(SCRATCH, "cursor-projects");
const LOG_DIR = path.join(SCRATCH, "app-data");
const PROJECT_DIR = path.join(HOME, ".claude", "projects", "enc-a");
const HEADERS = {
  "Content-Type": "application/json",
  "Sec-Fetch-Site": "same-origin",
  "X-Cursor-Bridge": "1"
};
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);
const FORBIDDEN = buildForbidden(
  [PLANTED, PROMPT, HOME, SCRATCH, jsonEsc(HOME), jsonEsc(SCRATCH), "/home/"].filter(Boolean)
);
const DRIVE_PATH = /[A-Za-z]:(\\|\/)/;
const SECRET_FILE = "/home/" + PLANTED + "/proj-demo/zqsecretfile.js";
const SESSION_2 = "99999999-8888-4777-8666-555555555555";

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

/** Every body and stream chunk seen in Claude Code mode, checked for paths at the end. */
const seen = [];
const get = async (port, p) => {
  const res = await request(port, { path: p });
  seen.push({ label: "GET " + p, text: res.body });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
};
const post = async (port, p, body) => {
  const res = await request(port, {
    method: "POST",
    path: p,
    headers: HEADERS,
    body: JSON.stringify(body)
  });
  seen.push({ label: "POST " + p, text: res.body });
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
};

function openStream(port) {
  let text = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" });
  req.on("response", (res) => res.on("data", (d) => (text += d)));
  req.on("error", () => {});
  return { text: () => text, close: () => req.destroy() };
}

async function waitFor(fn, what, ms) {
  const deadline = Date.now() + (ms || 15000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = async (port) => (await get(port, "/api/events")).json.events;
const alertsOf = async (port) => (await get(port, "/api/alerts")).json.alerts;
const logSnapshot = () =>
  fs
    .readdirSync(LOG_DIR)
    .filter((f) => f !== "label-salt.bin")
    .sort()
    .map((f) => f + ":" + fs.readFileSync(path.join(LOG_DIR, f), "utf8"))
    .join("|");

/** Parent session: discovery line, a Read of a planted path, a done Explore child (the replay). */
function firstSession() {
  const lines = [
    JSON.stringify({ type: "user", cwd: "/home/" + PLANTED + "/proj-demo", sessionId: L.SESSION }),
    L.userTurn("please do " + PROMPT),
    L.assistant([L.toolUse("toolu_r", "Read", { file_path: SECRET_FILE })], {
      usage: { input_tokens: 100, output_tokens: 50 }
    }),
    L.assistant([L.agentCall("toolu_1", "Explore", "haiku", { prompt: PROMPT })]),
    L.agentResult("toolu_1", "agent1"),
    L.notification("toolu_1", "agent1", "completed")
  ];
  // enough extra lines that the first catch-up needs several capped polls
  const filler = "x".repeat(200);
  for (let i = 0; i < 9000; i++) {
    lines.splice(
      2,
      0,
      L.assistant([{ type: "text", text: filler }], {
        id: "fill_" + i,
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.mkdirSync(CURSOR_ROOT, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const session1 = path.join(PROJECT_DIR, L.SESSION + ".jsonl");
  const first = firstSession();
  assert.ok(
    Buffer.byteLength(first) > 2 * 256 * 1024,
    "the first session needs several capped polls"
  );
  fs.writeFileSync(session1, first);

  const { startBridge, stopBridge } = require("../live-bridge.js");
  const toasts = [];
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: CURSOR_ROOT,
    // a named Cursor folder starts Cursor; the switch below then moves to Claude Code, which
    // auto-selects the newest project (the only one here); the explicit select below repeats it
    dir: path.join(CURSOR_ROOT, "cur-x", "agent-transcripts"),
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    onAgentAlert: (a) => toasts.push(a),
    claudeCode: { platform: "linux", homedir: HOME }
  });
  try {
    const logBefore = logSnapshot();
    const stream = openStream(port);
    await waitFor(() => stream.text().includes("event: hello"), "hello");

    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
    const projects = (await get(port, "/api/projects")).json.projects;
    const proj = projects.find((p) => p.label === "proj-demo");
    assert.ok(proj, "the planted project is listed");

    // ---- select: the whole session replays, nothing alerts or toasts ----
    assert.strictEqual((await post(port, "/api/select", { id: proj.id })).status, 200);
    await waitFor(
      async () => (await events(port)).some((e) => e.type === "done"),
      "the replayed done row",
      6000 // about a dozen capped polls: one scan must run them back to back, not one per tick
    );
    const evs = await events(port);
    const done = evs.find((e) => e.type === "done");
    assert.strictEqual(done.agentId, "agent1");
    assert.strictEqual(done.toolUseId, "toolu_1");
    assert.strictEqual(done.statusKnown, true);
    assert.strictEqual(done.subagentTokens, 1234);
    assert.strictEqual(done.toolUses, 7);
    assert.strictEqual(done.durationMs, 4500);
    assert.strictEqual(done.role, "explorer", "Explore on haiku is the explorer slot");
    const read = evs.find((e) => e.activity && e.activity.kind === "read");
    assert.ok(read, "the Read row arrived");
    assert.strictEqual(read.message, "read · zqsecretfile.js");
    assert.strictEqual(read.activity.path, "zqsecretfile.js");
    assert.ok(
      evs.some((e) => e.usage && e.usage.in === 100 && e.usage.out === 50),
      "usage tokens"
    );
    const delegate = evs.find((e) => e.kind === "delegates");
    assert.strictEqual(delegate.childRole, "explorer");
    assert.strictEqual(delegate.routeTo, "explorer");
    const ids = evs.map((e) => e.id);
    assert.deepStrictEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      "ids ascend"
    );
    const st1 = (await get(port, "/api/status")).json;
    assert.ok(st1.ingest.rows >= 9000, "all capped polls ran: " + st1.ingest.rows);
    assert.strictEqual(st1.ingest.more, false);
    assert.strictEqual(st1.ingest.sessions, 1);
    assert.strictEqual(st1.drift.unparsed, 0);
    assert.strictEqual(st1.models.opus, "claude-opus-5-5");
    assert.strictEqual((await alertsOf(port)).length, 0, "the replay raised no alert");
    assert.strictEqual(toasts.length, 0, "the replay raised no toast");
    assert.ok(!stream.text().includes("event: alert"), "no alert on the stream during replay");
    assert.ok(stream.text().includes("event: models"), "the model map was published");

    // selecting the same project again replays again, still silently
    assert.strictEqual((await post(port, "/api/select", { id: proj.id })).status, 200);
    await waitFor(
      async () => (await events(port)).some((e) => e.type === "done"),
      "the second replay"
    );
    await sleep(1200);
    assert.strictEqual((await alertsOf(port)).length, 0, "a repeat select raised no alert");
    assert.strictEqual(toasts.length, 0);

    // ---- live: a new finish alerts once, with the role label ----
    fs.appendFileSync(
      session1,
      [
        L.assistant([L.agentCall("toolu_2", "worker", "sonnet")]),
        L.agentResult("toolu_2", "agent2"),
        L.notification("toolu_2", "agent2", "completed")
      ].join("\n") + "\n"
    );
    await waitFor(async () => (await alertsOf(port)).length === 1, "the live alert");
    const [alert] = await alertsOf(port);
    assert.strictEqual(alert.name, "Worker");
    assert.strictEqual(alert.status, "finished");
    assert.strictEqual(alert.agentId, "agent2");
    assert.deepStrictEqual(toasts, [{ name: "Worker", status: "finished" }]);
    assert.ok(stream.text().includes("event: alert"));
    await sleep(1200);
    assert.strictEqual((await alertsOf(port)).length, 1, "one alert, not one per poll");

    // a live error alerts too
    fs.appendFileSync(
      session1,
      [
        L.assistant([L.agentCall("toolu_3", "reviewer", "opus")]),
        L.notification("toolu_3", "agent3", "failed")
      ].join("\n") + "\n"
    );
    await waitFor(async () => (await alertsOf(port)).length === 2, "the live error alert");
    assert.deepStrictEqual((await alertsOf(port))[1].status, "error");
    assert.strictEqual((await alertsOf(port))[1].name, "Reviewer");

    // ---- a newer session clears and replays; its finished child is a replay, so no alert ----
    const resetsBefore = (stream.text().match(/event: reset/g) || []).length;
    const session2 = path.join(PROJECT_DIR, SESSION_2 + ".jsonl");
    fs.writeFileSync(
      session2,
      [
        L.userTurn("another " + PROMPT, SESSION_2),
        L.assistant([L.agentCall("toolu_9", "planner", "opus")], { sessionId: SESSION_2 }),
        L.notification("toolu_9", "agent9", "completed", SESSION_2)
      ].join("\n") + "\n"
    );
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(session2, later, later);
    await waitFor(
      () => (stream.text().match(/event: reset/g) || []).length > resetsBefore,
      "the reset for the new session"
    );
    await waitFor(
      async () => (await events(port)).some((e) => e.toolUseId === "toolu_9" && e.type === "done"),
      "session 2 rows"
    );
    const evs2 = await events(port);
    assert.ok(
      !evs2.some((e) => e.toolUseId === "toolu_1" || (e.message || "").includes("zqsecretfile")),
      "session 1 rows are gone"
    );
    assert.strictEqual(evs2.filter((e) => e.type === "done").length, 1, "counts did not double up");
    await sleep(1200);
    assert.strictEqual(
      (await alertsOf(port)).length,
      2,
      "the new session's replay raised no alert"
    );
    assert.strictEqual(toasts.length, 2);
    assert.strictEqual((await get(port, "/api/status")).json.ingest.sessions, 2);
    const resetBody = stream.text().slice(stream.text().lastIndexOf("event: reset"));
    assert.ok(
      resetBody.includes('"source":"claude-code"') &&
        resetBody.includes('"projectLabel":"proj-demo"')
    );

    // ---- History and the Cursor log stay untouched ----
    assert.strictEqual(logSnapshot(), logBefore, "the Cursor event log was not touched");
    const hist = (await get(port, "/api/history")).json;
    assert.deepStrictEqual(hist.events, []);

    // a stream that connects now gets a path-free hello that carries the model map
    const late = openStream(port);
    await waitFor(() => late.text().includes("event: hello"), "late hello");
    assert.ok(late.text().includes('"models":{'), "hello carries the models");
    seen.push({ label: "SSE late", text: late.text() });
    late.close();
    const claudeSse = stream.text().slice(stream.text().indexOf("event: reset"));

    // ---- leaving Claude Code drops the tail ----
    assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
    fs.appendFileSync(session2, L.userTurn("late " + PROMPT, SESSION_2) + "\n");
    await sleep(2000);
    assert.ok(
      !JSON.parse((await request(port, { path: "/api/events" })).body).events.some(
        (e) => e.message === "task / turn"
      ),
      "no Claude Code row in Cursor mode"
    );
    assert.strictEqual(logSnapshot(), logBefore, "the Cursor event log is still untouched");
    stream.close();

    // ---- every body and chunk ----
    seen.push({ label: "SSE", text: claudeSse });
    assert.ok(seen.length >= 20, "many bodies recorded: " + seen.length);
    for (const { label, text } of seen) {
      assert.ok(!FORBIDDEN.test(text), label + " leaks: " + JSON.stringify(FORBIDDEN.exec(text)));
      assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path");
      assert.ok(!text.includes(PLANTED) && !text.includes(PROMPT), label + " carries planted text");
    }
    console.log(
      "claude-code-wire-bridge OK · replay, live alert, new session, history untouched, privacy"
    );
  } finally {
    await stopBridge();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
