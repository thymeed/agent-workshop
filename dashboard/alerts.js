/**
 * In-app alert center — SSE `alert` + GET /api/alerts.
 * window.AlertCenter.init / attachEventSource / hydrate / push
 */
(function (global) {
  "use strict";

  var CAP = 50;
  var SNOOZE_MS = 15 * 60 * 1000;
  var SNOOZE_KEY = "ca.alerts.snoozeUntil";
  var READ_KEY = "ca.alerts.readIds";

  var opts = {};
  var items = [];
  var open = false;
  var bell = null;
  var badge = null;
  var popover = null;
  var listEl = null;
  var emptyEl = null;
  var attachedEs = null;
  var onAlertBound = null;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadReadIds() {
    try {
      var raw = localStorage.getItem(READ_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return {};
      var map = {};
      arr.forEach(function (id) {
        map[String(id)] = true;
      });
      return map;
    } catch (_) {
      return {};
    }
  }

  function saveReadIds(map) {
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(Object.keys(map)));
    } catch (_) {}
  }

  function snoozeUntil() {
    try {
      var n = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      return isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  function isSnoozed() {
    return Date.now() < snoozeUntil();
  }

  function setSnooze(ms) {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + (ms || SNOOZE_MS)));
    } catch (_) {}
  }

  function isQuiet() {
    return typeof opts.isQuiet === "function" && !!opts.isQuiet();
  }

  function unreadCount() {
    if (isSnoozed()) return 0;
    var n = 0;
    items.forEach(function (it) {
      if (!it.read) n++;
    });
    return n;
  }

  function statusLabel(status) {
    var s = String(status || "").toLowerCase();
    if (s === "finished") return "finished";
    if (s === "error") return "error";
    if (s === "stalled") return "stalled";
    return s || "alert";
  }

  function formatTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (!isFinite(d.getTime())) return String(ts);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function renderBadge() {
    if (!badge) return;
    var n = unreadCount();
    if (n <= 0) {
      badge.hidden = true;
      badge.textContent = "0";
      if (bell) bell.classList.remove("has-unread");
      return;
    }
    badge.hidden = false;
    badge.textContent = n > 99 ? "99+" : String(n);
    if (bell) bell.classList.add("has-unread");
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!items.length) {
      if (emptyEl) emptyEl.hidden = false;
      renderBadge();
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = "alert-item" + (it.read ? " read" : " unread");
      li.setAttribute("data-alert-id", String(it.id));
      if (it.agentId) li.setAttribute("data-agent-id", it.agentId);
      li.setAttribute("tabindex", "0");
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", statusLabel(it.status) + " · " + (it.name || "agent"));
      li.setAttribute("data-tip", it.name || "agent");
      li.setAttribute(
        "data-tip-detail",
        statusLabel(it.status) + (it.agentId ? " · jump to station" : "")
      );
      li.innerHTML =
        '<span class="alert-status alert-status-' +
        escapeHtml(statusLabel(it.status)) +
        '">' +
        escapeHtml(statusLabel(it.status)) +
        "</span>" +
        '<span class="alert-name">' +
        escapeHtml(it.name || "agent") +
        "</span>" +
        '<span class="alert-ts">' +
        escapeHtml(formatTs(it.ts)) +
        "</span>";
      listEl.appendChild(li);
    });
    renderBadge();
  }

  function markReadIds(ids) {
    var map = loadReadIds();
    (ids || []).forEach(function (id) {
      map[String(id)] = true;
    });
    saveReadIds(map);
    items.forEach(function (it) {
      if (map[String(it.id)]) it.read = true;
    });
    renderList();
  }

  function markAllRead() {
    markReadIds(
      items.map(function (it) {
        return it.id;
      })
    );
  }

  function clearAll() {
    items = [];
    try {
      localStorage.removeItem(READ_KEY);
    } catch (_) {}
    renderList();
    setOpen(false);
  }

  function push(alert, fromHydrate) {
    if (!alert || alert.id == null) return;
    var id = alert.id;
    var existing = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        existing = items[i];
        break;
      }
    }
    var readMap = loadReadIds();
    var quiet = !fromHydrate && isQuiet();
    var read = !!readMap[String(id)] || quiet || !!fromHydrate;
    if (existing) {
      existing.ts = alert.ts || existing.ts;
      existing.name = alert.name || existing.name;
      existing.status = alert.status || existing.status;
      if (alert.agentId) existing.agentId = alert.agentId;
      if (!quiet && !fromHydrate) existing.read = false;
      renderList();
      return;
    }
    items.unshift({
      id: id,
      ts: alert.ts || new Date().toISOString(),
      name: String(alert.name || "agent"),
      status: String(alert.status || ""),
      agentId: alert.agentId ? String(alert.agentId) : "",
      read: read
    });
    if (read) {
      readMap[String(id)] = true;
      saveReadIds(readMap);
    }
    if (items.length > CAP) items.length = CAP;
    renderList();
  }

  function setOpen(next) {
    open = !!next;
    if (popover) popover.hidden = !open;
    if (bell) {
      bell.setAttribute("aria-expanded", open ? "true" : "false");
      bell.classList.toggle("open", open);
    }
  }

  function toggleOpen() {
    setOpen(!open);
  }

  function onItemActivate(it) {
    if (!it) return;
    markReadIds([it.id]);
    if (typeof opts.onJump === "function") {
      opts.onJump({
        agentId: it.agentId || undefined,
        name: it.name,
        status: it.status
      });
    }
    setOpen(false);
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].id) === String(id)) return items[i];
    }
    return null;
  }

  function attachEventSource(es) {
    if (attachedEs && onAlertBound) {
      try {
        attachedEs.removeEventListener("alert", onAlertBound);
      } catch (_) {}
    }
    attachedEs = es || null;
    onAlertBound = null;
    if (!es) return;
    onAlertBound = function (msg) {
      try {
        push(JSON.parse(msg.data), false);
      } catch (_) {}
    };
    es.addEventListener("alert", onAlertBound);
  }

  function hydrate(bridgeBase) {
    var base = bridgeBase || opts.bridge || "";
    if (!base) return Promise.resolve([]);
    return fetch(base + "/api/alerts", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("alerts " + r.status);
        return r.json();
      })
      .then(function (data) {
        var list = (data && data.alerts) || [];
        list.forEach(function (a) {
          push(a, true);
        });
        return list;
      })
      .catch(function () {
        return [];
      });
  }

  function onDocClick(e) {
    if (!open) return;
    var t = e.target;
    if (bell && (bell === t || bell.contains(t))) return;
    if (popover && (popover === t || popover.contains(t))) return;
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === "Escape" || e.keyCode === 27) setOpen(false);
  }

  function init(options) {
    opts = options || {};
    bell = document.getElementById("alertBell");
    badge = document.getElementById("alertBadge");
    popover = document.getElementById("alertPopover");
    listEl = document.getElementById("alertList");
    emptyEl = document.getElementById("alertEmpty");

    if (bell) {
      bell.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleOpen();
      });
    }
    var markBtn = document.getElementById("alertMarkRead");
    if (markBtn) markBtn.addEventListener("click", markAllRead);
    var snoozeBtn = document.getElementById("alertSnooze");
    if (snoozeBtn) {
      snoozeBtn.addEventListener("click", function () {
        setSnooze(SNOOZE_MS);
        markAllRead();
        renderBadge();
        setOpen(false);
      });
    }
    var clearBtn = document.getElementById("alertClear");
    if (clearBtn) clearBtn.addEventListener("click", clearAll);

    if (listEl) {
      listEl.addEventListener("click", function (e) {
        var li = e.target && e.target.closest ? e.target.closest(".alert-item") : null;
        if (!li) return;
        onItemActivate(findItem(li.getAttribute("data-alert-id")));
      });
      listEl.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var li = e.target && e.target.closest ? e.target.closest(".alert-item") : null;
        if (!li) return;
        e.preventDefault();
        onItemActivate(findItem(li.getAttribute("data-alert-id")));
      });
    }

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    renderList();
    return api;
  }

  var api = {
    init: init,
    push: push,
    hydrate: hydrate,
    attachEventSource: attachEventSource,
    markAllRead: markAllRead,
    clear: clearAll,
    snooze: function (ms) {
      setSnooze(ms || SNOOZE_MS);
      renderBadge();
    },
    setOpen: setOpen,
    getItems: function () {
      return items.slice();
    },
    unreadCount: unreadCount
  };

  global.AlertCenter = api;
})(typeof window !== "undefined" ? window : globalThis);
