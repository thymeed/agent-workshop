/**
 * Dashboard unit layer: pure formatters and the pixel-cast avatar/brand invariants,
 * exercised directly against the module exports in a real page context.
 * Demo via file://, so no bridge is required.
 */
"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const HTML = path.resolve(__dirname, "..", "model-routing-dashboard.html");
const FILE_URL = pathToFileURL(HTML).href;

function assertFace(role, face) {
  assert.ok(face.hasRole, `${role}: faceMarkup must carry data-avatar="${role}"`);
  assert.ok(face.idle, `${role}: default faceMarkup must be state-idle`);
  assert.strictEqual(face.eyes, 2, `${role}: avatar must have exactly two square eyes`);
  assert.ok(!face.letters, `${role}: avatar must not use letter initials`);
  assert.ok(face.sm, `${role}: size sm must add avatar-sm`);
  assert.strictEqual(face.smRects, 3, `${role}: compact avatar must be fill + two eyes only`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(FILE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(
      () => globalThis.__cursorAgentsDashTest && window.AgentCards && window.ReplayStage,
      null,
      { timeout: 20000 }
    );

    const data = await page.evaluate(() => {
      const T = globalThis.__cursorAgentsDashTest;
      const AC = window.AgentCards;
      const RS = window.ReplayStage;
      const rects = (s) => s.split("<rect").length - 1;

      const faces = {};
      for (const role of AC.ROLE_KEYS) {
        const markup = AC.faceMarkup(role);
        faces[role] = {
          hasRole: markup.includes('data-avatar="' + role + '"'),
          idle: markup.includes("state-idle"),
          eyes: markup.split("block-agent-eye").length - 1,
          letters: /<text/.test(markup),
          sm: AC.faceMarkup(role, { size: "sm" }).includes("avatar-sm"),
          smRects: rects(AC.faceMarkup(role, { size: "sm" }))
        };
      }

      return {
        syncAge: {
          empty: T.formatSyncAge(null),
          junk: T.formatSyncAge("not-a-date"),
          now: T.formatSyncAge(new Date().toISOString()),
          fiveSec: T.formatSyncAge(new Date(Date.now() - 5000).toISOString()),
          ninetySec: T.formatSyncAge(new Date(Date.now() - 90000).toISOString()),
          threeHour: T.formatSyncAge(new Date(Date.now() - 3 * 3600 * 1000).toISOString())
        },
        svg: {
          compact: rects(AC.blockAgentSvgInner({ compact: true })),
          plain: rects(AC.blockAgentSvgInner({})),
          limbs: rects(AC.blockAgentSvgInner({ limbs: true }))
        },
        faces,
        roleKeys: AC.ROLE_KEYS.slice(),
        unknownRole: AC.faceMarkup("not-a-role").includes('data-avatar="opus"'),
        hints: {
          advisor: AC.roleFromAgentHint("Advisor"),
          fable: AC.roleFromAgentHint({ model: "fable" }),
          worker: AC.roleFromAgentHint("Worker"),
          sonnet: AC.roleFromAgentHint({ model: "sonnet" }),
          researcher: AC.roleFromAgentHint("researcher"),
          explorer: AC.roleFromAgentHint("explore"),
          parent: AC.roleFromAgentHint("parent"),
          unknown: AC.roleFromAgentHint("something-else"),
          absent: AC.roleFromAgentHint(null)
        },
        invariants: {
          usageTotal: T.demoUsageTokenTotal(),
          disclaimer: typeof T.estimatesDisclaimer === "string" && T.estimatesDisclaimer.length > 0,
          snoozeKey: typeof T.snoozeKey === "string" && T.snoozeKey.length > 0,
          mapHistoryEvent: typeof RS.mapHistoryEvent === "function"
        },
        /* While a replay owns the stage (setReplaying), nothing it drives may change today's counters. */
        dailyFreeze: (() => {
          const AC = window.AgentCards;
          const read = () => {
            const d = AC.getDailyStats();
            return {
              runs: d.runs,
              tokens: d.tokens,
              fastestAgent: d.fastestAgent,
              fastestMs: d.fastestMs
            };
          };
          AC.onModeChange("live");
          AC.recordRun({ agent: "worker", tokens: 5, durationMs: 500 });
          AC.setActive(["opus"]);
          const startBefore = AC.getRoleActiveStarted("opus");
          const base = read();
          AC.setReplaying(true);
          AC.recordRun({ agent: "worker", tokens: 7, durationMs: 120 });
          AC.addTokens(40, "worker");
          AC.syncLiveSubs(9);
          AC.recordLiveSession();
          AC.setActive(["worker"]);
          AC.setActive([]);
          AC.setActive([], { skipTiming: true });
          const frozen = read();
          const startFrozen = AC.getRoleActiveStarted("opus");
          AC.setReplaying(false);
          AC.recordRun({ agent: "worker", tokens: 3, durationMs: 90 });
          const after = read();
          AC.onModeChange("demo");
          return { base, frozen, after, startBefore, startFrozen };
        })(),
        /* A replay that crosses midnight: the replay's own rows must not fill the new day. */
        dayRollover: (() => {
          const AC = window.AgentCards;
          const RealDate = window.Date;
          let nowMs = new RealDate(2026, 10, 18, 23, 59, 0).getTime();
          class FakeDate extends RealDate {
            constructor(...args) {
              if (args.length) super(...args);
              else super(nowMs);
            }
            static now() {
              return nowMs;
            }
          }
          const read = () => {
            const d = AC.getDailyStats();
            return {
              runs: d.runs,
              tokens: d.tokens,
              fastestAgent: d.fastestAgent,
              fastestMs: d.fastestMs
            };
          };
          window.Date = FakeDate;
          try {
            AC.onModeChange("live");
            AC.recordRun({ agent: "worker", tokens: 500, durationMs: 1000 });
            const before = read();
            const snap = AC.snapshot();
            AC.setReplaying(true);
            nowMs = new RealDate(2026, 10, 19, 0, 2, 0).getTime();
            AC.setActive(["worker"], { skipTiming: true });
            AC.syncLiveSubs(3);
            AC.recordRun({ agent: "worker", tokens: 9, durationMs: 40 });
            AC.setReplaying(false);
            AC.restore(snap);
            return { before, afterMidnight: read() };
          } finally {
            window.Date = RealDate;
            AC.setReplaying(false);
            AC.onModeChange("demo");
          }
        })(),
        reconnect: (() => {
          const delays = [0, 1, 2, 3, 4, 5, 6, 10].map((n) => T.reconnectDelayMs(n));
          const state = T.reconnectState();
          T.scheduleLiveReconnect();
          return { delays, state, afterCallFromFileOrigin: T.reconnectState() };
        })(),
        focusFlow: (() => {
          const T = globalThis.__cursorAgentsDashTest;
          const out = {};
          const historyBtn = document.getElementById("viewHistory");
          const drawer = document.getElementById("drawerHistory");

          historyBtn.focus();
          historyBtn.click();
          out.viewMode = T.getViewMode();
          out.drawerOpen = !!drawer.open;
          /* Opening a non-modal sheet must NOT steal focus from its toggle.
             (focus() first: a synthetic .click() does not focus the button itself) */
          out.focusStayedOnToggle = document.activeElement === historyBtn;

          /* Now put focus inside the sheet, then switch away: focus must be reclaimed. */
          const summary = drawer.querySelector("summary");
          if (summary) summary.focus();
          out.focusInsideSheet = drawer.contains(document.activeElement);
          document.getElementById("viewStage").click();
          out.restoredToViewControl = !!(
            document.activeElement && document.activeElement.closest("#viewMode")
          );
          out.stageMode = T.getViewMode();
          out.historyDrawerClosed = !drawer.open;
          return out;
        })(),
        a11y: (() => {
          const chars = ["opus", "advisor", "worker", "explorer", "researcher"].map((r) => {
            const el = document.getElementById("char-" + r);
            return el
              ? {
                  role: el.getAttribute("role"),
                  tab: el.getAttribute("tabindex"),
                  label: !!el.getAttribute("aria-label")
                }
              : null;
          });
          const portal = document.getElementById("mergePortal");
          const banner = document.getElementById("livePresenceBanner");
          const log = document.getElementById("sessionLog");
          return {
            chars,
            portal: portal
              ? { role: portal.getAttribute("role"), tab: portal.getAttribute("tabindex") }
              : null,
            bannerLive: banner ? banner.getAttribute("aria-live") : null,
            logLive: log ? log.getAttribute("aria-live") : null,
            viewControls: ["viewStage", "viewInsights", "viewHistory"].map((id) => {
              const el = document.getElementById(id);
              return el
                ? { id, controls: el.getAttribute("aria-controls") }
                : { id, controls: null };
            }),
            volume: (() => {
              const el = document.getElementById("soundVolume");
              return el ? { label: !!el.getAttribute("aria-label"), type: el.type } : null;
            })()
          };
        })(),
        exportSummary: (() => {
          const s = T.buildSessionSummary();
          return {
            keys: Object.keys(s),
            modelNames: s.models.map((m) => m.model),
            totalsFinite:
              Number.isFinite(s.totals.estimatedCostUsd) &&
              Number.isFinite(s.totals.inputTokens) &&
              Number.isFinite(s.totals.outputTokens),
            everyCostFinite: s.models.every((m) => Number.isFinite(m.estimatedCostUsd)),
            csv: T.summaryToCsv(s),
            disclaimer: s.disclaimer
          };
        })(),
        roleProfiles: (() => {
          const RP = window.RoleProfiles;
          const AC = window.AgentCards;
          const SLOTS = ["opus", "advisor", "worker", "explorer", "researcher"];
          const text = (sel) => document.querySelector(sel).textContent;
          const all = (sel, attr) =>
            Array.from(document.querySelectorAll(sel)).map((e) => e.getAttribute(attr));
          const snap = () => ({
            names: SLOTS.map((r) => text("#card-" + r + " .card-name")),
            roles: SLOTS.map((r) => text("#card-" + r + " .card-role")),
            stations: SLOTS.map((r) => text("#char-" + r + " .char-label")),
            aria: SLOTS.map((r) => document.getElementById("char-" + r).getAttribute("aria-label")),
            nameTip: document.querySelector("#card-opus .card-name").getAttribute("data-tip"),
            avatarTip: SLOTS.map((r) =>
              document.querySelector("#card-" + r + " .agent-avatar").getAttribute("data-tip")
            ),
            statusTip: SLOTS.map((r) =>
              document.getElementById("status-" + r).getAttribute("data-tip")
            ),
            pills: Array.from(document.querySelectorAll(".role-pill")).map((p) => p.textContent),
            /* Every tip and aria-label in the static markup (stations, pills, flow labels,
               cards): apply(cursor) must restore each string exactly. */
            tips: Array.from(document.querySelectorAll("[data-tip],[aria-label]")).map((e) => [
              e.id || e.className,
              e.getAttribute("data-tip"),
              e.getAttribute("data-tip-detail"),
              e.getAttribute("aria-label")
            ]),
            prices: SLOTS.map((r) => document.querySelector("#card-" + r + " .price").innerHTML),
            dataRole: all("[data-role]", "data-role"),
            dataAvatar: all("[data-avatar]", "data-avatar")
          });
          const original = snap();
          const applied = RP.apply("claude-code");
          const claude = snap();
          const hintClaude = AC.roleFromAgentHint("reviewer");
          const restored = RP.apply("cursor");
          const back = snap();
          const priceEmpty = (RP.apply("claude-code"), snap().prices);
          const modelsOk = RP.setModels({
            opus: "claude-opus-4-5",
            advisor: "claude-fable-5-2",
            worker: "claude-sonnet-4-5",
            explorer: "claude-haiku-4-5",
            researcher: "octopus-1"
          });
          const priceFilled = snap().prices;
          const priceShape = SLOTS.map((r) => {
            const el = document.querySelector("#card-" + r + " .price");
            return {
              nodes: Array.from(el.childNodes).map((n) => n.nodeType),
              kids: Array.from(el.children).map((c) => c.tagName),
              strongKids: el.children[0] ? el.children[0].children.length : -1,
              text: el.textContent
            };
          });
          const priceTipHaiku = document
            .querySelector("#card-explorer .price")
            .getAttribute("data-tip-detail");
          /* Stale-reference check: ROLE_LABEL is grabbed before apply() and read after. */
          const RL = T.ROLE_LABEL;
          RP.apply("cursor");
          const staleBefore = RL.opus;
          RP.apply("claude-code");
          const staleAfter = SLOTS.map((r) => RL[r]);
          RL.opus = "x";
          let strictThrew = false;
          try {
            new Function("o", "'use strict'; o.opus = 'x';")(RL);
          } catch (e) {
            strictThrew = e instanceof TypeError;
          }
          const staleAfterWrite = RL.opus;
          const hudLabel = (() => {
            return document.querySelector("#char-opus .char-label").textContent;
          })();
          const rlFrozen = Object.isFrozen(RL);
          RP.apply("cursor");
          const staleRestored = RL.opus;
          RP.apply("claude-code");
          const priceTip = document
            .querySelector("#card-opus .price")
            .getAttribute("data-tip-detail");
          RP.apply("cursor");
          const priceBack = snap().prices;
          return {
            original,
            applied,
            claude,
            hintClaude,
            restored,
            back,
            priceEmpty,
            modelsOk,
            priceFilled,
            priceShape,
            priceTipHaiku,
            stale: {
              staleBefore,
              staleAfter,
              strictThrew,
              staleAfterWrite,
              hudLabel,
              rlFrozen,
              staleRestored
            },
            priceTip,
            priceBack,
            refused: RP.apply("nope"),
            current: RP.current().id
          };
        })()
      };
    });

    assert.strictEqual(data.syncAge.empty, "n/a", "formatSyncAge(null) must be n/a");
    assert.strictEqual(data.syncAge.junk, "n/a", "formatSyncAge(junk) must be n/a");
    assert.strictEqual(data.syncAge.now, "just now", "fresh timestamp must read just now");
    assert.strictEqual(data.syncAge.fiveSec, "5s ago", "5s must format in seconds");
    assert.strictEqual(data.syncAge.ninetySec, "1m ago", "90s must format in minutes");
    assert.strictEqual(data.syncAge.threeHour, "3h ago", "3h must format in hours");

    assert.strictEqual(data.svg.compact, 3, "compact avatar is fill plus two eyes");
    assert.strictEqual(data.svg.plain, 7, "default avatar adds four legs");
    assert.strictEqual(data.svg.limbs, 9, "limbs add two arms on top of legs");

    assert.deepStrictEqual(
      data.roleKeys,
      ["opus", "advisor", "worker", "explorer", "researcher"],
      "the five stage roles are pinned; a role dropped from this list must fail"
    );
    for (const role of Object.keys(data.faces)) assertFace(role, data.faces[role]);
    assert.ok(data.unknownRole, "unknown role must fall back to the opus face");

    assert.strictEqual(data.hints.advisor, "advisor");
    assert.strictEqual(data.hints.fable, "advisor");
    assert.strictEqual(data.hints.worker, "worker");
    assert.strictEqual(data.hints.sonnet, "worker");
    assert.strictEqual(data.hints.researcher, "researcher");
    assert.strictEqual(data.hints.explorer, "explorer");
    assert.strictEqual(data.hints.parent, "opus");
    assert.strictEqual(data.hints.unknown, "", "unmapped hint must return empty");
    assert.strictEqual(data.hints.absent, "", "absent hint must return empty");

    const rp = data.roleProfiles;
    assert.deepStrictEqual(
      rp.original.names,
      ["Opus", "Fable", "Worker", "Explorer", "Researcher"],
      "cursor card names must be the static HTML names before any apply"
    );
    assert.ok(rp.applied && rp.restored, "apply must accept both known sources");
    assert.deepStrictEqual(
      rp.claude.names,
      ["Lead", "Planner", "Worker", "Researcher", "Reviewer"],
      "claude-code card names must follow the owner slot map"
    );
    assert.deepStrictEqual(rp.claude.stations, [
      "Lead",
      "Planner",
      "Worker",
      "Researcher",
      "Reviewer"
    ]);
    assert.deepStrictEqual(rp.claude.aria, [
      "Lead station",
      "Planner station",
      "Worker station",
      "Researcher station",
      "Reviewer station"
    ]);
    assert.deepStrictEqual(rp.claude.roles, [
      "Main session",
      "Plan review",
      "Edits",
      "Search",
      "Reviewer"
    ]);
    assert.deepStrictEqual(
      rp.priceEmpty,
      Array(5).fill("<strong>model not set</strong>"),
      "claude-code price rows say model not set while no model is known"
    );
    assert.ok(rp.modelsOk);
    assert.deepStrictEqual(rp.priceFilled, [
      "list price (Opus 5.5): <strong>$4 / $20</strong>",
      "list price (Fable 5.2): <strong>$8 / $40</strong>",
      "list price (Sonnet 5.5): <strong>$2 / $10</strong>",
      "list price (Haiku 5.5): <strong>$0.10 / $0.50</strong>",
      "no <strong>list price</strong>"
    ]);
    assert.deepStrictEqual(
      data.roleProfiles.priceShape.map((p) => [p.nodes, p.kids, p.strongKids]),
      Array(5).fill([[3, 1], ["STRONG"], 0]),
      "each price row is one text node plus one strong holding text only"
    );
    assert.deepStrictEqual(
      data.roleProfiles.priceShape.map((p) => p.text),
      [
        "list price (Opus 5.5): $4 / $20",
        "list price (Fable 5.2): $8 / $40",
        "list price (Sonnet 5.5): $2 / $10",
        "list price (Haiku 5.5): $0.10 / $0.50",
        "no list price"
      ]
    );
    assert.ok(data.roleProfiles.priceTipHaiku.includes("List price of Haiku 5.5,"));
    assert.ok(data.roleProfiles.priceTipHaiku.includes("$0.50 / $2.50 over 100k"));
    const st = data.roleProfiles.stale;
    assert.strictEqual(st.staleBefore, "Opus", "ROLE_LABEL read under cursor");
    assert.deepStrictEqual(
      st.staleAfter,
      ["Lead", "Planner", "Worker", "Researcher", "Reviewer"],
      "a ROLE_LABEL reference taken before apply() sees the claude-code labels"
    );
    assert.ok(st.strictThrew, "a strict write to ROLE_LABEL throws");
    assert.strictEqual(st.staleAfterWrite, "Lead", "a write to ROLE_LABEL changes nothing");
    assert.strictEqual(st.hudLabel, "Lead", "the stage label is unaffected by the write");
    assert.ok(st.rlFrozen, "ROLE_LABEL is frozen");
    assert.strictEqual(st.staleRestored, "Opus", "apply(cursor) restores ROLE_LABEL");
    assert.match(rp.priceTip, /List price/, "price tip says list price under claude-code");
    assert.deepStrictEqual(
      rp.priceBack,
      rp.original.prices,
      "cursor price rows are restored to the static HTML"
    );
    assert.deepStrictEqual(
      rp.original.prices,
      [
        "$4.00 / $20.00 <strong>per 1M in/out</strong>",
        "$8.00 / $40.00 <strong>per 1M in/out</strong>",
        "$2.00 / $10.00 <strong>per 1M in/out</strong>",
        "$0.10 / $0.50 <strong>per 1M in/out</strong>",
        "$0.10 / $0.50 <strong>per 1M in/out</strong>"
      ],
      "cursor price rows are the HEAD strings"
    );
    assert.strictEqual(rp.claude.nameTip, "Lead", "card tips must re-decorate on apply");
    assert.deepStrictEqual(
      rp.claude.avatarTip.map((t) => t.split(" is ")[0]),
      rp.claude.names,
      "avatar tips must use the claude-code names"
    );
    assert.deepStrictEqual(
      rp.claude.statusTip.map((t) => t.split(" · ")[0]),
      rp.claude.names,
      "status tips must use the claude-code names"
    );
    assert.deepStrictEqual(rp.claude.pills, [
      "lead plans",
      "worker edits",
      "scouts read",
      "planner reviews"
    ]);
    assert.strictEqual(
      rp.hintClaude,
      "researcher",
      "claude-code reviewer hint maps to the researcher slot"
    );
    assert.strictEqual(rp.refused, false, "unknown source must be refused");
    assert.strictEqual(rp.current, "cursor", "refused apply must leave cursor active");
    assert.deepStrictEqual(rp.claude.dataRole, rp.original.dataRole, "data-role must not change");
    assert.deepStrictEqual(
      rp.claude.dataAvatar,
      rp.original.dataAvatar,
      "data-avatar must not change"
    );
    assert.deepStrictEqual(
      rp.back,
      rp.original,
      "apply(cursor) must restore the original static text and tips"
    );

    assert.ok(
      Number.isFinite(data.invariants.usageTotal) && data.invariants.usageTotal >= 0,
      "demo usage total must be a finite non-negative number"
    );
    assert.ok(data.invariants.disclaimer, "estimates disclaimer must be present");
    assert.ok(data.invariants.snoozeKey, "snooze storage key must be present");
    assert.ok(data.invariants.mapHistoryEvent, "ReplayStage.mapHistoryEvent must be exported");

    /* Today's counters: frozen while a replay owns the stage, normal again afterwards. */
    const df = data.dailyFreeze;
    assert.deepStrictEqual(
      df.base,
      { runs: 1, tokens: 5, fastestAgent: "worker", fastestMs: 500 },
      "freeze setup: one run"
    );
    assert.deepStrictEqual(
      df.frozen,
      df.base,
      "setReplaying(true) must freeze Runs, tokens and fastest"
    );
    assert.ok(df.startBefore > 0, "freeze setup: opus has a running clock");
    assert.strictEqual(
      df.startFrozen,
      df.startBefore,
      "a frozen setActive must not touch role clocks"
    );
    assert.deepStrictEqual(
      df.after,
      { runs: 2, tokens: 8, fastestAgent: "worker", fastestMs: 90 },
      "counting must work again once the replay is released"
    );

    const dr = data.dayRollover;
    assert.deepStrictEqual(
      dr.before,
      { runs: 1, tokens: 500, fastestAgent: "worker", fastestMs: 1000 },
      "day rollover setup: the first day has its run"
    );
    assert.deepStrictEqual(
      dr.afterMidnight,
      { runs: 0, tokens: 0, fastestAgent: null, fastestMs: null },
      "a replay across midnight must leave the new day at zero"
    );

    /* SSE auto-reconnect policy: doubling backoff, hard cap, bounded attempts. */
    assert.deepStrictEqual(
      data.reconnect.delays.slice(0, 6),
      [1000, 2000, 4000, 8000, 16000, 30000],
      "reconnect backoff must double from 1s and cap at 30s"
    );
    assert.strictEqual(
      data.reconnect.delays[6],
      30000,
      "backoff must stay capped past the max, not keep growing"
    );
    assert.ok(
      data.reconnect.state.max > 0 && data.reconnect.state.max <= 10,
      "reconnect must be bounded by a small max attempt count"
    );
    assert.strictEqual(data.reconnect.state.attempts, 0, "no reconnect attempts before a drop");
    /* file:// must never schedule a retry: the bridge rejects Origin "null" by design,
       so a retry loop there is pure noise. */
    assert.deepStrictEqual(
      data.reconnect.afterCallFromFileOrigin,
      { attempts: 0, max: 6, pending: false },
      "scheduleLiveReconnect must be a no-op off a bridge origin"
    );

    /* Session summary export: stable shape, finite numbers, well-formed CSV. */
    const ex = data.exportSummary;
    for (const key of [
      "generatedAt",
      "mode",
      "totals",
      "models",
      "advisorCalls",
      "subagents",
      "activity",
      "disclaimer"
    ]) {
      assert.ok(ex.keys.includes(key), `summary must include ${key}`);
    }
    assert.deepStrictEqual(
      ex.modelNames,
      ["opus", "fable", "sonnet", "haiku", "explorer", "researcher"],
      "summary must report every model bucket"
    );
    assert.ok(ex.totalsFinite, "summary totals must be finite numbers, never NaN");
    assert.ok(ex.everyCostFinite, "every model cost must be finite, never NaN");
    const csvLines = ex.csv.trim().split("\n");
    assert.strictEqual(
      csvLines[0],
      "model,inputTokens,outputTokens,estimatedCostUsd",
      "CSV header must be stable"
    );
    assert.ok(
      csvLines.some((l) => l.startsWith("TOTAL (excl. explorer/researcher; in Haiku),")),
      "CSV must carry a TOTAL row"
    );
    assert.strictEqual(csvLines[1].split(",").length, 4, "CSV data rows keep four columns");

    /* Accessibility invariants: these are a regression guard, not a WCAG claim. */
    const ff = data.focusFlow;
    assert.strictEqual(ff.viewMode, "history", "clicking History must switch the view mode");
    assert.ok(ff.drawerOpen, "History must open its drawer sheet");
    assert.ok(
      ff.focusStayedOnToggle,
      "opening a non-modal sheet must not steal focus from its toggle"
    );
    assert.ok(ff.focusInsideSheet, "the test must be able to put focus inside the sheet");
    assert.ok(
      ff.restoredToViewControl,
      "hiding the sheet that held focus must return focus to a view control"
    );
    assert.strictEqual(ff.stageMode, "stage", "Stage click must return to stage mode");
    assert.ok(ff.historyDrawerClosed, "leaving History must close its drawer");

    const a = data.a11y;
    for (const c of a.chars) {
      assert.strictEqual(c.role, "button", "each station must expose role=button");
      assert.strictEqual(c.tab, "0", "each station must be tab-reachable");
      assert.ok(c.label, "each station must have an accessible name");
    }
    assert.strictEqual(a.portal.role, "button", "merge portal must expose role=button");
    assert.strictEqual(a.portal.tab, "0", "merge portal must be tab-reachable");
    assert.strictEqual(a.bannerLive, "polite", "presence banner must announce politely");
    assert.strictEqual(a.logLive, "polite", "session log must announce politely");
    for (const v of a.viewControls) {
      assert.strictEqual(v.controls, "drawers", `${v.id} must declare what it controls`);
    }
    assert.ok(a.volume && a.volume.label, "volume control must have an accessible name");
    assert.strictEqual(a.volume.type, "range", "volume control must be a range input");

    console.log("dashboard units OK · formatters, avatar invariants, role mapping");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
