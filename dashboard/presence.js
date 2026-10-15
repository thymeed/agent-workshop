/**
 * Live presence: the single source of truth for the header hint, stage banner, coach
 * sheet, and empty-log copy, plus the bridge sync-age chip and its poll. Owns the
 * presence value, the quiet-healthy timer, the last-event clock, and the sync metadata.
 * Exposed as window.WorkshopPresence.
 */
(function () {
  "use strict";

  var d = null;
  var presence = null;
  /** True once we have entered bridge-down, until we reach a healthy state again. */
  var wasDown = false;
  var quietTimer = null;
  var lastEventAt = 0;
  var lastScanAt = null;
  var pollMs = 900;
  var pollTimer = null;
  var ONBOARD_KEY = "ca.liveOnboard.v1";
  var QUIET_AFTER_MS = 45000;

  function init(deps) {
    d = deps || {};
  }

  function getPresence() {
    return presence;
  }

  function getLastEventAt() {
    return lastEventAt;
  }

  /** Record live traffic. Drives quiet-healthy scheduling and the project-picker recovery. */
  function noteLiveEvent() {
    lastEventAt = Date.now();
  }

  function hasSeenOnboard() {
    try {
      return localStorage.getItem(ONBOARD_KEY) === "1";
    } catch (_e) {
      return true;
    }
  }

  function markOnboardSeen() {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch (_e) {
      /* storage unavailable */
    }
  }

  function setCoachVisible(show) {
    if (!d.liveCoach) return;
    d.liveCoach.hidden = !show;
  }

  function maybeShowCoach() {
    if (d.getMode() !== "live") {
      setCoachVisible(false);
      return;
    }
    if (presence === "file-origin" || presence === "bridge-down") {
      setCoachVisible(false);
      return;
    }
    setCoachVisible(!hasSeenOnboard());
  }

  function clearQuietTimer() {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
  }

  function scheduleQuietHealthy() {
    clearQuietTimer();
    if (d.getMode() !== "live") return;
    if (
      presence === "bridge-down" ||
      presence === "file-origin" ||
      presence === "connecting" ||
      presence === "no-projects"
    ) {
      return;
    }
    quietTimer = setTimeout(function () {
      quietTimer = null;
      if (d.getMode() !== "live") return;
      if (!d.isBridgeConnected()) return;
      if (presence === "no-projects") return;
      setLivePresence("quiet-healthy");
    }, QUIET_AFTER_MS);
  }

  function hintLabel() {
    return d.getProjectLabel() || "agent-transcripts";
  }

  function refreshEmptyLogIfIdle() {
    if (!d.sessionLog) return;
    if (d.sessionLog.querySelector(".log-line")) return;
    d.refreshEmptyLog();
  }

  /** Single source of truth for the Live hint, stage banner, and empty-log copy. */
  function setLivePresence(state, detail) {
    var previous = presence;
    presence = state || null;
    if (d.getMode() === "live") {
      /* Cue on entry to bridge-down, and once on recovery to a healthy state. A retry
         passes through "connecting" on the way back up, so the recovery cue cannot key
         off the immediately-previous state. */
      if (state === "bridge-down") {
        if (previous !== "bridge-down") {
          d.sound.play("bridgeDown");
          wasDown = true;
        }
      } else if (state === "streaming" || state === "quiet-healthy") {
        if (wasDown) d.sound.play("bridgeUp");
        wasDown = false;
      } else if (state === "file-origin" || state === "no-projects") {
        /* Settled somewhere else; not a recovery, and no longer pending one. */
        wasDown = false;
      }
      /* "connecting" is transient during a retry, so it leaves the flag alone. */
    }
    if (d.appEl) {
      if (d.getMode() === "live" && presence) d.appEl.setAttribute("data-live-presence", presence);
      else d.appEl.removeAttribute("data-live-presence");
    }

    if (d.getMode() !== "live") {
      if (d.livePresenceBanner) {
        d.livePresenceBanner.hidden = true;
        d.livePresenceBanner.textContent = "";
        d.livePresenceBanner.className = "live-presence-banner";
      }
      setCoachVisible(false);
      return;
    }

    var hint = d.liveHint;
    var banner = d.livePresenceBanner;
    var label = hintLabel();
    var bannerText = "";
    var bannerClass = "live-presence-banner";
    var showBanner = false;

    if (state === "file-origin") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent =
          detail ||
          "Live needs the bridge. Open " + d.bridgeUrl.replace(/\/$/, "") + "/ (or run npm start)";
      }
      bannerText =
        "Open Electron (npm start) or " +
        d.bridgeUrl.replace(/\/$/, "") +
        ". file:// pages cannot stream Live.";
      bannerClass += " file-origin";
      showBanner = true;
    } else if (state === "connecting") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint";
        hint.textContent = detail || "Connecting to " + d.bridgeUrl + "…";
      }
      bannerText = "Connecting to the Live bridge…";
      bannerClass += " connecting";
      showBanner = true;
    } else if (state === "bridge-down") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent = detail || "Bridge offline. Use npm start or node live-bridge.js";
      }
      /* When a detail is supplied it describes the retry, so do not also tell the user
         to click Reconnect - that contradicts the automatic retry that is running. */
      bannerText = detail
        ? "Bridge offline · " + detail
        : "Bridge offline · stations may look idle. Start the bridge, then click Reconnect.";
      bannerClass += " bridge-down";
      showBanner = true;
    } else if (state === "no-projects") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint err";
        hint.textContent = detail || "Connected · no Cursor projects found";
      }
      bannerText =
        "No Cursor projects found under agent-transcripts. Open a project in Cursor, then Reconnect.";
      bannerClass += " no-projects";
      showBanner = true;
    } else if (state === "quiet-healthy") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint quiet";
        hint.textContent = "Quiet · waiting for transcript activity · " + label;
      }
      bannerText = "Workshop idle · bridge online, waiting for transcript activity.";
      bannerClass += " quiet-healthy";
      showBanner = true;
    } else if (state === "streaming") {
      if (hint) {
        hint.hidden = false;
        hint.className = "live-hint ok";
        hint.textContent = "Streaming · " + label;
      }
      showBanner = false;
    }

    if (banner) {
      banner.className = bannerClass;
      banner.textContent = bannerText;
      banner.hidden = !showBanner;
    }

    refreshEmptyLogIfIdle();
    maybeShowCoach();
  }

  /** Age of a bridge scan, in the dashboard's short form. */
  function formatSyncAge(iso) {
    if (!iso) return "n/a";
    var t = Date.parse(iso);
    if (!isFinite(t)) return "n/a";
    var sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 1) return "just now";
    if (sec < 60) return sec + "s ago";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    return Math.floor(min / 60) + "h ago";
  }

  function refreshSyncAgeChip() {
    if (!d.hudSyncAge) return;
    var chip = d.hudSyncAge.closest(".hud-chip");
    if (d.getMode() !== "live") {
      lastScanAt = null;
      d.hudSyncAge.textContent = "n/a";
      if (chip) {
        chip.classList.remove("stale");
        chip.setAttribute("title", "Sync age · Live mode only (Demo has no bridge poll)");
      }
      return;
    }
    d.hudSyncAge.textContent = formatSyncAge(lastScanAt);
    if (chip) {
      var ageMs = lastScanAt ? Date.now() - Date.parse(lastScanAt) : NaN;
      var stale = !lastScanAt || !isFinite(ageMs) || ageMs > Math.max(5000, pollMs * 6);
      chip.classList.toggle("stale", stale);
      chip.setAttribute(
        "title",
        "Near-real file polling (~" +
          pollMs +
          "ms) · last bridge transcript scan (not hook-level realtime)"
      );
    }
  }

  function applyBridgeSyncMeta(meta) {
    if (!meta) return;
    if (meta.lastScanAt) lastScanAt = meta.lastScanAt;
    if (meta.pollMs != null && isFinite(Number(meta.pollMs))) pollMs = Number(meta.pollMs);
    refreshSyncAgeChip();
  }

  function pollBridgeStatusOnce() {
    if (d.getMode() !== "live" || location.protocol === "file:") return;
    fetch(d.bridgeUrl + "/api/status", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (body) {
        if (body && body.ok) applyBridgeSyncMeta(body);
      })
      .catch(function () {});
  }

  function startSyncAgePoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollBridgeStatusOnce();
    pollTimer = setInterval(function () {
      pollBridgeStatusOnce();
      refreshSyncAgeChip();
    }, 1000);
  }

  function stopSyncAgePoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  window.WorkshopPresence = {
    init: init,
    QUIET_AFTER_MS: QUIET_AFTER_MS,
    getPresence: getPresence,
    setLivePresence: setLivePresence,
    getLastEventAt: getLastEventAt,
    noteLiveEvent: noteLiveEvent,
    hasSeenOnboard: hasSeenOnboard,
    markOnboardSeen: markOnboardSeen,
    setCoachVisible: setCoachVisible,
    maybeShowCoach: maybeShowCoach,
    scheduleQuietHealthy: scheduleQuietHealthy,
    clearQuietTimer: clearQuietTimer,
    hintLabel: hintLabel,
    refreshEmptyLogIfIdle: refreshEmptyLogIfIdle,
    formatSyncAge: formatSyncAge,
    refreshSyncAgeChip: refreshSyncAgeChip,
    applyBridgeSyncMeta: applyBridgeSyncMeta,
    pollBridgeStatusOnce: pollBridgeStatusOnce,
    startSyncAgePoll: startSyncAgePoll,
    stopSyncAgePoll: stopSyncAgePoll
  };
})();
