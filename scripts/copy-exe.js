/**
 * Copy the portable Windows GUI exe from dist/ to the repo root for easy double-click.
 * Invoked after `npm run build` / `npm run pack` (and as electron-builder afterAllArtifactBuild).
 *
 * Only copies electron-builder **portable** artifacts (self-contained single file).
 * Never copies `dist/win-unpacked/*.exe`. That binary needs ffmpeg.dll and sibling deps
 * beside it and will fail with a missing-DLL System Error if launched alone from the repo root.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROOT_NAME = "AgentWorkshop.exe";
const DIST = path.join(ROOT, "dist");
const DEST = path.join(ROOT, ROOT_NAME);
const LEGACY_ROOT_NAME = "CursorAgentsModelRouting-Portable.exe";

/** Portable-only candidates, in preference order (never win-unpacked). */
const PORTABLE_CANDIDATES = [
  path.join(DIST, ROOT_NAME),
  path.join(DIST, LEGACY_ROOT_NAME),
  path.join(DIST, "Cursor Agents Model Routing.exe")
];

/**
 * Prefer the first existing portable artifact. Do not pick by mtime across unpacked vs portable.
 * a fresher win-unpacked exe is not a valid root single-file launch.
 * @returns {string|null}
 */
function findSource() {
  for (const p of PORTABLE_CANDIDATES) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const rel = path.relative(ROOT, p).replace(/\\/g, "/");
    if (rel.includes("win-unpacked/")) continue;
    return p;
  }
  return null;
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
      "copy-exe: no portable exe found under dist/ (e.g. dist/AgentWorkshop.exe). " +
        "Run `npm run pack` or `npm run build`. do not copy win-unpacked Electron.exe alone."
    );
    process.exitCode = 1;
    return false;
  }
  fs.copyFileSync(src, DEST);
  removeLegacyRootCopy();
  console.log("copy-exe: refreshed", path.relative(ROOT, DEST), "←", path.relative(ROOT, src));
  return true;
}

// electron-builder afterAllArtifactBuild hook. Receive context, still copy from dist/
function afterAllArtifactBuild() {
  copyRootExe();
}

if (require.main === module) {
  copyRootExe();
} else {
  module.exports = afterAllArtifactBuild;
  module.exports.copyRootExe = copyRootExe;
  module.exports.findSource = findSource;
  module.exports.ROOT_NAME = ROOT_NAME;
  module.exports.PORTABLE_CANDIDATES = PORTABLE_CANDIDATES;
}
