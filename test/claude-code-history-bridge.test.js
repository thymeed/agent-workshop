/**
 * Older Claude Code sessions through the REAL bridge: GET /api/claude/sessions and
 * GET /api/claude/session?id=. A planted project (fake home, platform "linux") is selected; every
 * body is checked against the shared privacy patterns and the planted paths and prompt text, the
 * planted files keep their bytes and mtime, the Cursor event log is untouched, and the routes
 * answer 409 outside Claude Code mode or with no selection, 400 for an unknown id or anything a
 * client sends that is not an opaque id. Everything lives under the worktree's gitignored
 * .scratch/ (never system temp).
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
const SCRATCH = path.join(__dirname, "..", ".scratch", "history-bridge");
const HOME = path.join(SCRATCH, "home");
const EMPTY_HOME = path.join(SCRATCH, "empty-home");
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
const SESSION_NEW = "aaaaaaaa-1111-4222-8333-444444444444";
const SESSION_OLD = "bbbbbbbb-1111-4222-8333-444444444444";
const SESSION_STALE = "cccccccc-1111-4222-8333-444444444444";
const DAY = 24 * 60 * 60 * 1000;

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
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Every body seen, checked for paths and planted text at the end. */
const seen = [];
const get = async (port, p, headers) => {
  const res = await request(port, { path: p, headers });
  seen.push({ label: "GET " + p, text: res.body });
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch (_e) {
    /* a plain-text refusal */
  }
  return { status: res.status, json, text: res.body };
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

async function waitFor(fn, what, ms) {
  const deadline = Date.now() + (ms || 15000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const logSnapshot = () =>
  fs
    .readdirSync(LOG_DIR)
    .filter((f) => f !== "label-salt.bin")
    .sort()
    .map((f) => f + ":" + fs.readFileSync(path.join(LOG_DIR, f), "utf8"))
    .join("|");

/** Bytes and mtime of every file under a folder. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([e.name, fs.readFileSync(p, "utf8"), fs.statSync(p).mtimeMs]);
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

/** A session with a delegation to an Explore child that has its own file and meta. */
function plantFamily(name, ageMs) {
  const sid = name;
  const file = path.join(PROJECT_DIR, name + ".jsonl");
  const lines = [
    JSON.stringify({ type: "user", cwd: "/home/" + PLANTED + "/proj-demo", sessionId: sid }),
    L.userTurn("please do " + PROMPT, sid),
    L.assistant([L.toolUse("toolu_r", "Read", { file_path: SECRET_FILE })], { sessionId: sid }),
    L.assistant([L.agentCall("toolu_1", "Explore", "haiku", { prompt: PROMPT })], {
      sessionId: sid
    }),
    L.agentResult("toolu_1", "agent1", sid),
    L.notification("toolu_1", "agent1", "completed", sid)
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const sub = path.join(PROJECT_DIR, name, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const childLine = (o) =>
    JSON.stringify({ isSidechain: true, agentId: "agent1", sessionId: sid, ...o });
  fs.writeFileSync(
    path.join(sub, "agent-agent1.jsonl"),
    [
      childLine({
        type: "user",
        message: { role: "user", content: "go " + PROMPT },
        timestamp: "2026-01-02T03:04:07.500Z"
      }),
      childLine({
        type: "assistant",
        timestamp: "2026-01-02T03:04:08.500Z",
        parentUuid: "p1",
        message: {
          id: "msg_child",
          model: "claude-haiku-5-5",
          content: [L.toolUse("toolu_c", "Read", { file_path: SECRET_FILE })],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      })
    ].join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(sub, "agent-agent1.meta.json"),
    JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1" })
  );
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.mkdirSync(path.join(EMPTY_HOME, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(CURSOR_ROOT, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  plantFamily(SESSION_NEW, 60 * 1000);
  plantFamily(SESSION_OLD, 3 * DAY);
  plantFamily(SESSION_STALE, 30 * DAY); // older than 14 days: never offered

  const { startBridge, stopBridge } = require("../live-bridge.js");
  const sessionsBefore = snapshot(PROJECT_DIR);

  // ---- no project selected, and Cursor mode: path-free 409 ----
  let port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: CURSOR_ROOT,
    dir: path.join(CURSOR_ROOT, "cur-x", "agent-transcripts"),
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: EMPTY_HOME }
  });
  try {
    for (const p of ["/api/claude/sessions", "/api/claude/session?id=cs-" + "0".repeat(24)]) {
      const r = await get(port, p);
      assert.strictEqual(r.status, 409, "Cursor mode: " + p);
      assert.strictEqual(r.json.ok, false);
    }
    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);
    for (const p of ["/api/claude/sessions", "/api/claude/session?id=cs-" + "0".repeat(24)]) {
      const r = await get(port, p);
      assert.strictEqual(r.status, 409, "no selection: " + p);
      assert.deepStrictEqual(r.json, { ok: false, error: "No project selected" });
    }
  } finally {
    await stopBridge();
  }

  // ---- a planted project, selected ----
  port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: CURSOR_ROOT,
    eventLogDir: LOG_DIR,
    reuseExisting: false,
    claudeCode: { platform: "linux", homedir: HOME }
  });
  try {
    const logBefore = logSnapshot();
    await waitFor(async () => (await get(port, "/api/projects")).json.selectedId, "auto-selection");
    // the live stream and the stored selection, before any history call
    const eventsBefore = (await get(port, "/api/events")).text;
    const selectedBefore = (await get(port, "/api/projects")).json.selectedId;

    const list = await get(port, "/api/claude/sessions");
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.ok, true);
    assert.strictEqual(list.json.sessions.length, 2, "the 30-day-old session is not offered");
    const [first, second] = list.json.sessions;
    assert.ok(Date.parse(first.lastAt) > Date.parse(second.lastAt), "newest first");
    assert.ok(first.startedAt, "start time");
    assert.strictEqual(first.subagents, 1);
    assert.strictEqual(first.events, null);
    for (const s of list.json.sessions) assert.match(s.id, /^cs-[0-9a-f]{24}$/);
    for (const name of [SESSION_NEW, SESSION_OLD, SESSION_STALE, "enc-a", ".jsonl"]) {
      assert.ok(!list.text.includes(name), "the list carries no name: " + name);
    }

    const one = await get(port, "/api/claude/session?id=" + first.id);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.id, first.id);
    assert.strictEqual(one.json.truncated, false);
    assert.ok(one.json.events.length >= 6);
    assert.ok(one.json.events.every((e) => e.replay === true));
    const read = one.json.events.find((e) => e.activity && e.activity.kind === "read");
    assert.strictEqual(read.activity.path, "zqsecretfile.js");
    assert.ok(one.json.events.some((e) => e.source === "subagent:1"));
    assert.deepStrictEqual(
      one.json.agents.map((a) => [a.key, a.parentToolUseId]),
      [["subagent:1", "toolu_1"]]
    );
    assert.strictEqual((await get(port, "/api/claude/session?id=" + second.id)).status, 200);
    assert.strictEqual(
      (await get(port, "/api/events")).text,
      eventsBefore,
      "listing and loading history leaves the live events untouched"
    );
    assert.strictEqual(
      (await get(port, "/api/projects")).json.selectedId,
      selectedBefore,
      "and the selected project"
    );

    // ---- refusals ----
    const bad = [
      "id=cs-" + "0".repeat(24), // well formed, not listed
      "id=" + SESSION_NEW,
      "id=" + SESSION_NEW + ".jsonl",
      "id=" + encodeURIComponent(path.join(PROJECT_DIR, SESSION_NEW + ".jsonl")),
      "id=" + encodeURIComponent("../" + SESSION_NEW),
      "id=" + encodeURIComponent(SESSION_STALE),
      "id=",
      "id=" + first.id + "&path=" + encodeURIComponent(PROJECT_DIR),
      "id=" + first.id + "&file=" + SESSION_OLD + ".jsonl",
      "id=" + first.id + "&id=" + second.id,
      "path=" + encodeURIComponent(PROJECT_DIR),
      "file=" + SESSION_NEW + ".jsonl",
      ""
    ];
    for (const q of bad) {
      const r = await get(port, "/api/claude/session" + (q ? "?" + q : ""));
      assert.strictEqual(r.status, 400, "refused: " + q);
      assert.deepStrictEqual(r.json, { ok: false, error: "Unknown session" });
    }
    assert.strictEqual(
      (await request(port, { method: "POST", path: "/api/claude/sessions", headers: HEADERS }))
        .status,
      405
    );
    assert.strictEqual(
      (
        await request(port, {
          method: "POST",
          path: "/api/claude/session?id=" + first.id,
          headers: HEADERS
        })
      ).status,
      405
    );
    // loopback guards: a foreign Host or Origin never reaches the route
    assert.strictEqual(
      (await get(port, "/api/claude/sessions", { Host: "evil.example" })).status,
      403
    );
    assert.strictEqual(
      (await get(port, "/api/claude/sessions", { Origin: "http://evil.example" })).status,
      403
    );
    const cors = await request(port, {
      path: "/api/claude/sessions",
      headers: { Origin: "http://127.0.0.1:" + port }
    });
    assert.ok(!("access-control-allow-origin" in (cors.headers || {})));

    // ---- leaving Claude Code mode ----
    assert.strictEqual((await post(port, "/api/source", { source: "cursor" })).status, 200);
    assert.strictEqual((await get(port, "/api/claude/sessions")).status, 409);
    assert.strictEqual((await get(port, "/api/claude/session?id=" + first.id)).status, 409);

    // ---- nothing written, nothing leaked ----
    assert.strictEqual(logSnapshot(), logBefore, "the Cursor event log is untouched");
    assert.strictEqual(snapshot(PROJECT_DIR), sessionsBefore, "planted files: bytes and mtime");
    assert.ok(seen.length >= 25, "many bodies recorded: " + seen.length);
    for (const { label, text } of seen) {
      assert.ok(!FORBIDDEN.test(text), label + " leaks: " + JSON.stringify(FORBIDDEN.exec(text)));
      assert.ok(!DRIVE_PATH.test(text), label + " carries a drive path");
      assert.ok(!text.includes(PLANTED) && !text.includes(PROMPT), label + " carries planted text");
    }
    console.log(
      "claude-code-history-bridge OK · list, load, refusals, 409 outside the mode, read-only, privacy"
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
