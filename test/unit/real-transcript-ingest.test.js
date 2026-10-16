/**
 * End-to-end ingest of real-shaped transcripts through the actual bridge.
 *
 * The unit tests prove the parsers classify a real line. This proves the bridge reacts:
 * a `{"type":"turn_ended"}` line becomes a persisted done/error row, a finished subagent
 * reaches the alert ring, a parent turn end stays quiet, and a line this build cannot read
 * is reported as drift instead of vanishing.
 *
 * Files are written AFTER the bridge starts, because history ingest deliberately records
 * only bytes the bridge saw arrive; a pre-existing file is warmed, not back-filled.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { startBridgeForSmoke, stopBridgeForSmoke } = require("../bridge-smoke-harness.js");

const REAL = path.join(__dirname, "..", "fixtures", "transcripts", "real");
const SOURCE_SESSION = "7f3a1c2e-9b4d-4a61-8e05-3c2d1f4b6a90";
const SESSION = "11111111-2222-4333-8444-555555555555";
const WORKER_UUID = "b81d4f60-2c37-4e59-9a1b-7d3e5f8c0a24";
const EXPLORER_UUID = "c92e5a71-3d48-4f60-ab2c-8e4f6a9d1b35";

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout on " + pathname));
    });
    req.on("error", reject);
  });
}

/** Poll until fn() returns something truthy, or give up and return the last value. */
async function waitFor(fn, ms) {
  const deadline = Date.now() + (ms || 8000);
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last;
}

/** Lay the real fixtures down under this test's session id. */
function writeRealSession(transcriptsDir) {
  const sessionDir = path.join(transcriptsDir, SESSION);
  fs.mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
  fs.copyFileSync(
    path.join(REAL, SOURCE_SESSION, SOURCE_SESSION + ".jsonl"),
    path.join(sessionDir, SESSION + ".jsonl")
  );
  for (const uuid of [WORKER_UUID, EXPLORER_UUID]) {
    fs.copyFileSync(
      path.join(REAL, SOURCE_SESSION, "subagents", uuid + ".jsonl"),
      path.join(sessionDir, "subagents", uuid + ".jsonl")
    );
  }
  return sessionDir;
}

test("real terminal lines become done rows and finish alerts", async () => {
  const info = await startBridgeForSmoke();
  try {
    writeRealSession(info.transcriptsDir);

    const events = await waitFor(async () => {
      const body = await get(info.port, "/api/history");
      const rows = body.events || [];
      return rows.filter((row) => row.type === "done").length >= 3 ? rows : null;
    });
    assert.ok(events, "expected done rows for the parent and both subagents");
    assert.ok(
      events.every((row) => row.sessionId === SESSION),
      "history must be scoped to this session"
    );

    const byAgent = new Map(events.map((row) => [row.agentId, row]));
    const parent = byAgent.get("parent:parent");
    assert.ok(parent, "the parent turn end must persist a row");
    assert.equal(parent.type, "done");
    assert.equal(parent.name, "Parent");

    for (const [uuid, name] of [
      [WORKER_UUID, "Worker"],
      [EXPLORER_UUID, "Explorer"]
    ]) {
      const row = byAgent.get(uuid);
      assert.ok(row, "expected a row for " + uuid);
      assert.equal(row.type, "done", uuid);
      assert.equal(row.name, name, uuid);
      assert.equal(row.parentId, "parent:parent", uuid);
    }

    /* The delegation line names the model; the station can show what actually ran. */
    const spawnRows = events.filter((row) => row.modelRaw);
    assert.ok(spawnRows.length >= 1, "a delegation should carry the pinned model slug");

    const alerts = await waitFor(async () => {
      const body = await get(info.port, "/api/alerts");
      const list = body.alerts || [];
      return list.some((alert) => alert.status === "finished") ? list : null;
    });
    assert.ok(alerts, "expected finished alerts");

    const names = alerts.map((alert) => alert.name + ":" + alert.status);
    assert.ok(names.includes("Worker:finished"), "got " + names.join(", "));
    assert.ok(names.includes("Explorer:finished"), "got " + names.join(", "));
    /* A parent turn ends on every user message; toasting that would be noise. */
    assert.equal(
      alerts.some((alert) => alert.name === "Parent"),
      false,
      "the parent turn end must not toast"
    );

    /* The ring payload is { id, ts, name, status, agentId? }; the tighter name,status
       shape belongs to the desktop-notification handler, not this endpoint. Either way
       the payload must never carry a path or prompt. */
    for (const alert of alerts) {
      const keys = Object.keys(alert).sort();
      for (const key of keys) {
        assert.ok(
          ["id", "ts", "name", "status", "agentId"].includes(key),
          "unexpected alert key " + key
        );
      }
      assert.ok(alert.name && alert.status, "every alert names an agent and a status");
      const json = JSON.stringify(alert);
      assert.equal(json.includes(":\\"), false, "alert must not carry a Windows path: " + json);
      assert.equal(/prompt|secret/i.test(json), false, "alert leaked prompt text: " + json);
    }
  } finally {
    await stopBridgeForSmoke();
  }
});

test("an error terminal persists an error row and its reason reaches the log", async () => {
  const info = await startBridgeForSmoke();
  try {
    const sessionDir = path.join(info.transcriptsDir, SESSION);
    fs.mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "subagents", WORKER_UUID + ".jsonl"),
      [
        '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>do the thing</user_query>"}]}}',
        '{"type":"turn_ended","status":"error","error":"Other Models usage limit reached"}'
      ].join("\n") + "\n"
    );

    const events = await waitFor(async () => {
      const body = await get(info.port, "/api/history");
      const rows = body.events || [];
      return rows.some((row) => row.type === "error") ? rows : null;
    });
    assert.ok(events, "expected an error row");
    const errorRow = events.find((row) => row.type === "error");
    assert.equal(errorRow.agentId, WORKER_UUID);

    /* The reason rides the event stream (local UI), never the alert payload. */
    const feed = await waitFor(async () => {
      const body = await get(info.port, "/api/events");
      const list = body.events || [];
      return list.some((ev) => /Other Models usage limit reached/.test(ev.message || ""))
        ? list
        : null;
    });
    assert.ok(feed, "the terminal reason should appear in the event feed");

    const alerts = await get(info.port, "/api/alerts");
    const errorAlert = (alerts.alerts || []).find((alert) => alert.status === "error");
    assert.ok(errorAlert, "a subagent error must alert");
    assert.equal(
      /usage limit/.test(JSON.stringify(errorAlert)),
      false,
      "the alert payload must not carry the reason text"
    );
  } finally {
    await stopBridgeForSmoke();
  }
});

test("an unreadable line is counted and reported as drift, not dropped", async () => {
  const info = await startBridgeForSmoke();
  try {
    const sessionDir = path.join(info.transcriptsDir, SESSION);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, SESSION + ".jsonl"),
      [
        '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>hi</user_query>"}]}}',
        '{"type":"summary","note":"a shape this build does not know"}',
        '{"unterminated": ',
        '{"type":"turn_ended","status":"success"}'
      ].join("\n") + "\n"
    );

    const status = await waitFor(async () => {
      const body = await get(info.port, "/api/status");
      const d = body.drift;
      return d && d.unknownShape > 0 && d.unparsed > 0 ? body : null;
    });
    assert.ok(status, "drift counters should record both kinds of drift");
    assert.equal(status.drift.unknownShape, 1, "the summary line is an unknown shape");
    assert.equal(status.drift.unparsed, 1, "the truncated line does not parse");
    assert.ok(status.drift.lastAt, "drift records when it happened");

    const feed = await waitFor(async () => {
      const body = await get(info.port, "/api/events");
      const list = body.events || [];
      return list.some((ev) => /transcript drift/.test(ev.message || "")) ? list : null;
    });
    assert.ok(feed, "drift should surface in the event feed so the UI can say it out loud");

    /* The good lines still land: drift must not stop ingest. */
    const events = await waitFor(async () => {
      const body = await get(info.port, "/api/history");
      const rows = body.events || [];
      return rows.some((row) => row.type === "done") ? rows : null;
    });
    assert.ok(events, "a drifted transcript should still ingest its readable lines");
  } finally {
    await stopBridgeForSmoke();
  }
});
