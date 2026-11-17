/**
 * Data source switch: Cursor or Claude Code. Live mode only. The header seg picks the source,
 * the origin chip shows the source the bridge is reading. The renderer's choice (localStorage
 * `ca.source.v1`, default "cursor") wins: a bridge that reports another source is switched to
 * the choice once per connect. Exposed as window.WorkshopSource.
 */
(function () {
  "use strict";

  var KEY = "ca.source.v1";
  var LABELS = { cursor: "Cursor", "claude-code": "Claude Code" };

  var d = null;
  var chosen = "cursor"; // the stored choice; what the renderer wants the bridge to read
  var current = "cursor"; // what the bridge is reading; drives the buttons, chip and copy
  var switching = false;
  var inLive = true; // false after setVisible(false): a switch that lands in Demo does not restart Live
  var labelSource = null; // source of the last hello/reset label

  function valid(v) {
    return v === "cursor" || v === "claude-code" ? v : null;
  }

  function storage() {
    try {
      return (d && d.storage) || window.localStorage || null;
    } catch (_e) {
      return null;
    }
  }

  function readStored() {
    try {
      var s = storage();
      return (s && valid(s.getItem(KEY))) || "cursor";
    } catch (_e) {
      return "cursor";
    }
  }

  function writeStored(value) {
    try {
      var s = storage();
      if (s) s.setItem(KEY, value);
    } catch (_e) {
      /* storage blocked: the choice lasts for this page only */
    }
  }

  function paintButton(btn, on) {
    if (!btn) return;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    // aria-disabled, not disabled: a disabled button loses keyboard focus. setSource ignores
    // clicks while a switch is in flight.
    btn.setAttribute("aria-disabled", switching ? "true" : "false");
  }

  function paint() {
    if (!d) return;
    paintButton(d.cursorButton, current === "cursor");
    paintButton(d.claudeButton, current === "claude-code");
    if (d.chipValue) d.chipValue.textContent = LABELS[current];
    if (typeof d.onSourceShown === "function") d.onSourceShown(current);
  }

  function showError(msg) {
    if (!d || !d.liveHint) return;
    d.liveHint.hidden = false;
    d.liveHint.className = "live-hint err";
    d.liveHint.textContent = msg;
  }

  /** Show what the bridge reports; never writes the stored choice. */
  function applySource(src) {
    var v = valid(src);
    if (!d || !v) return;
    current = v;
    paint();
  }

  /**
   * POST the target source. On success the target becomes the choice and the bridge's
   * reading, and the stream is restarted through deps.onChanged. On failure the buttons show
   * the previous reading (fallback, when given, or what is current) and the error goes in the
   * live hint, the way project select failures do.
   */
  function send(target, fallback) {
    switching = true;
    paint();
    return fetch(d.bridgeUrl + "/api/source", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Cursor-Bridge": "1" },
      body: JSON.stringify({ source: target })
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!r.ok) {
              return {
                ok: false,
                error: (body && body.error) || "Source switch failed (" + r.status + ")"
              };
            }
            return body;
          });
      })
      .catch(function () {
        return { ok: false, error: "Could not switch source" };
      })
      .then(function (data) {
        switching = false;
        if (data && data.ok) {
          chosen = target;
          writeStored(target);
          applySource(target);
          if (d.onChanged && inLive) d.onChanged(target);
          return { ok: true, source: target };
        }
        var msg = (data && data.error) || "Could not switch source";
        if (fallback) applySource(fallback);
        else paint();
        showError(msg);
        return { ok: false, error: msg };
      });
  }

  /** User pick. Ignored while another switch is in flight. */
  function setSource(next) {
    var target = valid(next);
    if (!d || !target) return Promise.resolve({ ok: false, error: "Unknown source" });
    if (switching) return Promise.resolve({ ok: false, busy: true });
    if (target === chosen && target === current) {
      return Promise.resolve({ ok: true, source: target, unchanged: true });
    }
    return send(target, null);
  }

  /**
   * Called once per SSE hello. If the bridge reports a source other than the stored choice,
   * POST the choice once. No retry: the next connect reconciles again.
   */
  function reconcile(bridgeSource) {
    var reported = valid(bridgeSource);
    if (!d || !reported || switching) return Promise.resolve(null);
    if (reported === chosen) {
      applySource(reported);
      return Promise.resolve(null);
    }
    return send(chosen, reported);
  }

  function setVisible(live) {
    inLive = !!live;
    if (!d) return;
    if (d.group) d.group.hidden = !live;
    if (d.chip) d.chip.hidden = !live;
  }

  function getSource() {
    return current;
  }

  /**
   * Project label and id after a hello or reset. Claude Code takes what the bridge sends,
   * null included (nothing selected). Cursor keeps the last values when the bridge sends none,
   * but never keeps a label that came from Claude Code.
   */
  function projectLabelsFrom(meta, label, id) {
    if (!meta) return { label: label, id: id };
    var src = valid(meta.source);
    if (src === "claude-code") {
      labelSource = src;
      return { label: meta.projectLabel || null, id: meta.projectId || null };
    }
    if (labelSource === "claude-code") {
      label = null;
      id = null;
    }
    if (src) labelSource = src;
    return { label: meta.projectLabel || label, id: meta.projectId || id };
  }

  function init(deps) {
    d = deps || {};
    chosen = readStored();
    current = chosen;
    if (d.cursorButton) {
      d.cursorButton.addEventListener("click", function () {
        setSource("cursor");
      });
    }
    if (d.claudeButton) {
      d.claudeButton.addEventListener("click", function () {
        setSource("claude-code");
      });
    }
    paint();
  }

  window.WorkshopSource = {
    init: init,
    getSource: getSource,
    projectLabelsFrom: projectLabelsFrom,
    setSource: setSource,
    applySource: applySource,
    reconcile: reconcile,
    updateChip: paint,
    setVisible: setVisible
  };
})();
