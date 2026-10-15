/**
 * Activity drawer, Session Log, and their empty states. Owns its own row list, log
 * sequence, and role filter; loaded before app.js and exposed as window.WorkshopActivity.
 * All DOM and session dependencies arrive through init(deps).
 */
(function () {
  "use strict";

  var d = null;
  var items = [];
  var seq = 0;
  var filter = null;
  var logEmptyEl = null;

  function init(deps) {
    d = deps || {};
    if (d.sessionLog && typeof d.sessionLog.innerHTML === "string") {
      logEmptyEl = document.getElementById("logEmpty");
    }
  }

  /** Bucket a transcript tool kind into the two drawer columns. */
  function activityKindBucket(kind) {
    var k = String(kind || "").toLowerCase();
    if (k === "edit" || k === "edited" || k === "write" || k === "strreplace") return "edit";
    if (k === "read" || k === "search" || k === "grep" || k === "glob" || k === "webfetch")
      return "read";
    if (k === "run") return "edit";
    return "read";
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function clockLabel(index) {
    var sec = Math.floor(index * ((d.stepMs || 1500) / 1000));
    return "00:" + pad2(Math.min(59, sec));
  }

  function emptyColumn(host, id, text) {
    if (!host) return;
    host.innerHTML = "";
    var el = document.createElement("div");
    el.className = "activity-empty";
    el.id = id;
    el.textContent = text;
    host.appendChild(el);
  }

  function clear() {
    items = [];
    emptyColumn(d.activityRead, "activityReadEmpty", "No reads yet…");
    emptyColumn(d.activityEdit, "activityEditEmpty", "No edits yet…");
  }

  function append(item, timeStr) {
    if (!item) return;
    var role = item.role || "parent";
    var path = item.path || "n/a";
    var entry = {
      kind: activityKindBucket(item.kind),
      role: role,
      path: path,
      detail: item.detail || "",
      t: timeStr || clockLabel(seq)
    };
    items.unshift(entry);
    if (items.length > (d.cap || 40)) items.length = d.cap || 40;
    if (typeof d.noteSensitivePath === "function") {
      d.noteSensitivePath(role === "parent" ? "opus" : role, path);
    }
    render();
    if (typeof d.spawnCrate === "function") d.spawnCrate(entry);
  }

  /** Activity drawer column. `body` and `detail` come from transcripts; always escaped. */
  function appendLog(role, message, msgClass, timeStr) {
    if (!d.sessionLog) return;
    if (logEmptyEl && logEmptyEl.parentNode) {
      logEmptyEl.parentNode.removeChild(logEmptyEl);
      logEmptyEl = null;
    }
    seq += 1;
    var line = document.createElement("div");
    line.className = "log-line role-" + role;
    line.innerHTML =
      '<span class="t">' +
      d.escapeHtml(timeStr || clockLabel(seq - 1)) +
      "</span>" +
      '<span class="role">' +
      d.escapeHtml(role) +
      "</span>" +
      '<span class="msg' +
      (msgClass ? " " + msgClass : "") +
      '">' +
      d.escapeHtml(message) +
      "</span>";
    d.sessionLog.appendChild(line);
    d.sessionLog.scrollTop = d.sessionLog.scrollHeight;
  }

  function paintColumn(list, host, fallback) {
    if (!host) return;
    host.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "activity-empty";
      empty.textContent = filter
        ? "No " + (d.roleLabel[filter] || filter) + " activity yet…"
        : fallback;
      host.appendChild(empty);
      return;
    }
    list.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "activity-row role-" + a.role;
      row.innerHTML =
        '<span class="t">' +
        d.escapeHtml(a.t) +
        "</span>" +
        '<span class="role">' +
        d.escapeHtml(a.role) +
        "</span>" +
        '<span class="body"><div class="path">' +
        d.escapeHtml(a.path) +
        "</div>" +
        (a.detail ? '<div class="detail">' + d.escapeHtml(a.detail) + "</div>" : "") +
        "</span>";
      host.appendChild(row);
    });
  }

  function render() {
    if (!d.activityRead || !d.activityEdit) return;
    var visible = filter
      ? items.filter(function (a) {
          return (a.role === "parent" ? "opus" : a.role) === filter;
        })
      : items;
    paintColumn(
      visible.filter(function (a) {
        return a.kind === "read";
      }),
      d.activityRead,
      "No reads yet…"
    );
    paintColumn(
      visible.filter(function (a) {
        return a.kind === "edit";
      }),
      d.activityEdit,
      "No edits yet…"
    );
  }

  function setFilter(role) {
    filter = role || null;
    render();
  }

  function emptyLogMessage() {
    if (d.getMode() !== "live") return "Waiting for session… choose Demo · Play or Live.";
    var presence = d.getLivePresence();
    if (presence === "file-origin") {
      return "Live needs the bridge. Open via npm start or http://127.0.0.1…";
    }
    if (presence === "bridge-down") {
      return "Bridge offline · click Reconnect after starting the bridge.";
    }
    if (presence === "no-projects") {
      return "No Cursor projects found · open a project in Cursor, then Reconnect.";
    }
    if (presence === "connecting") return "Connecting to the Live bridge…";
    if (presence === "quiet-healthy") return "Workshop idle · waiting for transcript activity…";
    return "Live mode · waiting for transcript events from the bridge…";
  }

  /** Reset the log clock and the role filter. Does not touch the DOM. */
  function resetSeq() {
    seq = 0;
    filter = null;
  }

  /** Replace the Session Log with its empty state (and, implicitly, clear the log). */
  function resetLogEmpty(text) {
    if (!d.sessionLog) return;
    d.sessionLog.innerHTML = "";
    logEmptyEl = document.createElement("div");
    logEmptyEl.className = "log-empty";
    logEmptyEl.id = "logEmpty";
    logEmptyEl.textContent = text == null ? emptyLogMessage() : text;
    d.sessionLog.appendChild(logEmptyEl);
  }

  /** Refresh the existing empty-state copy in place, if one is showing. */
  function refreshEmptyLog() {
    var el = document.getElementById("logEmpty") || logEmptyEl;
    if (el) el.textContent = emptyLogMessage();
  }

  window.WorkshopActivity = {
    init: init,
    append: append,
    appendLog: appendLog,
    render: render,
    clear: clear,
    setFilter: setFilter,
    activityKindBucket: activityKindBucket,
    emptyLogMessage: emptyLogMessage,
    resetSeq: resetSeq,
    resetLogEmpty: resetLogEmpty,
    refreshEmptyLog: refreshEmptyLog,
    getItems: function () {
      return items;
    }
  };
})();
