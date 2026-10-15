/**
 * Lightweight packaging/build check (no electron-builder).
 * Verifies files listed for the desktop app exist and bridge module loads.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const required = [
  "model-routing-dashboard.html",
  "live-bridge.js",
  "lib/event-log.js",
  "electron/main.js",
  "dashboard/styles.css",
  "dashboard/app.js",
  "package.json"
];

let failed = false;
for (const rel of required) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error("missing required file:", rel);
    failed = true;
  }
}

const html = fs.readFileSync(path.join(root, "model-routing-dashboard.html"), "utf8");
if (!html.includes('href="dashboard/styles.css"')) {
  console.error("HTML missing stylesheet link to dashboard/styles.css");
  failed = true;
}
if (!html.includes('src="dashboard/app.js"')) {
  console.error("HTML missing script src dashboard/app.js");
  failed = true;
}
if (/<style[\s>]/i.test(html)) {
  console.error("HTML still contains an inline <style> block");
  failed = true;
}
if (/<script(?![^>]*\bsrc=)/i.test(html)) {
  console.error("HTML still contains an inline <script> block");
  failed = true;
}

/* Every referenced dashboard script must exist, and safe-html.js must load first:
   every other dashboard module aliases window.SafeHtml at IIFE execution time. */
const scriptSrcs = [...html.matchAll(/<script\s+src="(dashboard\/[^"]+)"/g)].map((m) => m[1]);
if (scriptSrcs.length === 0) {
  console.error("HTML references no dashboard scripts");
  failed = true;
}
for (const rel of scriptSrcs) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error("HTML references a missing script:", rel);
    failed = true;
  }
}
const safeHtmlAt = scriptSrcs.indexOf("dashboard/safe-html.js");
if (safeHtmlAt !== 0) {
  console.error(
    "dashboard/safe-html.js must be the first dashboard script (found at index " + safeHtmlAt + ")"
  );
  failed = true;
}

const pkg = require(path.join(root, "package.json"));
const files = (pkg.build && pkg.build.files) || [];
const needGlobs = ["dashboard/**/*", "model-routing-dashboard.html", "live-bridge.js", "lib/**/*"];
for (const g of needGlobs) {
  if (!files.includes(g)) {
    console.error("package.json build.files missing:", g);
    failed = true;
  }
}

try {
  const bridge = require(path.join(root, "live-bridge.js"));
  if (typeof bridge.startBridge !== "function" || typeof bridge.stopBridge !== "function") {
    console.error("live-bridge.js must export startBridge/stopBridge");
    failed = true;
  }
} catch (err) {
  console.error("failed to load live-bridge.js:", err.message);
  failed = true;
}

if (failed) process.exit(1);
console.log("Packaging check OK · dashboard assets + bridge exports present");
