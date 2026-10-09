"use strict";

/**
 * Normalize path separators to forward slashes (Windows backslashes, mixed paths).
 * @param {string} filePath
 * @returns {string}
 */
function normalizePathSlashes(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  return normalizePathSlashes(filePath).split("/").filter(Boolean);
}

/** True when filePath is under a subagents/ folder (any separator style). */
function isSubagentTranscriptPath(filePath) {
  return pathSegments(filePath).includes("subagents");
}

/**
 * @param {string} filePath
 * @returns {string|null} uuid basename without .jsonl
 */
function subagentUuidFromTranscriptPath(filePath) {
  if (!isSubagentTranscriptPath(filePath)) return null;
  const segs = pathSegments(filePath);
  const base = segs[segs.length - 1] || "";
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

module.exports = {
  normalizePathSlashes,
  pathSegments,
  isSubagentTranscriptPath,
  subagentUuidFromTranscriptPath
};
