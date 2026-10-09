/**
 * Live bridge: localhost-only, no ACAO *, static path safety, /api/select CSRF guard.
 */
"use strict";

const http = require("http");
const net = require("net");
const { startBridge, stopBridge } = require("../live-bridge.js");

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
  const port = await getFreePort();
  await startBridge({ port, quiet: true });
  const errors = [];
  const origin = `http://127.0.0.1:${port}`;
  const baseHeaders = { Host: `127.0.0.1:${port}` };

  try {
    const ok = await request(port, { headers: baseHeaders });
    if (ok.status !== 200) errors.push("loopback status expected 200, got " + ok.status);
    if (ok.headers["access-control-allow-origin"] != null) {
      errors.push(
        "unexpected Access-Control-Allow-Origin: " + ok.headers["access-control-allow-origin"]
      );
    }

    const localOrigin = await request(port, {
      headers: { ...baseHeaders, Origin: origin }
    });
    if (localOrigin.status !== 200) {
      errors.push("same-origin Origin expected 200, got " + localOrigin.status);
    }

    const wrongPortOrigin = await request(port, {
      headers: { ...baseHeaders, Origin: "http://127.0.0.1:1" }
    });
    if (wrongPortOrigin.status !== 403) {
      errors.push("Origin on wrong port expected 403, got " + wrongPortOrigin.status);
    }

    const evil = await request(port, {
      headers: { ...baseHeaders, Origin: "https://evil.example" }
    });
    if (evil.status !== 403) errors.push("foreign Origin expected 403, got " + evil.status);

    const nullOrigin = await request(port, {
      headers: { ...baseHeaders, Origin: "null" }
    });
    if (nullOrigin.status !== 403) {
      errors.push('Origin "null" expected 403, got ' + nullOrigin.status);
    }

    const badHost = await request(port, {
      headers: { Host: "evil.example", Origin: origin }
    });
    if (badHost.status !== 403) errors.push("foreign Host expected 403, got " + badHost.status);

    // /api/select: cross-site without Origin (img/script style) must fail
    const selectCross = await request(port, {
      path: "/api/select?id=any",
      headers: { ...baseHeaders, "Sec-Fetch-Site": "cross-site" }
    });
    if (selectCross.status !== 403) {
      errors.push("select cross-site expected 403, got " + selectCross.status);
    }

    const selectNoMeta = await request(port, {
      path: "/api/select?id=any",
      headers: baseHeaders
    });
    if (selectNoMeta.status !== 403) {
      errors.push("select without Origin/Sec-Fetch-Site expected 403, got " + selectNoMeta.status);
    }

    const selectOk = await request(port, {
      path: "/api/select?id=any",
      headers: {
        ...baseHeaders,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin"
      }
    });
    // Unknown id → 400, not 403
    if (selectOk.status === 403) {
      errors.push("select same-origin should not be 403");
    }

    const stream = await request(port, {
      path: "/api/stream",
      hang: true,
      headers: {
        ...baseHeaders,
        Origin: origin,
        Accept: "text/event-stream"
      }
    });
    if (stream.status !== 200) errors.push("SSE expected 200, got " + stream.status);
    if (stream.headers["access-control-allow-origin"] != null) {
      errors.push("SSE must not send Access-Control-Allow-Origin");
    }

    const css = await request(port, {
      path: "/dashboard/styles.css",
      headers: baseHeaders
    });
    if (css.status !== 200) errors.push("styles.css expected 200, got " + css.status);
    if (!String(css.headers["content-type"] || "").includes("text/css")) {
      errors.push("styles.css wrong content-type: " + css.headers["content-type"]);
    }

    const js = await request(port, {
      path: "/dashboard/app.js",
      headers: baseHeaders
    });
    if (js.status !== 200) errors.push("app.js expected 200, got " + js.status);
    if (!String(js.headers["content-type"] || "").includes("javascript")) {
      errors.push("app.js wrong content-type: " + js.headers["content-type"]);
    }

    const traversal = await request(port, {
      path: "/dashboard/" + encodeURIComponent("../package.json"),
      headers: baseHeaders
    });
    if (traversal.status !== 403) {
      errors.push("path traversal expected 403, got " + traversal.status);
    }

    const malformed = await request(port, {
      path: "/dashboard/%E0",
      headers: baseHeaders
    });
    if (malformed.status !== 400) {
      errors.push("malformed percent-encoding expected 400, got " + malformed.status);
    }

    const html = await request(port, {
      path: "/",
      headers: baseHeaders
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
  console.log(
    "Bridge localhost lockdown OK · free port " + port + " · static/CSRF/CORS checks passed"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
