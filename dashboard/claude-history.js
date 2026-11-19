/**
 * Claude Code History: the older sessions of the selected project (last 14 days) in the
 * History sheet, replayed through the existing Insights replay transport and stage.
 * Loaded after insights.js; exposes window.ClaudeHistory. DOM and bridge access arrive through
 * create(deps), so the logic is unit tested without a browser.
 *
 * Privacy: the bridge sends opaque session ids, times and path-free events. A session id only
 * goes into an option's value, never into visible text; a label is a local time, an event
 * count and a duration. Option and status text are set as text, never as markup.
 */
(function (global) {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function parseMs(iso) {
    if (typeof iso !== "string" || !iso) return NaN;
    return Date.parse(iso);
  }

  /** "Nov 18, 3:12 PM" in the local time zone (fixed English, so it never depends on the ICU build). */
  function formatWhen(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var mins = d.getMinutes();
    return (
      MONTHS[d.getMonth()] +
      " " +
      d.getDate() +
      ", " +
      (h % 12 === 0 ? 12 : h % 12) +
      ":" +
      (mins < 10 ? "0" : "") +
      mins +
      " " +
      (h < 12 ? "AM" : "PM")
    );
  }

  /** "0 min", "8 min", "1 h", "1 h 5 min". */
  function formatDuration(ms) {
    var total = Math.floor(ms / 60000);
    if (total < 60) return total + " min";
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h + " h" + (m ? " " + m + " min" : "");
  }

  /** Count and first/last time of a loaded session's events (times only when the events carry them). */
  function describeEvents(events) {
    var list = Array.isArray(events) ? events : [];
    var first = NaN;
    var last = NaN;
    for (var i = 0; i < list.length; i++) {
      var t = list[i] ? parseMs(list[i].iso) : NaN;
      if (!isFinite(t)) continue;
      if (!isFinite(first) || t < first) first = t;
      if (!isFinite(last) || t > last) last = t;
    }
    return { count: list.length, startMs: first, endMs: last };
  }

  /**
   * Picker label of one listed session: local time, event count (once known), duration (when
   * both ends are known). `loaded` is describeEvents() of the session after it was opened.
   * Never carries a prompt, path, folder, file name or the opaque id.
   */
  function formatLabel(session, loaded) {
    var s = session || {};
    var start = parseMs(s.startedAt);
    var end = parseMs(s.lastAt);
    var count = typeof s.events === "number" && s.events >= 0 ? s.events : null;
    if (loaded && typeof loaded.count === "number") {
      count = loaded.count;
      // the list's own times win; the opened session's events fill in what the list lacked
      if (!isFinite(start) && !isFinite(end) && isFinite(loaded.startMs)) {
        start = loaded.startMs;
        end = loaded.endMs;
      }
    }
    var when = isFinite(start) ? start : end;
    if (!isFinite(when)) return count === null ? "Session" : "Session · " + countText(count);
    var parts = [formatWhen(when)];
    if (count !== null) parts.push(countText(count));
    if (isFinite(start) && isFinite(end) && end >= start) parts.push(formatDuration(end - start));
    return parts.join(" · ");
  }

  function countText(n) {
    return n + (n === 1 ? " event" : " events");
  }

  /** The panel's own copy of a session event: tree id, name and model for the replay lines. */
  function decorate(ev) {
    var out = Object.assign({}, ev);
    var source = typeof ev.source === "string" && ev.source ? ev.source : "session";
    out.agentId = source;
    out.name = String(ev.role || "parent");
    out.model = ev.modelLabel || ev.modelRaw || "";
    out.parentId = source === "session" ? null : "session";
    return out;
  }

  function defaultFetchJson(base) {
    return function (path) {
      return fetch(base + path, { cache: "no-store" }).then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { status: r.status, body: body };
          });
      });
    };
  }

  /**
   * @param {object} deps
   *   els {wrap, select, status}, getMode(), getSource(), getPanel(), isHistoryOpen(),
   *   fetchJson(path) -> Promise<{status, body}> (default: fetch on deps.bridgeUrl)
   */
  function create(deps) {
    var els = deps.els;
    var fetchJson = deps.fetchJson || defaultFetchJson(deps.bridgeUrl || "");
    var listGen = 0; // a newer list request (or a reset) makes older answers stale
    var loadGen = 0; // same for session loads
    var hasReplay = false;
    var lastKey = null; // the page state sync() last acted on
    var sessions = [];
    var loaded = {}; // id -> describeEvents() of the sessions opened so far

    function active() {
      return deps.getMode() === "live" && deps.getSource() === "claude-code";
    }

    function setStatus(msg) {
      els.status.textContent = msg || "";
    }

    function addOption(value, text, disabled) {
      var o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      if (disabled) o.disabled = true;
      els.select.appendChild(o);
    }

    /** Claude Code wording for an empty replay tree (null puts the Cursor wording back). */
    function setEmptyCopy(text) {
      var panel = deps.getPanel && deps.getPanel();
      if (panel && typeof panel.setReplayEmptyText === "function") panel.setReplayEmptyText(text);
    }

    function dropReplay() {
      loadGen += 1;
      if (!hasReplay) return;
      hasReplay = false;
      if (typeof deps.onReplayDropped === "function") deps.onReplayDropped();
      var panel = deps.getPanel && deps.getPanel();
      if (panel && typeof panel.setReplayEvents === "function") panel.setReplayEvents(null);
    }

    function fillList(keepId) {
      els.select.textContent = "";
      addOption("", "Choose a session…", false);
      sessions.forEach(function (s) {
        addOption(s.id, formatLabel(s, loaded[s.id]), false);
      });
      els.select.value = keepId || "";
    }

    function clearList(text) {
      sessions = [];
      els.select.textContent = "";
      addOption("", text, true);
      els.select.value = "";
      els.select.disabled = true;
    }

    /** Back to nothing: no list, no replay (Cursor, Demo, or a source or project switch away). */
    function reset() {
      listGen += 1;
      dropReplay();
      sessions = [];
      loaded = {};
      els.wrap.hidden = true;
      els.select.textContent = "";
      setStatus("");
      setEmptyCopy(null);
    }

    /** Load the list of older sessions. opts.keep keeps an open session that is still listed. */
    function refresh(opts) {
      if (!active()) {
        reset();
        return Promise.resolve();
      }
      var keepId = opts && opts.keep && els.select.value ? els.select.value : "";
      var g = (listGen += 1);
      if (!keepId) dropReplay();
      els.wrap.hidden = false;
      clearList("Loading sessions…");
      setStatus("Loading sessions…");
      return fetchJson("/api/claude/sessions").then(
        function (res) {
          if (g !== listGen) return;
          var body = (res && res.body) || {};
          if (res.status === 409) {
            if (keepId) dropReplay();
            clearList("No project selected");
            setStatus("Pick a project to see its older sessions.");
            return;
          }
          if (res.status !== 200 || !Array.isArray(body.sessions)) {
            if (keepId) dropReplay();
            clearList("Sessions unavailable");
            setStatus("The sessions could not be listed.");
            return;
          }
          els.select.disabled = false;
          sessions = body.sessions.filter(function (s) {
            return s && typeof s.id === "string";
          });
          if (!sessions.length) {
            if (keepId) dropReplay();
            clearList("No sessions");
            setStatus("No sessions in the last 14 days.");
            return;
          }
          var stillThere = sessions.some(function (s) {
            return s.id === keepId;
          });
          if (keepId && !stillThere) dropReplay();
          fillList(stillThere ? keepId : "");
          setStatus(
            sessions.length +
              (sessions.length === 1 ? " session" : " sessions") +
              " from the last 14 days" +
              (body.truncated ? " (the list was cut short)" : "")
          );
        },
        function () {
          if (g !== listGen) return;
          if (keepId) dropReplay();
          clearList("Sessions unavailable");
          setStatus("Could not reach the bridge.");
        }
      );
    }

    /** Open one listed session (an empty id drops the replay). */
    function load(id) {
      if (!active()) {
        reset();
        return Promise.resolve();
      }
      if (!id) {
        dropReplay();
        setStatus("");
        return Promise.resolve();
      }
      loadGen += 1;
      var g = loadGen;
      setStatus("Loading session…");
      /* A list refresh alone does not invalidate this answer: every path that really drops the
         replay (source, project or picker change) bumps loadGen through dropReplay(). */
      function stale() {
        return g !== loadGen;
      }
      function failed(msg) {
        dropReplay();
        els.select.value = "";
        setStatus(msg);
      }
      return fetchJson("/api/claude/session?id=" + encodeURIComponent(id)).then(
        function (res) {
          if (stale()) return;
          var body = (res && res.body) || {};
          if (res.status === 200 && Array.isArray(body.events)) {
            var events = body.events.map(decorate);
            var info = describeEvents(body.events);
            loaded[id] = info;
            var panel = deps.getPanel && deps.getPanel();
            if (!panel || typeof panel.setReplayEvents !== "function") {
              failed("The replay is not ready.");
              return;
            }
            hasReplay = true;
            fillList(id);
            panel.setReplayEvents(events);
            setStatus(
              (events.length ? countText(events.length) : "No events in this session") +
                (body.truncated
                  ? " · this session was cut at the size limits, so the replay is partial"
                  : "")
            );
            return;
          }
          if (res.status === 400) {
            failed("That session is no longer listed. Reloading the list…");
            return refresh();
          }
          if (res.status === 409) {
            failed("Pick a project to replay its sessions.");
            return;
          }
          failed("That session could not be read.");
        },
        function () {
          if (stale()) return;
          failed("Could not load the session.");
        }
      );
    }

    if (els.select && typeof els.select.addEventListener === "function") {
      els.select.addEventListener("change", function () {
        load(els.select.value);
      });
    }

    return {
      /**
       * A source, mode or project change: forget everything, list again when History is open.
       * A key (mode, source, project) equal to the last one is a repeat and does nothing.
       */
      sync: function (key) {
        if (key !== undefined && key === lastKey) return Promise.resolve();
        lastKey = key === undefined ? null : key;
        if (!active()) {
          reset();
          return Promise.resolve();
        }
        listGen += 1;
        dropReplay();
        loaded = {};
        els.wrap.hidden = false;
        setEmptyCopy("Choose a session above to replay it.");
        if (deps.isHistoryOpen && deps.isHistoryOpen()) return refresh();
        clearList("Open History to list sessions");
        els.select.disabled = false;
        return Promise.resolve();
      },
      /** History was opened: list again, keeping an open session that is still there. */
      onHistoryOpen: function () {
        return refresh({ keep: true });
      },
      refresh: refresh,
      load: load,
      reset: reset
    };
  }

  global.ClaudeHistory = {
    create: create,
    formatLabel: formatLabel,
    formatWhen: formatWhen,
    formatDuration: formatDuration,
    describeEvents: describeEvents,
    decorate: decorate
  };
})(typeof window !== "undefined" ? window : globalThis);
