/**
 * Unified hover/focus tip layer.
 * Markup: data-tip="…" data-tip-detail="…"
 * window.TipLayer.init / show / hide / bind
 *
 * Auto-binds document with pointerover/focusin delegation so dynamically
 * inserted [data-tip] nodes (alerts, cards, insights) work without rebinding.
 */
(function (global) {
  "use strict";

  var SHOW_DELAY_MS = 280;
  var OFFSET = 14;
  var EDGE = 10;

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

  /** Walk up from any node (incl. text) to the nearest [data-tip] with copy. */
  function tipTargetFrom(node) {
    if (!node) return null;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    if (typeof el.closest === "function") {
      var hit = el.closest("[data-tip]");
      if (hit && String(hit.getAttribute("data-tip") || "").trim()) return hit;
      return null;
    }
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute("data-tip")) {
        if (String(el.getAttribute("data-tip") || "").trim()) return el;
      }
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
    pathEl.textContent = tip;
    if (detail) {
      detailEl.hidden = false;
      detailEl.textContent = detail;
    } else {
      detailEl.hidden = true;
      detailEl.textContent = "";
    }
  }

  function hide() {
    clearShowTimer();
    activeEl = null;
    followPointer = false;
    if (host) {
      host.hidden = true;
      host.classList.remove("is-visible");
    }
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

    if (!content.tip || !String(content.tip).trim()) {
      hide();
      return;
    }

    activeEl = el;
    render(content);
    host.hidden = false;
    host.classList.add("is-visible");

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
    if (!el || !el.isConnected) return;
    var tip = el.getAttribute("data-tip");
    if (!tip || !String(tip).trim()) return;

    if (ev && typeof ev.clientX === "number") {
      lastPointer.x = ev.clientX;
      lastPointer.y = ev.clientY;
    }

    showTimer = setTimeout(function () {
      showTimer = null;
      /* Dropped nodes (list re-render) are disconnected — skip stale tips. */
      if (!el.isConnected) return;
      show(
        el,
        ev && typeof ev.clientX === "number"
          ? { clientX: lastPointer.x, clientY: lastPointer.y }
          : null
      );
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
    if (activeEl && !activeEl.isConnected) {
      hide();
      return;
    }
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
    boundRoot.removeEventListener("pointerover", onPointerOverBound, true);
    boundRoot.removeEventListener("pointerout", onPointerOutBound, true);
    boundRoot.removeEventListener("pointermove", onPointerMoveBound, true);
    boundRoot.removeEventListener("focusin", onFocusInBound, true);
    boundRoot.removeEventListener("focusout", onFocusOutBound, true);
    global.removeEventListener("keydown", onKeyDownBound, true);
    global.removeEventListener("scroll", onScrollBound, true);
    boundRoot = null;
  }

  /**
   * Delegated listeners for [data-tip] under root (default: document).
   * Capture-phase pointerover covers nodes inserted later and survives
   * stopPropagation on descendants.
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
    boundRoot.addEventListener("pointerover", onPointerOverBound, true);
    boundRoot.addEventListener("pointerout", onPointerOutBound, true);
    boundRoot.addEventListener("pointermove", onPointerMoveBound, true);
    boundRoot.addEventListener("focusin", onFocusInBound, true);
    boundRoot.addEventListener("focusout", onFocusOutBound, true);
    global.addEventListener("keydown", onKeyDownBound, true);
    global.addEventListener("scroll", onScrollBound, true);
    return api;
  }

  function init(options) {
    options = options || {};
    ensureHost();
    /* Prefer document so every worker’s dynamic data-tip attrs are covered. */
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
