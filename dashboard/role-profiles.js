/**
 * Role profiles: the names the dashboard shows for each slot. Slot keys (opus, advisor,
 * worker, explorer, researcher), DOM ids, data-role, data-avatar and fill colours never
 * change. Only the displayed text does.
 *
 * "cursor" is the default and matches the static HTML exactly. "claude-code" is reached
 * only through apply() from the devtools console for now (no source switch yet).
 * Loaded after cards.js and before app.js; exposes window.RoleProfiles.
 *
 * tables() returns live objects that apply() refills in place, so holders of a
 * reference (app.js ROLE_LABEL, activity and demo wiring) see the new names.
 */
(function () {
  "use strict";

  var SLOT_KEYS = ["opus", "advisor", "worker", "explorer", "researcher"];

  var PROFILES = {
    cursor: {
      id: "cursor",
      labels: {
        opus: "Opus",
        advisor: "Fable",
        worker: "Sonnet",
        explorer: "Explore",
        researcher: "Research"
      },
      models: {
        opus: "Opus",
        advisor: "Fable",
        worker: "Sonnet",
        explorer: "Haiku",
        researcher: "Haiku"
      },
      cardTips: {
        opus: {
          name: "Opus",
          nameDetail: "Main session lead (Cursor Agents parent)",
          role: "Main session",
          roleDetail: "Parent agent that routes work and delegates to subagents",
          effort: "Effort · high",
          effortDetail: "Opus usually runs a high-effort band",
          price: "Opus rates",
          priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
        },
        advisor: {
          name: "Fable",
          nameDetail: "Advisor subagent (Fable)",
          role: "Advisor",
          roleDetail: "Review at plan, repeated errors, and before done",
          effort: "Effort · high",
          effortDetail: "Advisor reviews run a high-effort band",
          price: "Fable rates",
          priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
          calls: "Advisor calls",
          callsDetail: "How many times Fable has been asked this session",
          last: "Last advice",
          lastDetail: "Most recent tip from Fable"
        },
        worker: {
          name: "Worker",
          nameDetail: "Worker subagent (Sonnet)",
          role: "Sonnet · edits",
          roleDetail: "Edits, tests, and fixes in the repo",
          effort: "Effort · medium",
          effortDetail: "Worker usually runs a medium-effort band",
          price: "Sonnet rates",
          priceDetail: "Illustrative $ per 1M tokens in/out · not a bill"
        },
        explorer: {
          name: "Explorer",
          nameDetail: "Explorer subagent (Haiku)",
          role: "Haiku · search",
          roleDetail: "Read-only search and repo mapping",
          effort: "Effort · low",
          effortDetail: "Explorer keeps it light and fast",
          price: "Haiku rates",
          priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
          scout: "Scout mode",
          scoutDetail: "Read-only explore. No edits from this station."
        },
        researcher: {
          name: "Researcher",
          nameDetail: "Researcher subagent (Haiku)",
          role: "Haiku · docs",
          roleDetail: "Read-only research and doc lookup",
          effort: "Effort · low",
          effortDetail: "Researcher keeps it light and fast",
          price: "Haiku rates",
          priceDetail: "Illustrative $ per 1M tokens in/out · not a bill",
          scout: "Scout mode",
          scoutDetail: "Read-only research. No edits from this station."
        }
      },
      chipTips: [
        {
          tip: "Before plan",
          detail: "Fable reviews the approach before the big plan"
        },
        {
          tip: "Same error ×2",
          detail: "Fable jumps in when the same failure loops"
        },
        {
          tip: "Before done",
          detail: "Fable does a final pass before ship"
        }
      ],
      /* Parser-independent keyword -> slot for alert and history hints. Empty: the
         cursor hint logic in cards.js applies unchanged. */
      hintRoles: [],
      /* Price row per slot: [amount text, label]. Fixed strings, as in the static HTML. */
      prices: {
        opus: ["$4.00 / $20.00", "per 1M in/out"],
        advisor: ["$10.00 / $50.00", "per 1M in/out"],
        worker: ["$2.00 / $10.00", "per 1M in/out"],
        explorer: ["$0.10 / $0.50", "per 1M in/out"],
        researcher: ["$0.10 / $0.50", "per 1M in/out"]
      },
      /* Station data-tip-detail text per slot (aria-label and tip come from labels). */
      stations: {
        opus: "Parent agent: plans, reviews, and ships work",
        advisor: "Warm advisor · peeks before plan, same-error ×2, and before done",
        worker: "Build buddy · edits, tests, and crate drops to merge",
        explorer: "Tiny scout · read-only search across the shelves",
        researcher: "Library buddy · read-only docs and references"
      },
      /* Role pills in the header, keyed by their class name. */
      pills: {
        opus: {
          text: "opus plans",
          tip: "Opus plans",
          detail: "Main session · plans, reviews, and ships"
        },
        sonnet: {
          text: "sonnet edits",
          tip: "Sonnet edits",
          detail: "Worker lane · code changes and tests"
        },
        haiku: {
          text: "haiku reads",
          tip: "Haiku reads",
          detail: "Explorer + researcher · fast read-only scouts"
        },
        advisor: {
          text: "advisor reviews",
          tip: "Advisor reviews",
          detail: "Fable · checks before plan, same-error ×2, and before done"
        }
      },
      flows: {
        asks: "Opus pings Fable for a second look before big moves",
        delegates: "Work flows to Sonnet / Haiku, then into the merge portal"
      }
    },

    "claude-code": {
      id: "claude-code",
      labels: {
        opus: "Lead",
        advisor: "Planner",
        worker: "Worker",
        explorer: "Researcher",
        researcher: "Reviewer"
      },
      /* No fixed model names: a Claude Code slot does not pin one model. Empty until
         setModels() fills a slot from data (agent file or session). The price rows and
         the model text read this table. */
      models: {
        opus: "",
        advisor: "",
        worker: "",
        explorer: "",
        researcher: ""
      },
      cardTips: {
        opus: {
          name: "Lead",
          nameDetail: "Main session lead (Claude Code parent)",
          role: "Main session",
          roleDetail: "Parent agent that routes work and delegates to subagents",
          effort: "Effort · high",
          effortDetail: "Lead usually runs a high-effort band",
          price: "List price",
          priceDetail: "List price of the model this role runs, $ per 1M tokens in/out · not a bill"
        },
        advisor: {
          name: "Planner",
          nameDetail: "Planner subagent",
          role: "Plan review",
          roleDetail: "Review at plan, repeated errors, and before done",
          effort: "Effort · high",
          effortDetail: "Planner reviews run a high-effort band",
          price: "List price",
          priceDetail:
            "List price of the model this role runs, $ per 1M tokens in/out · not a bill",
          calls: "Planner calls",
          callsDetail: "How many times the planner has been asked this session",
          last: "Last advice",
          lastDetail: "Most recent tip from the planner"
        },
        worker: {
          name: "Worker",
          nameDetail: "Worker subagent",
          role: "Edits",
          roleDetail: "Edits, tests, and fixes in the repo",
          effort: "Effort · medium",
          effortDetail: "Worker usually runs a medium-effort band",
          price: "List price",
          priceDetail: "List price of the model this role runs, $ per 1M tokens in/out · not a bill"
        },
        explorer: {
          name: "Researcher",
          nameDetail: "Researcher subagent",
          role: "Search",
          roleDetail: "Read-only search and repo mapping",
          effort: "Effort · low",
          effortDetail: "Researcher keeps it light and fast",
          price: "List price",
          priceDetail:
            "List price of the model this role runs, $ per 1M tokens in/out · not a bill",
          scout: "Scout mode",
          scoutDetail: "Read-only explore. No edits from this station."
        },
        researcher: {
          name: "Reviewer",
          nameDetail: "Reviewer subagent",
          role: "Reviewer",
          roleDetail: "Review and doc lookup",
          effort: "Effort · low",
          effortDetail: "Reviewer keeps it light and fast",
          price: "List price",
          priceDetail:
            "List price of the model this role runs, $ per 1M tokens in/out · not a bill",
          scout: "Scout mode",
          scoutDetail: "Read-only review. No edits from this station."
        }
      },
      chipTips: [
        {
          tip: "Before plan",
          detail: "Planner reviews the approach before the big plan"
        },
        {
          tip: "Same error ×2",
          detail: "Planner jumps in when the same failure loops"
        },
        {
          tip: "Before done",
          detail: "Planner does a final pass before ship"
        }
      ],
      /* Order matters: the first keyword found as a whole word of the hint name or
         agentId wins (split on non-letters and camelCase, so "misleading" is not "lead").
         Plural forms are listed on purpose; other words (such as "research") are not
         guessed. Nothing falls through to the Cursor substring logic. */
      hintRoles: [
        ["reviewer", "researcher"],
        ["reviewers", "researcher"],
        ["researcher", "explorer"],
        ["researchers", "explorer"],
        ["planner", "advisor"],
        ["planners", "advisor"],
        ["worker", "worker"],
        ["workers", "worker"],
        ["lead", "opus"],
        ["parent", "opus"]
      ],
      stations: {
        opus: "Parent agent: plans, reviews, and ships work",
        advisor: "Planner · peeks before plan, same-error ×2, and before done",
        worker: "Build buddy · edits, tests, and crate drops to merge",
        explorer: "Tiny scout · read-only search across the shelves",
        researcher: "Library buddy · read-only review and doc lookup"
      },
      pills: {
        opus: {
          text: "lead plans",
          tip: "Lead plans",
          detail: "Main session · plans, reviews, and ships"
        },
        sonnet: {
          text: "worker edits",
          tip: "Worker edits",
          detail: "Worker lane · code changes and tests"
        },
        haiku: {
          text: "scouts read",
          tip: "Scouts read",
          detail: "Researcher + reviewer · fast read-only scouts"
        },
        advisor: {
          text: "planner reviews",
          tip: "Planner reviews",
          detail: "Planner · checks before plan, same-error ×2, and before done"
        }
      },
      flows: {
        asks: "Lead pings Planner for a second look before big moves",
        delegates: "Work flows to Worker / Researcher / Reviewer, then into the merge portal"
      }
    }
  };

  /* Live tables. apply() refills these in place; nothing else replaces them. */
  var live = {
    labels: {},
    models: {},
    cardTips: {},
    chipTips: [],
    hintRoles: []
  };

  var activeId = "cursor";

  function fillTables(p) {
    refill(live.labels, p.labels);
    refill(live.models, p.models);
    refill(live.cardTips, p.cardTips);
    refill(live.chipTips, p.chipTips);
    refill(live.hintRoles, p.hintRoles);
  }

  function has(source) {
    return Object.prototype.hasOwnProperty.call(PROFILES, source);
  }

  function refill(target, src) {
    if (Array.isArray(target)) {
      target.length = 0;
    } else {
      Object.keys(target).forEach(function (key) {
        delete target[key];
      });
    }
    Object.keys(src).forEach(function (key) {
      target[key] = src[key];
    });
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function setTipAttrs(el, tip, detail) {
    if (!el) return;
    el.setAttribute("data-tip", tip);
    el.setAttribute("data-tip-detail", detail);
  }

  /* Model ids accepted by setModels: a sane id pattern, never markup or paths. */
  var MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
  var FAMILIES = ["opus", "fable", "sonnet", "haiku"];

  /**
   * List price text for a model id, from the read-only rate table in bill-math.js
   * (WorkshopBillMath.RATES + formatMoney). Not normalizeModel(): that guesses Opus for
   * anything unknown, and this row must not guess. Returns "" when no list price exists.
   */
  function listPriceFor(model) {
    var math = window.WorkshopBillMath;
    var tokens = String(model || "")
      .toLowerCase()
      .split(new RegExp("[^a-z]+"));
    if (!math || !math.RATES) return "";
    /* Whole tokens only ("octopus" is not opus), and exactly one family may appear. */
    var found = FAMILIES.filter(function (f) {
      return tokens.indexOf(f) >= 0;
    });
    if (found.length !== 1) return "";
    var rates = Object.prototype.hasOwnProperty.call(math.RATES, found[0])
      ? math.RATES[found[0]]
      : null;
    if (!rates) return "";
    return math.formatMoney(rates.in) + " / " + math.formatMoney(rates.out);
  }

  /** Price row for a slot under a profile: [amount text, label]. */
  function priceRowFor(p, slot) {
    if (p.prices) return p.prices[slot];
    var model = p.models[slot];
    if (!model) return ["model not set", "list price"];
    var price = listPriceFor(model);
    if (!price) return ["no list price", "list price"];
    return [price, "list price per 1M in/out"];
  }

  function updatePrices(p) {
    var doc = window.document;
    if (!doc) return;
    SLOT_KEYS.forEach(function (slot) {
      var card = doc.getElementById("card-" + slot);
      var el = card && card.querySelector(".price");
      if (!el) return;
      var row = priceRowFor(p, slot);
      el.textContent = "";
      el.appendChild(doc.createTextNode(row[0] + " "));
      var strong = doc.createElement("strong");
      strong.textContent = row[1];
      el.appendChild(strong);
    });
  }

  /** Writes the static HTML text this profile owns. Cursor writes the original strings. */
  function updateDom(p) {
    var doc = window.document;
    if (!doc) return;

    SLOT_KEYS.forEach(function (slot) {
      var card = doc.getElementById("card-" + slot);
      if (card) {
        setText(card.querySelector(".card-name"), p.cardTips[slot].name);
        setText(card.querySelector(".card-role"), p.cardTips[slot].role);
      }

      var station = doc.getElementById("char-" + slot);
      if (station) {
        setText(station.querySelector(".char-label"), p.labels[slot]);
        station.setAttribute("aria-label", p.labels[slot] + " station");
        setTipAttrs(station, p.labels[slot], p.stations[slot]);
      }
    });

    Object.keys(p.pills).forEach(function (cls) {
      var pill = doc.querySelector(".role-pill." + cls);
      if (!pill) return;
      setText(pill, p.pills[cls].text);
      setTipAttrs(pill, p.pills[cls].tip, p.pills[cls].detail);
    });

    updatePrices(p);
    setTipAttrs(doc.getElementById("asksLabel"), "Asks path", p.flows.asks);
    setTipAttrs(doc.getElementById("delegatesLabel"), "Delegates path", p.flows.delegates);
  }

  var RoleProfiles = {
    /** Profile object for a source id, or null when unknown. */
    get: function (source) {
      return has(source) ? PROFILES[source] : null;
    },

    /** Profile object for the active source. */
    current: function () {
      return PROFILES[activeId];
    },

    /** Live tables read by cards.js and app.js. Same object every call. */
    tables: function () {
      return live;
    },

    /** Price row [amount text, label] a slot shows under the active profile. */
    priceRow: function (slot) {
      return SLOT_KEYS.indexOf(slot) >= 0 ? priceRowFor(PROFILES[activeId], slot) : null;
    },

    /**
     * Fill the claude-code models table from data: { slot: modelId }. The later ingest
     * unit calls this with the model read from the agent file or session. Only the five
     * slot keys and ids matching /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/ are accepted ("" clears
     * a slot); otherwise returns false and changes nothing. The pattern allows "/" and "@" so
     * provider-prefixed ids (anthropic/claude-sonnet-4), Vertex ids (claude-opus-4-1@20250805)
     * and Bedrock ARNs pass; spaces, quotes, angle brackets and a leading symbol never do.
     * Slots not listed are kept. This is the only supported way to write the models table:
     * get("claude-code") hands out the live profile, so writing to it directly skips this check.
     * Under claude-code a slot with no model shows "model not set"; a model with no list
     * price in bill-math.js (or whose id names no family, or several) shows "no list price".
     * Text goes in through textContent only. Called while Cursor is active, it stores the
     * models in the claude-code profile; they show on the next apply("claude-code") and
     * Cursor stays unchanged.
     */
    setModels: function (map) {
      if (!map || typeof map !== "object" || Array.isArray(map)) return false;
      var keys = Object.keys(map);
      for (var i = 0; i < keys.length; i++) {
        var v = map[keys[i]];
        if (SLOT_KEYS.indexOf(keys[i]) < 0) return false;
        if (typeof v !== "string" || (v !== "" && !MODEL_ID_RE.test(v))) return false;
      }
      var cc = PROFILES["claude-code"];
      keys.forEach(function (k) {
        cc.models[k] = map[k];
      });
      if (activeId === "claude-code") {
        fillTables(cc);
        updatePrices(cc);
        if (window.AgentCards && typeof window.AgentCards.refreshRoleTips === "function") {
          window.AgentCards.refreshRoleTips();
        }
      }
      return true;
    },

    /**
     * Switch the displayed names to a source. Returns false for an unknown source and
     * changes nothing. Re-decorates station tips through AgentCards when it is loaded.
     */
    apply: function (source) {
      if (!has(source)) return false;
      var p = PROFILES[source];
      activeId = source;
      fillTables(p);
      updateDom(p);
      if (window.AgentCards && typeof window.AgentCards.refreshRoleTips === "function") {
        window.AgentCards.refreshRoleTips();
      }
      return true;
    }
  };

  fillTables(PROFILES.cursor);
  window.RoleProfiles = RoleProfiles;
})();
