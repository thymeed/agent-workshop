/**
 * The scripted Demo narrative: one closure per story beat. The transport that
 * schedules these lives in app.js, which passes every collaborator through
 * init(deps). The step bodies are the original code, with one substitution: the
 * final beat writes the transport's `playing` flag through setPlaying(), because a
 * bare assignment across modules cannot work.
 * Exposed as window.WorkshopDemo.
 */
(function () {
  "use strict";

  var d = null;
  var animateRoute;
  var prefersReducedMotion;
  var setActive;
  var setCalls;
  var setEffort;
  var setPlaying;
  var setStatus;
  var setSubs;
  var setUsageSnapshot;
  var triggerShipCelebration;
  var activity;
  var advisorLastEl;
  var demoBtn;
  var ROLE_LABEL;

  function init(deps) {
    d = deps || {};
    animateRoute = d.animateRoute;
    prefersReducedMotion = d.prefersReducedMotion;
    setActive = d.setActive;
    setCalls = d.setCalls;
    setEffort = d.setEffort;
    setPlaying = d.setPlaying;
    setStatus = d.setStatus;
    setSubs = d.setSubs;
    setUsageSnapshot = d.setUsageSnapshot;
    triggerShipCelebration = d.triggerShipCelebration;
    activity = d.activity;
    advisorLastEl = d.advisorLastEl;
    demoBtn = d.demoBtn;
    ROLE_LABEL = d.ROLE_LABEL;
  }

  var steps = [
    function () {
      setActive(["opus"]);
      setStatus("opus", '<span class="live">Task received · refactor billing webhooks</span>');
      activity.appendLog("parent", "task received · refactor billing webhooks");
      setUsageSnapshot(
        {
          opus: { in: 18000, out: 4200 },
          fable: { in: 0, out: 0 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "opus"
      );
      setEffort("high");
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · before the plan</span>');
      setStatus("advisor", '<span class="live">Reviewing approach…</span>');
      activity.appendLog("parent", "calling advisor · before the plan");
      activity.appendLog("advisor", "triggered · before plan");
      setUsageSnapshot(
        {
          opus: { in: 24000, out: 6100 },
          fable: { in: 12000, out: 3800 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["advisor"]);
      setCalls(1);
      setStatus("advisor", '<span class="live">Quiet</span>');
      setStatus("opus", '<span class="live">Plan approved · delegating reads & edits</span>');
      advisorLastEl.textContent = "Last advice: keep Haiku on reads; Sonnet owns edits";
      activity.appendLog("advisor", "reviews approach → quiet; calls = 1");
      setUsageSnapshot(
        {
          opus: { in: 28000, out: 7200 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 0, out: 0 },
          explorer: { in: 0, out: 0 },
          researcher: { in: 0, out: 0 }
        },
        "advisor"
      );
    },
    function () {
      setActive(["explorer"]);
      setSubs(1);
      setStatus("explorer", '<span class="live">Searching src/billing/**</span>');
      setUsageSnapshot(
        {
          opus: { in: 28000, out: 7200 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 420000, out: 18000 },
          explorer: { in: 420000, out: 18000 },
          researcher: { in: 0, out: 0 }
        },
        "explorer"
      );
      activity.append({
        kind: "read",
        role: "explorer",
        path: "src/billing/**",
        detail: "glob · webhook handlers"
      });
      activity.append({
        kind: "read",
        role: "explorer",
        path: "src/billing/webhooks.ts",
        detail: "lines 1-240"
      });
      /* Demo fixture: sensitive path lights privacy meter (path never shown on badge). */
      activity.append({
        kind: "read",
        role: "explorer",
        path: "config/.env.example",
        detail: "pattern scan · no values loaded"
      });
      activity.appendLog("explorer", "searching src/billing/** · Session Bill climbs");
      animateRoute("delegates", "explorer");
    },
    function () {
      setActive(["explorer", "researcher"]);
      setSubs(2);
      setStatus("researcher", '<span class="live">Pulling docs · webhook patterns</span>');
      setUsageSnapshot(
        {
          opus: { in: 32000, out: 8000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 0, out: 0 },
          haiku: { in: 980000, out: 42000 },
          explorer: { in: 520000, out: 22000 },
          researcher: { in: 460000, out: 20000 }
        },
        "researcher"
      );
      activity.append({
        kind: "read",
        role: "researcher",
        path: "docs/webhooks.md",
        detail: "signature verify patterns"
      });
      activity.appendLog("researcher", "pulling docs · Session Bill climbs");
      animateRoute("delegates", "researcher");
    },
    function () {
      setActive(["worker"]);
      setSubs(3);
      setStatus("explorer", '<span class="live">Search complete</span>');
      setStatus("researcher", '<span class="live">Docs cached</span>');
      setStatus("worker", "Editing 4 files · running tests → FAIL", "fail");
      setUsageSnapshot(
        {
          opus: { in: 36000, out: 9000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 85000, out: 32000 },
          haiku: { in: 1050000, out: 45000 },
          explorer: { in: 540000, out: 23000 },
          researcher: { in: 510000, out: 22000 }
        },
        "worker"
      );
      activity.append({
        kind: "edit",
        role: "worker",
        path: "src/billing/webhooks.ts",
        detail: "edited · signature check"
      });
      activity.append({
        kind: "edit",
        role: "worker",
        path: "src/billing/verify.ts",
        detail: "edited · HMAC helper"
      });
      activity.appendLog("worker", "editing 4 files · running tests → FAIL", "fail");
      animateRoute("delegates", "worker");
    },
    function () {
      setActive(["worker"]);
      setStatus("worker", "Same error again → FAIL", "fail");
      activity.appendLog("worker", "same error again → FAIL", "fail");
      setUsageSnapshot(
        {
          opus: { in: 40000, out: 10000 },
          fable: { in: 22000, out: 9000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "worker"
      );
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · same error twice</span>');
      setStatus("advisor", '<span class="live">Analyzing failure loop…</span>');
      activity.appendLog("parent", "calling advisor · same error twice");
      setUsageSnapshot(
        {
          opus: { in: 52000, out: 14000 },
          fable: { in: 38000, out: 16000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["advisor"]);
      setCalls(2);
      setStatus("advisor", '<span class="live">Quiet</span>');
      advisorLastEl.textContent =
        "Last advice: stop / change approach. Fix signature mismatch first";
      setStatus("worker", '<span class="live">Awaiting revised approach</span>');
      activity.appendLog("advisor", "stop / change approach; calls = 2");
      setUsageSnapshot(
        {
          opus: { in: 56000, out: 15000 },
          fable: { in: 52000, out: 24000 },
          sonnet: { in: 120000, out: 48000 },
          haiku: { in: 1080000, out: 46000 },
          explorer: { in: 550000, out: 23500 },
          researcher: { in: 530000, out: 22500 }
        },
        "advisor"
      );
    },
    function () {
      setActive(["worker"]);
      setStatus("worker", "Fix applied · tests → PASS", "pass");
      setUsageSnapshot(
        {
          opus: { in: 60000, out: 16000 },
          fable: { in: 52000, out: 24000 },
          sonnet: { in: 210000, out: 78000 },
          haiku: { in: 1120000, out: 48000 },
          explorer: { in: 570000, out: 24500 },
          researcher: { in: 550000, out: 23500 }
        },
        "worker"
      );
      activity.append({
        kind: "edit",
        role: "worker",
        path: "src/billing/webhooks.test.ts",
        detail: "edited · fixture sig"
      });
      activity.appendLog("worker", "fix + tests → PASS", "pass");
      animateRoute("delegates", "worker");
    },
    function () {
      setActive(["opus", "advisor"]);
      setStatus("opus", '<span class="live">Calling advisor · before done</span>');
      setStatus("advisor", '<span class="live">Final review…</span>');
      setCalls(3);
      activity.appendLog("parent", "calling advisor · before done; calls = 3");
      setUsageSnapshot(
        {
          opus: { in: 78000, out: 22000 },
          fable: { in: 68000, out: 32000 },
          sonnet: { in: 210000, out: 78000 },
          haiku: { in: 1120000, out: 48000 },
          explorer: { in: 570000, out: 24500 },
          researcher: { in: 550000, out: 23500 }
        },
        "advisor"
      );
      animateRoute("asks", "advisor");
    },
    function () {
      setActive(["opus"]);
      setStatus("advisor", '<span class="live">Quiet</span>');
      advisorLastEl.textContent = "Last advice: ship it. Haiku covered the read load";
      setStatus("opus", '<span class="live">Reviewed · shipped</span>');
      setStatus("worker", '<span class="live">Done</span>');
      setStatus("explorer", '<span class="live">Done</span>');
      setStatus("researcher", '<span class="live">Done</span>');
      setUsageSnapshot(
        {
          opus: { in: 95000, out: 28000 },
          fable: { in: 72000, out: 36000 },
          sonnet: { in: 225000, out: 82000 },
          haiku: { in: 1200000, out: 52000 },
          explorer: { in: 620000, out: 27000 },
          researcher: { in: 580000, out: 25000 }
        },
        "opus"
      );
      activity.appendLog(
        "parent",
        "reviewed · shipped · Session Bill shows multi-model savings vs all-Opus"
      );
      setEffort("done");
      triggerShipCelebration(["opus", "worker", "explorer", "researcher"], ROLE_LABEL.opus);
      setPlaying(false);
      demoBtn.textContent = "Play";
      demoBtn.classList.remove("playing");
      demoBtn.setAttribute("aria-pressed", "false");
      setTimeout(
        function () {
          setActive([]);
        },
        prefersReducedMotion() ? 0 : 800
      );
    }
  ];

  window.WorkshopDemo = {
    init: init,
    steps: steps,
    stepCount: function () {
      return steps.length;
    }
  };
})();
