/**
 * Copy the portable Windows GUI exe from dist/ to the repo root for easy double-click.
 * Invoked after `npm run build` / `npm run pack` (and as electron-builder afterAllArtifactBuild).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROOT_NAME = "AgentWorkshop.exe";
const DIST = path.join(ROOT, "dist");
const DEST = path.join(ROOT, ROOT_NAME);
const LEGACY_ROOT_NAME = "CursorAgentsModelRouting-Portable.exe";

const CANDIDATES = [
  path.join(DIST, ROOT_NAME),
  path.join(DIST, LEGACY_ROOT_NAME),
  path.join(DIST, "Cursor Agents Model Routing.exe"),
  path.join(DIST, "win-unpacked", "Cursor Agents Model Routing.exe")
];

/** Prefer the newest candidate so `npm run pack` (--dir) beats a stale portable. */
function findSource() {
  let best = null;
  let bestMtime = -1;
  for (const p of CANDIDATES) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const mtime = fs.statSync(p).mtimeMs;
    if (mtime >= bestMtime) {
      best = p;
      bestMtime = mtime;
    }
  }
  return best;
}

function removeLegacyRootCopy() {
  const legacy = path.join(ROOT, LEGACY_ROOT_NAME);
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isFile()) return;
  fs.unlinkSync(legacy);
  console.log("copy-exe: removed legacy", path.relative(ROOT, legacy));
}

function copyRootExe() {
  const src = findSource();
  if (!src) {
    console.error(
      "copy-exe: no portable/unpacked exe found under dist/. Run `npm run build` or `npm run pack` first."
    );
    process.exitCode = 1;
    return false;
  }
  fs.copyFileSync(src, DEST);
  removeLegacyRootCopy();
  console.log("copy-exe: refreshed", path.relative(ROOT, DEST), "←", path.relative(ROOT, src));
  return true;
}

// electron-builder afterAllArtifactBuild hook — receive context, still copy from dist/
function afterAllArtifactBuild() {
  copyRootExe();
}

if (require.main === module) {
  copyRootExe();
} else {
  module.exports = afterAllArtifactBuild;
  module.exports.copyRootExe = copyRootExe;
  module.exports.ROOT_NAME = ROOT_NAME;
}
