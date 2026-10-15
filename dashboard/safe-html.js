/**
 * The single HTML escaper for the dashboard. Transcript-derived strings reach the DOM
 * through innerHTML, so this must be the only implementation. Loaded before every other
 * dashboard script and exposed as window.SafeHtml.
 */
(function () {
  "use strict";

  /**
   * Escape text for interpolation into HTML. Preserves `0` and `false` (falsy but
   * meaningful) and renders null/undefined as empty rather than the literal "null".
   * Single quotes are escaped too, so the result is safe in an attribute quoted with
   * either `"` or `'`.
   * @param {*} s
   * @returns {string}
   */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.SafeHtml = { escapeHtml: escapeHtml };
})();
