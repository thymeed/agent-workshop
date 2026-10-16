/** Localhost-only HTTP surface: JSON helpers, origin/host guards, dashboard and static serving. */
"use strict";

const fs = require("fs");
const path = require("path");

const DASHBOARD = path.join(__dirname, "..", "model-routing-dashboard.html");
const STATIC_ROOT = path.join(__dirname, "..", "dashboard");

/** Tight CSP for the dashboard shell (external scripts; inline styles from JS/SVG). */
const DASHBOARD_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".map": "application/json; charset=utf-8"
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/** Read request body (capped) for POST JSON handlers. */
function readRequestBody(req, limitBytes) {
  const limit = limitBytes || 65536;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        try {
          req.destroy();
        } catch (_e) {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** True for IPv4/IPv6 loopback (incl. IPv4-mapped). */
function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") return true;
  if (addr.startsWith("::ffff:")) {
    return isLoopbackAddress(addr.slice("::ffff:".length));
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** Host header must name localhost / loopback (optional port). */
function isLocalhostHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    const name = host.slice(1, end);
    return name === "::1" || name === "127.0.0.1";
  }
  const name = host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1";
}

/**
 * Origin header: absent is OK (navigations, curl, same-origin without CORS).
 * If present, must be http(s) to localhost / 127.0.0.1 / ::1 on this bridge's port.
 */
function isAllowedOrigin(origin, port) {
  if (origin == null || origin === "") return true;
  if (origin === "null") return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    if (!(h === "localhost" || h === "127.0.0.1" || h === "::1")) return false;
    const originPort = u.port || (u.protocol === "https:" ? "443" : "80");
    return originPort === String(port);
  } catch (_) {
    return false;
  }
}

/**
 * /api/select CSRF guard.
 * Cross-site <img>/<script> GETs omit Origin but send Sec-Fetch-Site: cross-site.
 * Reject cross-site / same-site; if Sec-Fetch-Site is absent, require a valid Origin
 * (fetch always sends Origin; simple cross-site loads omit it).
 */
function allowProjectSelect(req, port) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return false;
  if (site === "same-origin" || site === "none") return true;
  const origin = req.headers.origin;
  return !!(origin && isAllowedOrigin(origin, port));
}

/**
 * Reject cross-site / non-loopback access so other websites cannot read or drive the bridge.
 * Checks socket remote address, Host, and Origin (when sent). Origin "null" is never allowed.
 * @returns {boolean} true if the request was rejected
 */
function rejectIfNotLocal(req, res, port) {
  const remote = (req.socket && req.socket.remoteAddress) || "";
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!isLoopbackAddress(remote) || !isLocalhostHost(host) || !isAllowedOrigin(origin, port)) {
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end("Forbidden · localhost only");
    return true;
  }
  return false;
}

function serveDashboard(res) {
  fs.readFile(DASHBOARD, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Missing model-routing-dashboard.html next to live-bridge.js");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": DASHBOARD_CSP
    });
    res.end(data);
  });
}

/**
 * Serve files under /dashboard/* from the dashboard/ folder (CSS/JS split).
 * Rejects path traversal; only GET-friendly static assets.
 */
function serveStatic(urlPath, res) {
  if (!urlPath.startsWith("/dashboard/")) return false;
  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice("/dashboard/".length));
  } catch (_e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return true;
  }
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return true;
  }
  const resolved = path.resolve(STATIC_ROOT, rel);
  const rootResolved = path.resolve(STATIC_ROOT) + path.sep;
  if (resolved !== path.resolve(STATIC_ROOT) && !resolved.startsWith(rootResolved)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }
  fs.stat(resolved, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Read error");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
  return true;
}

module.exports = {
  DASHBOARD,
  STATIC_ROOT,
  DASHBOARD_CSP,
  MIME,
  sendJson,
  readRequestBody,
  isLoopbackAddress,
  isLocalhostHost,
  isAllowedOrigin,
  allowProjectSelect,
  rejectIfNotLocal,
  serveDashboard,
  serveStatic
};
