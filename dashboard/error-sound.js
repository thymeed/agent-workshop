/**
 * When a row plays the error sound. Pure, no DOM: unit tested in test/unit/error-sound.test.js
 * and, at the real call site, in test/cards-smoke.test.js. Loaded before app.js.
 *
 * Only a Claude Code row the wire marked `failed` (status failed, error or killed, parent or
 * child) plays it. Stopped and cancelled rows are not marked, so they stay silent. Cursor rows
 * never carry `failed`; the Cursor `replayError` rows only exist inside a History replay,
 * which is silent.
 * Nothing plays during a replay: History replay (`ctx.isReplay`), the bridge's silent
 * catch-up (`ev.replay`), the SSE connect backlog (the page's quiet-window flag or the row's
 * own `sseBacklog` mark), or a row already seen live.
 */
(function () {
  "use strict";

  /**
   * @param {{failed?:boolean, replay?:boolean, sseBacklog?:boolean}} ev
   * @param {{isReplay?:boolean, backlog?:boolean, alreadySeen?:boolean}} ctx
   */
  function shouldPlay(ev, ctx) {
    if (!ev) return false;
    ctx = ctx || {};
    if (ctx.isReplay || ctx.backlog || ctx.alreadySeen) return false;
    return ev.failed === true && ev.replay !== true && ev.sseBacklog !== true;
  }

  window.WorkshopErrorSound = { shouldPlay: shouldPlay };
})();
