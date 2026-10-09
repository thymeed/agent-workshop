/**
 * Live bridge: localhost-only, no ACAO *, static path safety, /api/select CSRF guard.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const http = require("http");
const { startBridgeForSmoke, stopBridgeForSmoke } = require("./bridge-smoke-harness.js");

function request(
  port,
  { path = "/api/status", headers = {}, method = "GET", hang = false, body = null } = {}
) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(String(body), "utf8");
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders["Content-Length"] = String(payload.length);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: reqHeaders
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
        let resBody = "";
        res.on("data", (c) => {
          resBody += c;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: resBody
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
    if (payload) req.end(payload);
    else req.end();
  });
}

async function main() {
  const { port } = await startBridgeForSmoke();
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

    // /api/select: GET rejected; cross-site / missing header rejected; POST+header OK path
    const selectGet = await request(port, {
      path: "/api/select",
      method: "GET",
      headers: {
        ...baseHeaders,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Cursor-Bridge": "1"
      }
    });
    if (selectGet.status !== 405) {
      errors.push("select GET expected 405, got " + selectGet.status);
    }

    const selectCross = await request(port, {
      path: "/api/select",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "X-Cursor-Bridge": "1"
      },
      body: JSON.stringify({ id: "any" })
    });
    if (selectCross.status !== 403) {
      errors.push("select cross-site expected 403, got " + selectCross.status);
    }

    const selectNoHeader = await request(port, {
      path: "/api/select",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin"
      },
      body: JSON.stringify({ id: "any" })
    });
    if (selectNoHeader.status !== 403) {
      errors.push("select without X-Cursor-Bridge expected 403, got " + selectNoHeader.status);
    }

    const selectNoMeta = await request(port, {
      path: "/api/select",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        "X-Cursor-Bridge": "1"
      },
      body: JSON.stringify({ id: "any" })
    });
    if (selectNoMeta.status !== 403) {
      errors.push("select without Origin/Sec-Fetch-Site expected 403, got " + selectNoMeta.status);
    }

    const selectOk = await request(port, {
      path: "/api/select",
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Cursor-Bridge": "1"
      },
      body: JSON.stringify({ id: "any" })
    });
    // Unknown id → 400, not 403
    if (selectOk.status === 403) {
      errors.push("select same-origin POST should not be 403");
    }
    if (selectOk.status !== 400) {
      errors.push("select unknown id expected 400, got " + selectOk.status);
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
    await stopBridgeForSmoke();
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
