/**
 * Route x guard matrix for the bridge: loopback enforcement, method guards,
 * CSRF header/site guards, body validation, static traversal, and CORS posture.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

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
  const options = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method || "GET",
        path: options.path || "/",
        headers: options.headers || {}
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };
const BRIDGE_HEADER = { "X-Cursor-Bridge": "1" };
const GUARDED_POSTS = ["/api/select", "/api/snooze", "/api/history/clear"];

async function testLoopbackGuard(port) {
  const cases = [
    ["foreign Host", { Host: "evil.example" }, 403],
    ["foreign Origin", { Origin: "https://evil.example" }, 403],
    ["Origin: null", { Origin: "null" }, 403],
    ["Origin on other port", { Origin: "http://127.0.0.1:1" }, 403],
    ["Origin on bridge port", { Origin: `http://127.0.0.1:${port}` }, 200],
    ["absent Origin", {}, 200]
  ];
  for (const [label, headers, expected] of cases) {
    const res = await request(port, { path: "/api/status", headers });
    assert.strictEqual(res.status, expected, `${label}: expected ${expected}, got ${res.status}`);
  }
}

async function testMethodGuards(port) {
  const cases = [
    ["/api/select", "GET"],
    ["/api/snooze", "GET"],
    ["/api/snooze", "DELETE"],
    ["/api/history/clear", "GET"],
    ["/api/history", "POST"],
    ["/api/alerts", "POST"]
  ];
  for (const [p, method] of cases) {
    const res = await request(port, { method, path: p, headers: SAME_ORIGIN });
    assert.strictEqual(res.status, 405, `${method} ${p}: expected 405, got ${res.status}`);
  }

  const options = await request(port, { method: "OPTIONS", path: "/api/status" });
  assert.strictEqual(options.status, 204, `OPTIONS: expected 204, got ${options.status}`);
}

async function testCsrfGuards(port) {
  const cases = [
    ["no X-Cursor-Bridge", SAME_ORIGIN],
    ["cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ["same-site", { "Sec-Fetch-Site": "same-site" }],
    ["foreign Origin", { Origin: "https://evil.example" }]
  ];

  for (const p of GUARDED_POSTS) {
    for (const [label, extra] of cases) {
      const base = label === "no X-Cursor-Bridge" ? {} : BRIDGE_HEADER;
      const res = await request(port, {
        method: "POST",
        path: p,
        headers: Object.assign({}, JSON_HEADERS, base, extra),
        body: '{"id":"x"}'
      });
      assert.strictEqual(res.status, 403, `POST ${p} (${label}): expected 403, got ${res.status}`);
    }
  }
}

async function testBodyValidation(port) {
  const post = (p, body) =>
    request(port, {
      method: "POST",
      path: p,
      headers: Object.assign({}, JSON_HEADERS, SAME_ORIGIN, BRIDGE_HEADER),
      body
    });

  const rejected = [
    ["empty body", ""],
    ["invalid JSON", "{"],
    ["empty object", "{}"],
    ["non-boolean", '{"snoozed":"yes"}'],
    ["null value", '{"snoozed":null}'],
    ["array body", "[1,2]"]
  ];
  for (const [label, body] of rejected) {
    const res = await post("/api/snooze", body);
    assert.strictEqual(res.status, 400, `snooze ${label}: expected 400, got ${res.status}`);
  }

  const on = await post("/api/snooze", '{"snoozed":true}');
  assert.strictEqual(on.status, 200, `snooze true: expected 200, got ${on.status}`);
  assert.strictEqual(JSON.parse(on.body).snoozed, true, "snooze true must echo snoozed:true");

  const status = await request(port, { path: "/api/status" });
  assert.strictEqual(JSON.parse(status.body).snoozed, true, "status must agree with snooze state");

  const off = await post("/api/snooze", '{"snoozed":false}');
  assert.strictEqual(off.status, 200, `snooze false: expected 200, got ${off.status}`);
  assert.strictEqual(JSON.parse(off.body).snoozed, false, "snooze false must echo snoozed:false");

  const selectCases = [
    ["missing id", '{"nope":1}'],
    ["invalid JSON", "{"],
    ["unknown project", '{"id":"no-such-project-xyz"}']
  ];
  for (const [label, body] of selectCases) {
    const res = await post("/api/select", body);
    assert.strictEqual(res.status, 400, `select ${label}: expected 400, got ${res.status}`);
  }
}

async function testStaticAndCors(port) {
  const home = await request(port, { path: "/" });
  assert.strictEqual(home.status, 200, `GET /: expected 200, got ${home.status}`);
  assert.ok(/text\/html/.test(home.headers["content-type"]), "GET / must be text/html");

  const css = await request(port, { path: "/dashboard/styles.css" });
  assert.strictEqual(css.status, 200, `GET stylesheet: expected 200, got ${css.status}`);

  const traversal = await request(port, { path: "/dashboard/..%2f..%2fpackage.json" });
  assert.ok(
    traversal.status === 403 || traversal.status === 404,
    `traversal: expected 403/404, got ${traversal.status}`
  );

  const probes = [
    "/",
    "/api/status",
    "/api/projects",
    "/api/alerts",
    "/api/history",
    "/api/events"
  ];
  for (const p of probes) {
    const res = await request(port, { path: p });
    assert.ok(
      !("access-control-allow-origin" in res.headers),
      `${p} must not send Access-Control-Allow-Origin`
    );
  }

  const missing = await request(port, { path: "/api/definitely-not-a-route" });
  assert.strictEqual(missing.status, 404, `unknown route: expected 404, got ${missing.status}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guards-transcripts-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guards-projects-"));
  const eventLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "guards-log-"));
  const port = await getFreePort();

  const { startBridge, stopBridge } = require("../live-bridge.js");
  await startBridge({ port, quiet: true, dir, projectsRoot, eventLogDir, reuseExisting: false });

  try {
    await testLoopbackGuard(port);
    await testMethodGuards(port);
    await testCsrfGuards(port);
    await testBodyValidation(port);
    await testStaticAndCors(port);
    console.log("bridge-guards OK · loopback, method, CSRF, body, static, CORS matrix");
  } finally {
    await stopBridge();
    for (const d of [dir, projectsRoot, eventLogDir]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
