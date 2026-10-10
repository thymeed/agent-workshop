"use strict";

/**
 * Playwright error collectors for dashboard smoke tests.
 *
 * Allowed soft failures until sibling PRs land:
 * - GET /api/history 404 only. insights UI (master) calls it; bridge route ships in PR #5
 * - dashboard/insights.js|css 404 on file:// only when those assets are not present
 *
 * Any other /api/* 4xx/5xx or dashboard asset failure must fail the test.
 */
function isOptionalInsightsAsset(url) {
  return /\/dashboard\/insights\.(js|css)(?:\?|$)/i.test(url);
}

function isAllowedApiHistory404(url, status) {
  return status === 404 && /\/api\/history(?:\?|#|$)/i.test(url);
}

function attachErrorCollectors(page) {
  const errors = [];
  const failedRequests = [];
  let optionalInsightsFailures = 0;
  let allowedApiHistory404Count = 0;
  const disallowedApiErrors = [];
  let blockingResourceFailed = false;
  const pendingResourceConsole = [];

  page.on("pageerror", (err) => {
    errors.push("pageerror: " + (err && err.message ? err.message : String(err)));
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource/i.test(text)) {
      pendingResourceConsole.push(text);
      return;
    }
    errors.push("console: " + text);
  });

  function maySuppressResourceConsoleError() {
    if (blockingResourceFailed) return false;
    if (disallowedApiErrors.length > 0) return false;
    return optionalInsightsFailures > 0 || allowedApiHistory404Count > 0;
  }

  function flushResourceConsoleErrors() {
    pendingResourceConsole.forEach((text) => {
      if (maySuppressResourceConsoleError()) return;
      errors.push("console: " + text);
    });
    pendingResourceConsole.length = 0;
  }

  function finalizeErrors() {
    flushResourceConsoleErrors();
    disallowedApiErrors.forEach((line) => errors.push("api error: " + line));
  }

  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (status >= 400 && /\/api\//i.test(url)) {
      if (isAllowedApiHistory404(url, status)) {
        allowedApiHistory404Count += 1;
        return;
      }
      disallowedApiErrors.push(url + " · HTTP " + status);
      return;
    }
    if (status === 404 && isOptionalInsightsAsset(url)) {
      optionalInsightsFailures += 1;
      return;
    }
    if (status >= 400 && /\/dashboard\//i.test(url) && !isOptionalInsightsAsset(url)) {
      blockingResourceFailed = true;
    }
  });

  page.on("requestfailed", (req) => {
    const url = req.url();
    const why = (req.failure() && req.failure().errorText) || "";
    if (/\/api\/stream(?:\?|$)/.test(url) && /ERR_ABORTED|ns_binding_aborted/i.test(why)) {
      return;
    }
    if (isOptionalInsightsAsset(url)) {
      optionalInsightsFailures += 1;
      return;
    }
    if (/\/dashboard\/[^?#]+/i.test(url)) {
      blockingResourceFailed = true;
    }
    failedRequests.push(url + " · " + why);
  });

  return { errors, failedRequests, flushResourceConsoleErrors, finalizeErrors };
}

module.exports = {
  attachErrorCollectors,
  isOptionalInsightsAsset,
  isAllowedApiHistory404
};
