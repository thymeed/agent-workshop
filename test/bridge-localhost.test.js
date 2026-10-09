/**
 * Live bridge must stay localhost-only: no ACAO *, reject foreign Origin/Host.
 */
"use strict";

const http = require("http");
const { startBridge, stopBridge } = require("../live-bridge.js");

function request(port, { path = "/api/status", headers = {}, method = "GET", hang = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers
      },
      (res) => {
        if (hang) {
          // SSE / long-lived: capture status + headers, then abort
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: ""
          });
          req.destroy();
          return;
        }
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body
          });
        });
      }
    );
    req.on("error", (err) => {
      if (hang && err && (err.code === "ECONNRESET" || err.message === "socket hang up")) {
        return;
      }
      reject(err);
    });
    req.end();
  });
}

async function main() {
  const { port } = await startBridge({ port: 3861, quiet: true });
  const errors = [];

  try {
    const ok = await request(port, {
      headers: { Host: `127.0.0.1:${port}` }
    });
    if (ok.status !== 200) errors.push("loopback status expected 200, got " + ok.status);
    if (ok.headers["access-control-allow-origin"] != null) {
      errors.push(
        "unexpected Access-Control-Allow-Origin: " + ok.headers["access-control-allow-origin"]
      );
    }

    const localOrigin = await request(port, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`
      }
    });
    if (localOrigin.status !== 200) {
      errors.push("same-origin Origin expected 200, got " + localOrigin.status);
    }

    const localhostHost = await request(port, {
      headers: {
        Host: `localhost:${port}`,
        Origin: `http://localhost:${port}`
      }
    });
    if (localhostHost.status !== 200) {
      errors.push("localhost Host/Origin expected 200, got " + localhostHost.status);
    }

    const evil = await request(port, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: "https://evil.example"
      }
    });
    if (evil.status !== 403) errors.push("foreign Origin expected 403, got " + evil.status);

    const nullOrigin = await request(port, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: "null"
      }
    });
    if (nullOrigin.status !== 403) {
      errors.push('Origin "null" expected 403, got ' + nullOrigin.status);
    }

    const badHost = await request(port, {
      headers: {
        Host: "evil.example",
        Origin: `http://127.0.0.1:${port}`
      }
    });
    if (badHost.status !== 403) errors.push("foreign Host expected 403, got " + badHost.status);

    const stream = await request(port, {
      path: "/api/stream",
      hang: true,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        Accept: "text/event-stream"
      }
    });
    if (stream.status !== 200) errors.push("SSE expected 200, got " + stream.status);
    if (stream.headers["access-control-allow-origin"] != null) {
      errors.push("SSE must not send Access-Control-Allow-Origin");
    }

    const html = await request(port, {
      path: "/",
      headers: { Host: `127.0.0.1:${port}` }
    });
    if (html.status !== 200 || !/Model Routing/i.test(html.body)) {
      errors.push("dashboard HTML not served for localhost");
    }
  } finally {
    await stopBridge();
  }

  if (errors.length) {
    console.error("Bridge localhost lockdown failed:\n- " + errors.join("\n- "));
    process.exit(1);
  }
  console.log("Bridge localhost lockdown OK · no CORS *, foreign Origin/Host rejected");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
