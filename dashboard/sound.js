/**
 * Workshop audio. Synthesized Web Audio cues (no assets), muted by default.
 * Signal path: per-cue gain -> master gain -> limiter -> destination, so overlapping
 * cues (legendary ship arpeggio) cannot clip. Loaded before app.js; exposes window.WorkshopSound.
 */
(function () {
  "use strict";

  var MUTE_KEY = "workshopSound";
  var VOLUME_KEY = "workshopVolume";
  var SNOOZE_KEY = "ca.alerts.snoozeUntil";
  var SNOOZE_INDEFINITE = "indefinite";

  var MASTER_TRIM = 0.9;
  var DEFAULT_VOLUME = 0.7;

  /* Role is fill color on the stage; these are its auditory equivalent. */
  var ROLE_TINT = {
    opus: { ratio: 0.5, type: "sine" },
    advisor: { ratio: 0.75, type: "triangle" },
    worker: { ratio: 1.0, type: "sine" },
    explorer: { ratio: 1.5, type: "square", gain: 0.7 },
    researcher: { ratio: 1.25, type: "sine" }
  };

  /* Pentatonic so simultaneous cues stay consonant. f = Hz, d = seconds, g = peak gain. */
  var CUES = {
    pop: { notes: [{ f: 660, d: 0.09, t: "triangle", g: 0.04, slide: 240 }] },
    chime: {
      notes: [
        { f: 660, d: 0.12, g: 0.035 },
        { f: 990, d: 0.14, g: 0.028, delay: 0.07 }
      ]
    },
    tick: { notes: [{ f: 1320, d: 0.04, t: "square", g: 0.013 }] },
    edit: { notes: [{ f: 300, d: 0.11, g: 0.04, slide: 440 }] },
    whoosh: { notes: [{ f: 240, d: 0.18, t: "sawtooth", g: 0.018, slide: 90 }] },
    spark: { notes: [{ f: 880, d: 0.06, g: 0.025, slide: 1400 }] },
    click: { notes: [{ f: 700, d: 0.03, t: "triangle", g: 0.02 }] },
    error: {
      notes: [
        { f: 440, d: 0.14, t: "triangle", g: 0.032 },
        { f: 330, d: 0.22, t: "triangle", g: 0.03, delay: 0.12 }
      ]
    },
    stall: {
      notes: [
        { f: 262, d: 0.22, g: 0.028 },
        { f: 196, d: 0.28, g: 0.024, delay: 0.22 }
      ]
    },
    bridgeDown: {
      notes: [
        { f: 523, d: 0.12, g: 0.028 },
        { f: 349, d: 0.2, g: 0.026, delay: 0.1 }
      ]
    },
    bridgeUp: {
      notes: [
        { f: 440, d: 0.1, g: 0.026 },
        { f: 660, d: 0.14, g: 0.024, delay: 0.09 }
      ]
    },
    snooze: { notes: [{ f: 320, d: 0.1, g: 0.024, slide: 200 }] },
    unsnooze: { notes: [{ f: 320, d: 0.12, g: 0.024, slide: 520 }] },
    scrub: { notes: [{ f: 900, d: 0.03, t: "triangle", g: 0.015 }] },
    done: {
      notes: [
        { f: 587.33, d: 0.1, g: 0.03 },
        { f: 880, d: 0.16, g: 0.028, delay: 0.09 }
      ]
    },
    ship: {
      notes: [
        { f: 523.25, d: 0.1, g: 0.03 },
        { f: 659.25, d: 0.1, g: 0.03, delay: 0.09 },
        { f: 783.99, d: 0.12, g: 0.03, delay: 0.18 },
        { f: 1046.5, d: 0.24, g: 0.034, delay: 0.27 }
      ]
    }
  };

  var muted = true;
  var volume = DEFAULT_VOLUME;
  var ctx = null;
  var master = null;
  var limiter = null;
  var btn = null;
  var slider = null;
  var lastCue = null;

  try {
    muted = localStorage.getItem(MUTE_KEY) !== "on";
  } catch (_e) {
    /* storage unavailable: stay muted */
  }
  try {
    /* Absent key must mean "use the default", not 0: Number(null) is 0 and would mute. */
    var rawVolume = localStorage.getItem(VOLUME_KEY);
    if (rawVolume != null) {
      var stored = Number(rawVolume);
      if (isFinite(stored) && stored >= 0 && stored <= 1) volume = stored;
    }
  } catch (_e2) {
    /* storage unavailable: keep default */
  }

  function isSnoozed() {
    try {
      var raw = localStorage.getItem(SNOOZE_KEY);
      if (raw === SNOOZE_INDEFINITE) return true;
      var n = Number(raw || 0);
      return isFinite(n) && Date.now() < n;
    } catch (_e) {
      return false;
    }
  }

  /** True when audio is suppressed: muted by preference, zero volume, or alerts snoozed. */
  function shouldMute() {
    return muted || volume <= 0 || isSnoozed();
  }

  function ensure() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      master = ctx.createGain();
      master.gain.value = volume * MASTER_TRIM;
      master.connect(limiter);
      limiter.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function note(c, spec, ratio, typeOverride, gainScale) {
    var t0 = c.currentTime + (spec.delay || 0);
    var freq = spec.f * ratio;
    var dur = spec.d;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = spec.t || typeOverride || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (spec.slide)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.slide * ratio), t0 + dur);
    var peak = Math.max(0.0002, (spec.g == null ? 0.03 : spec.g) * gainScale);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /**
   * Play a cue. opts.role tints pitch/timbre to the agent's station.
   * An unrecognized name is ignored (it is recorded for tests, not sounded).
   * @param {string} name cue name
   * @param {{role?: string}} [opts]
   */
  function play(name, opts) {
    var cue = hasOwn(CUES, name) ? CUES[name] : null;
    var role = opts && opts.role;
    lastCue = { name: cue ? name : "default", role: role || null, audible: !shouldMute() };
    if (!cue || shouldMute()) return;
    var c = ensure();
    if (!c) return;
    var tint = role && hasOwn(ROLE_TINT, role) ? ROLE_TINT[role] : null;
    var ratio = tint ? tint.ratio : 1;
    var type = tint ? tint.type : null;
    var gainScale = tint && tint.gain ? tint.gain : 1;
    for (var i = 0; i < cue.notes.length; i++) note(c, cue.notes[i], ratio, type, gainScale);
  }

  function setVolume(v) {
    var next = Number(v);
    if (!isFinite(next)) return;
    volume = Math.min(1, Math.max(0, next));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch (_e) {
      /* storage unavailable */
    }
    if (master) master.gain.value = volume * MASTER_TRIM;
    if (slider) slider.value = String(volume);
    syncBtn();
  }

  function setMuted(m) {
    muted = !!m;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "off" : "on");
    } catch (_e) {
      /* storage unavailable */
    }
    syncBtn();
  }

  function toggle() {
    setMuted(!muted);
    if (!muted) {
      ensure();
      play("click");
    }
  }

  function syncBtn() {
    if (!btn) return;
    var silent = shouldMute();
    btn.textContent = silent ? "🔇" : "🔊";
    btn.classList.toggle("on", !silent);
    btn.setAttribute("aria-pressed", silent ? "false" : "true");
    if (muted) btn.title = "Sound off (click to unmute)";
    else if (isSnoozed()) btn.title = "Snoozed · sound resumes when you un-snooze alerts";
    else btn.title = "Sound on (click to mute)";
    if (slider) {
      slider.disabled = muted;
      slider.setAttribute("aria-valuetext", Math.round(volume * 100) + " percent");
    }
  }

  function init(opts) {
    var options = opts || {};
    btn = options.button || document.getElementById("soundBtn");
    slider = options.slider || document.getElementById("soundVolume");
    if (slider) {
      slider.value = String(volume);
      slider.addEventListener("input", function () {
        setVolume(slider.value);
        if (!muted) play("tick");
      });
    }
    syncBtn();
  }

  window.WorkshopSound = {
    init: init,
    play: play,
    toggle: toggle,
    setMuted: setMuted,
    isMuted: shouldMute,
    setVolume: setVolume,
    getVolume: function () {
      return volume;
    },
    syncBtn: syncBtn,
    lastCue: function () {
      return lastCue;
    },
    CUES: CUES,
    ROLE_TINT: ROLE_TINT
  };
})();
