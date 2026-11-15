/**
 * Claude Code parser role -> dashboard slot key. Pure data: no fs, no DOM.
 *
 * Slot keys (opus, advisor, worker, explorer, researcher) are the stable card and
 * stage keys. The names shown for each slot come from dashboard/role-profiles.js.
 *
 * Read this carefully: the parser's "researcher" is the EXPLORER slot, and the
 * parser's "reviewer" is the RESEARCHER slot. The names are not the same thing.
 */
"use strict";

/** @type {Readonly<Record<string, string>>} */
const PARSER_ROLE_TO_SLOT = Object.freeze({
  parent: "opus",
  planner: "advisor",
  worker: "worker",
  researcher: "explorer",
  reviewer: "researcher"
});

module.exports = { PARSER_ROLE_TO_SLOT };
