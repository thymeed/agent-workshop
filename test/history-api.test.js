/**
 * History API: localhost Host/Origin guards, no ACAO, contract shape, clear header.
 */
"use strict";

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge, stopBridge } = require("../live-bridge.js");
const { EVENT_TYPES } = require("../lib/event-log");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function request(
  port,
  { path: urlPath = "/api/history", headers = {}, method = "GET", body } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function assertContractEvent(ev, errors, label) {
  const keys = [
    "ts",
    "sessionId",
    "agentId",
    "parentId",
    "name",
    "model",
    "type",
    "inputTokens",
    "outputTokens",
    "files"
  ];
  for (const k of keys) {
    if (!(k in ev)) errors.push(label + " missing " + k);
  }
  if (typeof ev.ts !== "string" || Number.isNaN(Date.parse(ev.ts))) {
    errors.push(label + " bad ts");
  }
  if (typeof ev.sessionId !== "string") errors.push(label + " sessionId");
  if (typeof ev.agentId !== "string") errors.push(label + " agentId");
  if (!(ev.parentId === null || typeof ev.parentId === "string")) {
    errors.push(label + " parentId");
  }
  if (typeof ev.name !== "string") errors.push(label + " name");
  if (typeof ev.model !== "string") errors.push(label + " model");
  if (!EVENT_TYPES.has(ev.type)) errors.push(label + " type " + ev.type);
  if (typeof ev.inputTokens !== "number") errors.push(label + " inputTokens");
  if (typeof ev.outputTokens !== "number") errors.push(label + " outputTokens");
  if (!Array.isArray(ev.files)) errors.push(label + " files");
}

async function main() {
  const port = await getFreePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-api-"));
  const alerts = [];

  await startBridge({
    port,
    quiet: true,
    eventLogDir: logDir,
    onAgentAlert: (a) => alerts.push(a)
  });

  const errors = [];
  const origin = `http://127.0.0.1:${port}`;
  const baseHeaders = { Host: `127.0.0.1:${port}` };

  try {
    // Seed via internal record path by writing through the running log API after append:
    // Use require of event-log with same dir — bridge already created log there.
    const { createEventLog } = require("../lib/event-log");
    const seed = createEventLog({ logDir });
    seed.append({
      ts: new Date().toISOString(),
      sessionId: "sess-a",
      agentId: "ag-1",
      parentId: null,
      name: "Worker",
      model: "sonnet",
      type: "spawn",
      inputTokens: 1,
      outputTokens: 2,
      files: []
    });
    seed.append({
      ts: new Date().toISOString(),
      sessionId: "sess-b",
      agentId: "ag-2",
      parentId: "ag-1",
      name: "Explorer",
      model: "haiku",
      type: "turn",
      inputTokens: 3,
      outputTokens: 4,
      files: ["x.js"]
    });

    const ok = await request(port, { headers: baseHeaders });
    if (ok.status !== 200) errors.push("GET /api/history expected 200, got " + ok.status);
    if (ok.headers["access-control-allow-origin"] != null) {
      errors.push("history must not send Access-Control-Allow-Origin");
    }
    let parsed;
    try {
      parsed = JSON.parse(ok.body);
    } catch (_e) {
      errors.push("history body not JSON");
      parsed = { events: [] };
    }
    if (!parsed || !Array.isArray(parsed.events)) {
      errors.push('history response must be {"events":[...]}');
    } else {
      if (parsed.events.length < 2) {
        errors.push("expected seeded events, got " + parsed.events.length);
      }
      for (let i = 0; i < parsed.events.length; i++) {
        assertContractEvent(parsed.events[i], errors, "events[" + i + "]");
      }
    }

    const localOrigin = await request(port, {
      headers: { ...baseHeaders, Origin: origin }
    });
    if (localOrigin.status !== 200) {
      errors.push("same-origin Origin expected 200, got " + localOrigin.status);
    }
    if (localOrigin.headers["access-control-allow-origin"] != null) {
      errors.push("same-origin response must not send ACAO");
    }

    const nullOrigin = await request(port, {
      headers: { ...baseHeaders, Origin: "null" }
    });
    if (nullOrigin.status !== 403) {
      errors.push('Origin "null" expected 403, got ' + nullOrigin.status);
    }

    const evil = await request(port, {
      headers: { ...baseHeaders, Origin: "https://evil.example" }
    });
    if (evil.status !== 403) errors.push("foreign Origin expected 403, got " + evil.status);

    const wrongPort = await request(port, {
      headers: { ...baseHeaders, Origin: "http://127.0.0.1:1" }
    });
    if (wrongPort.status !== 403) {
      errors.push("Origin wrong port expected 403, got " + wrongPort.status);
    }

    const badHost = await request(port, {
      headers: { Host: "evil.example", Origin: origin }
    });
    if (badHost.status !== 403) errors.push("foreign Host expected 403, got " + badHost.status);

    const filtered = await request(port, {
      path: "/api/history?session=sess-a",
      headers: baseHeaders
    });
    if (filtered.status === 200) {
      const j = JSON.parse(filtered.body);
      if (!j.events.every((e) => e.sessionId === "sess-a")) {
        errors.push("session filter leaked other sessions");
      }
    } else {
      errors.push("session filter expected 200, got " + filtered.status);
    }

    const clearNoHeader = await request(port, {
      path: "/api/history/clear",
      method: "POST",
      headers: {
        ...baseHeaders,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin"
      }
    });
    if (clearNoHeader.status !== 403) {
      errors.push("clear without X-Cursor-Bridge expected 403, got " + clearNoHeader.status);
    }

    const clearCross = await request(port, {
      path: "/api/history/clear",
      method: "POST",
      headers: {
        ...baseHeaders,
        "X-Cursor-Bridge": "1",
        "Sec-Fetch-Site": "cross-site"
      }
    });
    if (clearCross.status !== 403) {
      errors.push("clear cross-site expected 403, got " + clearCross.status);
    }

    const clearOk = await request(port, {
      path: "/api/history/clear",
      method: "POST",
      headers: {
        ...baseHeaders,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Cursor-Bridge": "1"
      }
    });
    if (clearOk.status !== 200) {
      errors.push("clear expected 200, got " + clearOk.status);
    } else {
      try {
        const j = JSON.parse(clearOk.body);
        if (j.ok !== true) errors.push("clear body expected {ok:true}");
      } catch (_e) {
        errors.push("clear body not JSON");
      }
    }
    if (clearOk.headers["access-control-allow-origin"] != null) {
      errors.push("clear must not send Access-Control-Allow-Origin");
    }

    const afterClear = await request(port, { headers: baseHeaders });
    if (afterClear.status === 200) {
      const j = JSON.parse(afterClear.body);
      if (j.events.length !== 0) errors.push("history not empty after clear");
    }

    // Alert payload shape: name + status only (simulate via startBridge callback already wired)
    const { recordHistoryEvent } = require("../live-bridge.js");
    recordHistoryEvent({
      ts: new Date().toISOString(),
      sessionId: "sess-alert",
      agentId: "ag-alert",
      parentId: null,
      name: "Advisor",
      model: "fable",
      type: "done",
      inputTokens: 0,
      outputTokens: 0,
      files: ["/secret/path.js"]
    });
    if (!alerts.length) {
      errors.push("expected finished alert");
    } else {
      const a = alerts[alerts.length - 1];
      const keys = Object.keys(a).sort();
      if (keys.join(",") !== "name,status") {
        errors.push("alert keys must be only name,status · got " + keys.join(","));
      }
      if (a.status !== "finished") errors.push("alert status expected finished");
      if (/path|prompt|secret/i.test(JSON.stringify(a))) {
        errors.push("alert leaked path/prompt: " + JSON.stringify(a));
      }
    }
  } finally {
    await stopBridge();
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch (_e) {
      /* ignore */
    }
  }

  if (errors.length) {
    console.error("History API tests failed:\n- " + errors.join("\n- "));
    process.exit(1);
  }
  console.log(
    "History API tests OK · free port " + port + " · guards/ACAO/contract/clear/alerts passed"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
