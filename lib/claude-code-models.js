/**
 * Claude Code model alias -> full model id, resolved at ingest. Pure: no fs, no DOM.
 *
 * Claude Code writes bare aliases (opus, sonnet, haiku, inherit) into agent files and
 * Task calls. RoleProfiles.setModels and the list-price rows never see an alias: a bare
 * alias has no "claude" or "anthropic" token, so it would show "no list price".
 */
"use strict";

/**
 * Latest full ids as of 2026-11-15. Update together with LIST_PRICES in
 * dashboard/role-profiles.js when a new model ships.
 * @type {Readonly<Record<string, string>>}
 */
const MODEL_ALIASES = Object.freeze({
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5"
});

/* Same id pattern as MODEL_ID_RE in dashboard/role-profiles.js. Keep the two in step. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** Separators that start a path-like segment in an id. */
const SEGMENT_SEP_RE = /[/@:]/;

/** arn:aws:bedrock:<region>::foundation-model/<name>: split around the empty account field. */
var BEDROCK_FOUNDATION_RE =
  /^(arn:aws:bedrock:[a-z]{2}(?:-[a-z]+)+-[0-9]+:)(:foundation-model[/].+)$/;

/** Lowercased, trimmed value with a trailing "[1m]" context suffix removed. */
function aliasKey(value) {
  var key = value.trim().toLowerCase();
  if (key.slice(-4) === "[1m]") key = key.slice(0, -4);
  return key;
}

/** True when a full id has a "claude" or "anthropic" token (whole tokens, like the price rule). */
function hasClaudeToken(id) {
  var tokens = id.toLowerCase().split(/[^a-z]+/);
  return tokens.indexOf("claude") >= 0 || tokens.indexOf("anthropic") >= 0;
}

/** A full id that is safe to pass through: pattern, no empty, "." or ".." segment, no backslash. */
function isFullId(id) {
  if (!MODEL_ID_RE.test(id)) return false;
  // MODEL_ID_RE (above) already refuses a leading "_" and any backslash; the next two checks
  // are defense in depth, in case the pattern is ever widened.
  if (id.charAt(0) === "_") return false;
  if (id.indexOf(String.fromCharCode(92)) >= 0) return false;
  // the one empty segment allowed: the account field of a Bedrock foundation-model ARN
  var bedrock = BEDROCK_FOUNDATION_RE.exec(id);
  var segs = (bedrock ? bedrock[1] + "acct" + bedrock[2] : id).split(SEGMENT_SEP_RE);
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] === "" || segs[i] === "." || segs[i] === "..") return false;
  }
  return hasClaudeToken(id);
}

/** One value to a concrete id, or "". Never treats "inherit" as a model. */
function resolveConcrete(value) {
  if (typeof value !== "string") return "";
  var key = aliasKey(value);
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key)) return MODEL_ALIASES[key];
  var id = value.trim();
  // a "[1m]" context suffix is not part of the id; the rest must pass on its own
  if (id.slice(-4).toLowerCase() === "[1m]") id = id.slice(0, -4);
  return isFullId(id) ? id : "";
}

/**
 * Resolve a Claude Code model value to a full model id, or "" for unset.
 *
 * - opus / sonnet / haiku (any case, surrounding space, or a "[1m]" suffix) -> latest id.
 * - inherit -> the parent session's model, resolved once (a parent of "inherit" is unset).
 * - A full id (claude or anthropic token, sane pattern, no ".." segment) passes unchanged.
 * - Anything else, including unknown bare words, non-strings and blanks, is "".
 *
 * @param {unknown} value  the model as Claude Code wrote it
 * @param {unknown} [parentModel]  the parent session's model, for "inherit"
 * @returns {string}
 */
function resolveModelAlias(value, parentModel) {
  if (typeof value !== "string") return "";
  if (aliasKey(value) === "inherit") {
    return resolveConcrete(parentModel);
  }
  return resolveConcrete(value);
}

module.exports = { resolveModelAlias, MODEL_ALIASES };
