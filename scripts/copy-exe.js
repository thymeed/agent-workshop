/**
 * Refresh the repo-root AgentWorkshop.exe from the packaged portable artifact.
 * Windows-only: other platforms have no single-file portable exe and this is a no-op.
 *
 * Never copies dist/win-unpacked/*.exe. That binary needs ffmpeg.dll and sibling
 * deps beside it and fails with a missing-DLL error when launched alone.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROOT_NAME = "AgentWorkshop.exe";
const DIST = path.join(ROOT, "dist");
const DEST = path.join(ROOT, ROOT_NAME);
const LEGACY_ROOT_NAME = "CursorAgentsModelRouting-Portable.exe";

const PORTABLE_CANDIDATES = [
  path.join(DIST, ROOT_NAME),
  path.join(DIST, LEGACY_ROOT_NAME),
  path.join(DIST, "Cursor Agents Model Routing.exe")
];

/** First existing portable artifact. Never picks by mtime: a fresher win-unpacked exe is not a valid single-file launch. */
function findSource() {
  for (const p of PORTABLE_CANDIDATES) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    if (path.relative(ROOT, p).replace(/\\/g, "/").includes("win-unpacked/")) continue;
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

/**
 * @param {{required?: boolean}} [opts] required (default true) fails the process when
 * no portable artifact exists. The electron-builder hook passes false: `--dir` builds
 * and non-Windows builds legitimately produce no portable exe.
 */
function copyRootExe(opts) {
  const required = !opts || opts.required !== false;

  if (process.platform !== "win32") {
    console.log("copy-exe: skipped · repo-root exe is a Windows-only artifact");
    return false;
  }

  const src = findSource();
  if (!src) {
    const detail =
      "no portable exe found under dist/ (e.g. dist/AgentWorkshop.exe). " +
      "Run `npm run pack` or `npm run pack:win`.";
    if (required) {
      console.error("copy-exe: " + detail);
      process.exitCode = 1;
    } else {
      console.log("copy-exe: nothing to refresh · " + detail);
    }
    return false;
  }

  fs.copyFileSync(src, DEST);
  removeLegacyRootCopy();
  console.log("copy-exe: refreshed", path.relative(ROOT, DEST), "←", path.relative(ROOT, src));
  return true;
}

function afterAllArtifactBuild() {
  copyRootExe({ required: false });
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
