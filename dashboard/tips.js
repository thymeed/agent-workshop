/**
 * Unified hover/focus tip layer.
 * Markup: data-tip="…" data-tip-detail="…"
 * window.TipLayer.init / show / hide / bind
 */
(function (global) {
  "use strict";

  var SHOW_DELAY_MS = 300;
  var OFFSET = 12;
  var EDGE = 8;

  var host = null;
  var pathEl = null;
  var detailEl = null;
  var showTimer = null;
  var activeEl = null;
  var boundRoot = null;
  var ready = false;
  var followPointer = false;
  var lastPointer = { x: 0, y: 0 };

  var onPointerOverBound = null;
  var onPointerOutBound = null;
  var onPointerMoveBound = null;
  var onFocusInBound = null;
  var onFocusOutBound = null;
  var onKeyDownBound = null;
  var onScrollBound = null;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tipTargetFrom(node) {
    if (!node || node.nodeType !== 1) return null;
    if (typeof node.closest === "function") return node.closest("[data-tip]");
    var el = node;
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute("data-tip")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function readTip(el, override) {
    if (override && typeof override === "object" && !override.nodeType) {
      return {
        tip: String(override.tip != null ? override.tip : override.path || ""),
        detail: String(override.detail != null ? override.detail : "")
      };
    }
    if (typeof override === "string") {
      return { tip: override, detail: "" };
    }
    if (!el) return { tip: "", detail: "" };
    return {
      tip: String(el.getAttribute("data-tip") || ""),
      detail: String(el.getAttribute("data-tip-detail") || "")
    };
  }

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.id = "tipLayer";
    host.className = "tip-layer";
    host.setAttribute("role", "tooltip");
    host.hidden = true;
    host.innerHTML = '<div class="tt-path"></div><div class="tt-detail" hidden></div>';
    pathEl = host.querySelector(".tt-path");
    detailEl = host.querySelector(".tt-detail");
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function clearShowTimer() {
    if (showTimer != null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function clampPosition(x, y) {
    var rect = host.getBoundingClientRect();
    var vw = global.innerWidth || document.documentElement.clientWidth || 0;
    var vh = global.innerHeight || document.documentElement.clientHeight || 0;
    var left = x;
    var top = y;
    if (left + rect.width + EDGE > vw) left = Math.max(EDGE, vw - rect.width - EDGE);
    if (top + rect.height + EDGE > vh) top = Math.max(EDGE, y - rect.height - OFFSET);
    if (left < EDGE) left = EDGE;
    if (top < EDGE) top = EDGE;
    return { left: left, top: top };
  }

  function placeAt(clientX, clientY) {
    if (!host) return;
    host.style.left = "0px";
    host.style.top = "0px";
    var pos = clampPosition(clientX + OFFSET, clientY + OFFSET);
    host.style.left = pos.left + "px";
    host.style.top = pos.top + "px";
  }

  function placeForElement(el) {
    if (!host || !el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    placeAt(r.left + r.width / 2 - OFFSET, r.bottom);
  }

  function render(content) {
    ensureHost();
    var tip = content.tip || "";
    var detail = content.detail || "";
    pathEl.innerHTML = escapeHtml(tip);
    if (detail) {
      detailEl.hidden = false;
      detailEl.innerHTML = escapeHtml(detail);
    } else {
      detailEl.hidden = true;
      detailEl.innerHTML = "";
    }
  }

  function hide() {
    clearShowTimer();
    activeEl = null;
    followPointer = false;
    if (host) host.hidden = true;
  }

  /**
   * Show immediately.
   * show(el, event?) | show({ tip, detail }, event?) | show("text", event?)
   */
  function show(targetOrContent, ev) {
    ensureHost();
    clearShowTimer();

    var el = null;
    var content;
    if (targetOrContent && targetOrContent.nodeType === 1) {
      el = targetOrContent;
      content = readTip(el);
    } else {
      content = readTip(null, targetOrContent);
    }

    if (!content.tip) {
      hide();
      return;
    }

    activeEl = el;
    render(content);
    host.hidden = false;

    var hasPointer = ev && typeof ev.clientX === "number" && typeof ev.clientY === "number";
    if (hasPointer) {
      followPointer = true;
      lastPointer.x = ev.clientX;
      lastPointer.y = ev.clientY;
      placeAt(ev.clientX, ev.clientY);
    } else if (el) {
      followPointer = false;
      placeForElement(el);
    } else {
      followPointer = false;
      placeAt(lastPointer.x, lastPointer.y);
    }
  }

  function scheduleShow(el, ev) {
    clearShowTimer();
    if (!el) return;
    var tip = el.getAttribute("data-tip");
    if (!tip) return;

    if (ev && typeof ev.clientX === "number") {
      lastPointer.x = ev.clientX;
      lastPointer.y = ev.clientY;
    }

    showTimer = setTimeout(function () {
      showTimer = null;
      if (!el.isConnected) return;
      show(el, ev && typeof ev.clientX === "number" ? ev : null);
      if (!(ev && typeof ev.clientX === "number")) {
        placeForElement(el);
        followPointer = false;
      }
    }, SHOW_DELAY_MS);
  }

  function onPointerOver(e) {
    var el = tipTargetFrom(e.target);
    if (!el) return;
    if (el === activeEl && host && !host.hidden) {
      followPointer = true;
      return;
    }
    scheduleShow(el, e);
  }

  function onPointerOut(e) {
    var el = tipTargetFrom(e.target);
    if (!el) return;
    var next = tipTargetFrom(e.relatedTarget);
    if (next === el) return;
    if (activeEl === el || showTimer != null) hide();
  }

  function onPointerMove(e) {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    if (!followPointer || !host || host.hidden) return;
    var el = tipTargetFrom(e.target);
    if (activeEl && el !== activeEl && !activeEl.contains(e.target)) return;
    placeAt(e.clientX, e.clientY);
  }

  function onFocusIn(e) {
    var el = tipTargetFrom(e.target);
    if (!el) return;
    scheduleShow(el, null);
  }

  function onFocusOut(e) {
    var el = tipTargetFrom(e.target);
    if (!el) return;
    var next = tipTargetFrom(e.relatedTarget);
    if (next === el) return;
    if (activeEl === el || showTimer != null) hide();
  }

  function onKeyDown(e) {
    if (e.key === "Escape" || e.keyCode === 27) hide();
  }

  function onScroll() {
    if ((host && !host.hidden) || showTimer != null) hide();
  }

  function unbind() {
    if (!boundRoot) return;
    boundRoot.removeEventListener("pointerover", onPointerOverBound, false);
    boundRoot.removeEventListener("pointerout", onPointerOutBound, false);
    boundRoot.removeEventListener("pointermove", onPointerMoveBound, false);
    boundRoot.removeEventListener("focusin", onFocusInBound, false);
    boundRoot.removeEventListener("focusout", onFocusOutBound, false);
    global.removeEventListener("keydown", onKeyDownBound, true);
    global.removeEventListener("scroll", onScrollBound, true);
    boundRoot = null;
  }

  /**
   * Delegated listeners for [data-tip] under root (default: document).
   */
  function bind(root) {
    var next = root || document;
    if (boundRoot === next) return api;
    unbind();

    onPointerOverBound = onPointerOver;
    onPointerOutBound = onPointerOut;
    onPointerMoveBound = onPointerMove;
    onFocusInBound = onFocusIn;
    onFocusOutBound = onFocusOut;
    onKeyDownBound = onKeyDown;
    onScrollBound = onScroll;

    boundRoot = next;
    boundRoot.addEventListener("pointerover", onPointerOverBound, false);
    boundRoot.addEventListener("pointerout", onPointerOutBound, false);
    boundRoot.addEventListener("pointermove", onPointerMoveBound, false);
    boundRoot.addEventListener("focusin", onFocusInBound, false);
    boundRoot.addEventListener("focusout", onFocusOutBound, false);
    global.addEventListener("keydown", onKeyDownBound, true);
    global.addEventListener("scroll", onScrollBound, true);
    return api;
  }

  function init(options) {
    options = options || {};
    ensureHost();
    bind(options.root || document);
    ready = true;
    return api;
  }

  var api = {
    init: init,
    show: show,
    hide: hide,
    bind: bind,
    isReady: function () {
      return ready;
    }
  };

  global.TipLayer = api;

  function autoInit() {
    if (ready) return;
    if (!document.body) return;
    init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})(typeof window !== "undefined" ? window : globalThis);
