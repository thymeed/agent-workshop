/**
 * Claude Code wire edge cases through the REAL bridge (neutral names, scratch inside the
 * worktree's gitignored .scratch/, discovery on a fake home with platform "linux"):
 *  1. a first poll that finds no session must not start the live phase: when the session then
 *     appears, its finished rows are a replay (no alert, no toast), and replay rows are marked.
 *  2. a child held for its parent's Agent result keeps its bounded hold in poll counts (one scan
 *     must not spin through it), so the spawn row still gets the model from the late result.
 *  3. a child whose meta arrives late keeps its meta wait the same way.
 *  4. one busy error on the first open of the session file, and 5. one on its lstat: the first
 *     successful read is still a silent replay (no alert, no toast, rows marked).
 *  6. a held child and 7. a child awaiting its meta next to a sibling larger than four read
 *     caps: the catch-up polls do not burn their waits.
 *  8. the drift counters and their timestamp reset when a newer session replaces the old one.
 *  9. a pending poll-counted wait (a child's failing first lstat, which leaves `more` false)
 *     keeps rows marked replay with no alert; once the wait ends the live phase starts.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const L = require("./helpers/claude-lines");

const SCRATCH = path.join(__dirname, "..", ".scratch", "u6b-wire-edge");
const HOME = path.join(SCRATCH, "home");
const PROJECTS = path.join(HOME, ".claude", "projects");
const HEADERS = {
  "Content-Type": "application/json",
  "Sec-Fetch-Site": "same-origin",
  "X-Cursor-Bridge": "1"
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {}
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null })
        );
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const get = (port, p) => request(port, { path: p });
const post = (port, p, body) =>
  request(port, { method: "POST", path: p, headers: HEADERS, body: JSON.stringify(body) });
const events = async (port) => (await get(port, "/api/events")).json.events;
const alertsOf = async (port) => (await get(port, "/api/alerts")).json.alerts;

async function waitFor(fn, what, ms) {
  const deadline = Date.now() + (ms || 15000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(50);
  }
}

const BIG_SIDE = JSON.stringify({ type: "system", pad: "x".repeat(60000) });
const childFirst = (agentId) =>
  JSON.stringify({
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: "go" },
    timestamp: "2026-01-02T03:05:00.000Z",
    sessionId: L.SESSION
  });

/** Child files: a big one (more than four read caps, already finished) and a small b1. */
function plantChildren(sub) {
  fs.mkdirSync(sub, { recursive: true });
  const bigLines = [childFirst("abig")];
  for (let i = 0; i < 22; i++) bigLines.push(BIG_SIDE);
  fs.writeFileSync(path.join(sub, "agent-abig.jsonl"), bigLines.join("\n") + "\n");
  assert.ok(fs.statSync(path.join(sub, "agent-abig.jsonl")).size > 4 * 256 * 1024);
  fs.writeFileSync(
    path.join(sub, "agent-abig.meta.json"),
    JSON.stringify({ agentType: "worker", toolUseId: "toolu_big" })
  );
  fs.writeFileSync(path.join(sub, "agent-b1.jsonl"), childFirst("b1") + "\n");
}

/** Make one call of fs[name] throw EBUSY when match(path, args) holds; restore() undoes it. */
function faultOnce(name, match) {
  const orig = fs[name];
  let hits = 0;
  fs[name] = function (p, ...a) {
    if (hits === 0 && match(String(p), a)) {
      hits += 1;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return orig.call(this, p, ...a);
  };
  return { hits: () => hits, restore: () => (fs[name] = orig) };
}

/** A project folder with one session file; returns its paths. */
function plant(name, label, lines) {
  const dir = path.join(PROJECTS, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, L.SESSION + ".jsonl");
  const head = JSON.stringify({ type: "user", cwd: "/home/user/" + label, sessionId: L.SESSION });
  fs.writeFileSync(file, [head, ...lines].join("\n") + "\n");
  return { dir, file };
}

async function selectProject(port, label) {
  const projects = (await get(port, "/api/projects")).json.projects;
  const proj = projects.find((p) => p.label === label);
  assert.ok(proj, label + " is listed");
  return proj;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  const cursorRoot = path.join(SCRATCH, "cursor-projects");
  const logDir = path.join(SCRATCH, "app-data");
  fs.mkdirSync(cursorRoot, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const one = plant("enc-one", "proj-one", [
    L.assistant([L.agentCall("toolu_1", "worker", "sonnet")]),
    L.agentResult("toolu_1", "agent1"),
    L.notification("toolu_1", "agent1", "completed")
  ]);
  const two = plant("enc-two", "proj-two", [L.userTurn("start")]);
  const three = plant("enc-three", "proj-three", [L.userTurn("start")]);

  const pastDone = [
    L.assistant([L.agentCall("toolu_a", "worker", "sonnet")]),
    L.agentResult("toolu_a", "agent-a"),
    L.notification("toolu_a", "agent-a", "completed"),
    L.assistant([L.agentCall("toolu_b", "worker", "sonnet")]),
    L.agentResult("toolu_b", "agent-b"),
    L.notification("toolu_b", "agent-b", "completed")
  ];
  const fault4 = {
    "enc-four": plant("enc-four", "proj-four", pastDone),
    "enc-five": plant("enc-five", "proj-five", pastDone)
  };
  const six = plant("enc-six", "proj-six", [
    L.assistant([L.agentCall("toolu_big", "worker", "sonnet")]),
    L.agentResult("toolu_big", "abig"),
    L.assistant([L.agentCall("toolu_h2", "Explore")])
  ]);
  const sub6 = path.join(six.dir, L.SESSION, "subagents");
  plantChildren(sub6);
  fs.writeFileSync(
    path.join(sub6, "agent-b1.meta.json"),
    JSON.stringify({ agentType: "Explore", toolUseId: "toolu_h2" })
  );
  const seven = plant("enc-seven", "proj-seven", [
    L.assistant([L.agentCall("toolu_big", "worker", "sonnet")]),
    L.agentResult("toolu_big", "abig"),
    L.assistant([L.agentCall("toolu_m2", "Explore")]),
    L.agentResult("toolu_m2", "b1", L.SESSION, "claude-haiku-5-5")
  ]);
  const sub7 = path.join(seven.dir, L.SESSION, "subagents");
  plantChildren(sub7);
  const eight = plant("enc-eight", "proj-eight", [
    L.assistant([L.agentCall("toolu_d", "worker", "sonnet")]),
    L.notification("toolu_d", "agent-d", "weirdstatus")
  ]);

  const nine = plant("enc-nine", "proj-nine", [
    L.assistant([L.agentCall("toolu_a", "worker", "sonnet")]),
    L.agentResult("toolu_a", "a1"),
    L.notification("toolu_a", "agent-a", "completed")
  ]);
  const sub9 = path.join(nine.dir, L.SESSION, "subagents");
  fs.mkdirSync(sub9, { recursive: true });
  fs.writeFileSync(path.join(sub9, "agent-a1.jsonl"), childFirst("a1") + "\n");
  fs.writeFileSync(
    path.join(sub9, "agent-a1.meta.json"),
    JSON.stringify({ agentType: "worker", toolUseId: "toolu_a" })
  );

  const { startBridge, stopBridge } = require("../live-bridge.js");
  const toasts = [];
  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    projectsRoot: cursorRoot,
    eventLogDir: logDir,
    reuseExisting: false,
    onAgentAlert: (a) => toasts.push(a),
    claudeCode: { platform: "linux", homedir: HOME }
  });
  try {
    assert.strictEqual((await post(port, "/api/source", { source: "claude-code" })).status, 200);

    // ---- 1. the session is missing for the first polls, then appears ----
    const p1 = await selectProject(port, "proj-one");
    const hidden = one.file + ".hidden";
    fs.renameSync(one.file, hidden);
    assert.strictEqual((await post(port, "/api/select", { id: p1.id })).status, 200);
    await sleep(2500); // at least two scans with no session
    fs.renameSync(hidden, one.file);
    await waitFor(async () => (await events(port)).some((e) => e.type === "done"), "done row");
    await sleep(1500);
    assert.strictEqual(
      (await alertsOf(port)).length,
      0,
      "the late-appearing session raised no alert"
    );
    assert.strictEqual(toasts.length, 0, "and no toast");
    const done = (await events(port)).find((e) => e.type === "done");
    assert.strictEqual(done.replay, true, "replay rows are marked on the wire");
    // a row appended now is live: it alerts and is not marked
    fs.appendFileSync(
      one.file,
      [
        L.assistant([L.agentCall("toolu_5", "worker", "sonnet")]),
        L.notification("toolu_5", "agent5", "completed")
      ].join("\n") + "\n"
    );
    await waitFor(async () => (await alertsOf(port)).length === 1, "the live alert");
    const live = (await events(port)).find((e) => e.type === "done" && e.toolUseId === "toolu_5");
    assert.ok(live && live.replay === undefined, "live rows carry no replay mark");

    // ---- 2. a child held for the parent's Agent result keeps its hold in polls ----
    const p2 = await selectProject(port, "proj-two");
    assert.strictEqual((await post(port, "/api/select", { id: p2.id })).status, 200);
    await waitFor(
      async () => (await events(port)).some((e) => e.kind === "status"),
      "caught up two"
    );
    await sleep(1200);
    const sub2 = path.join(two.dir, L.SESSION, "subagents");
    fs.appendFileSync(two.file, L.assistant([L.agentCall("toolu_h", "Explore")]) + "\n");
    fs.mkdirSync(sub2, { recursive: true });
    fs.writeFileSync(
      path.join(sub2, "agent-a1.jsonl"),
      JSON.stringify({
        isSidechain: true,
        agentId: "a1",
        type: "user",
        message: { role: "user", content: "go" },
        timestamp: "2026-01-02T03:05:00.000Z",
        sessionId: L.SESSION
      }) + "\n"
    );
    fs.writeFileSync(
      path.join(sub2, "agent-a1.meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_h" })
    );
    await sleep(1500);
    fs.appendFileSync(
      two.file,
      L.agentResult("toolu_h", "a1", L.SESSION, "claude-haiku-5-5") + "\n"
    );
    const spawn2 = await waitFor(
      async () => (await events(port)).find((e) => e.type === "spawn" && e.agentId === "a1"),
      "held child spawn row"
    );
    assert.deepStrictEqual(
      [spawn2.role, spawn2.modelLabel],
      ["explorer", "Haiku"],
      "the hold lasted until the Agent result"
    );

    // ---- 3. a child whose meta arrives late keeps its meta wait ----
    const p3 = await selectProject(port, "proj-three");
    assert.strictEqual((await post(port, "/api/select", { id: p3.id })).status, 200);
    await waitFor(
      async () => (await events(port)).some((e) => e.kind === "status"),
      "caught up three"
    );
    await sleep(1200);
    fs.appendFileSync(
      three.file,
      [
        L.assistant([L.agentCall("toolu_m", "Explore")]),
        L.agentResult("toolu_m", "a1", L.SESSION, "claude-haiku-5-5")
      ].join("\n") + "\n"
    );
    await sleep(1200);
    const sub3 = path.join(three.dir, L.SESSION, "subagents");
    fs.mkdirSync(sub3, { recursive: true });
    fs.writeFileSync(
      path.join(sub3, "agent-a1.jsonl"),
      JSON.stringify({
        isSidechain: true,
        agentId: "a1",
        type: "user",
        message: { role: "user", content: "go" },
        timestamp: "2026-01-02T03:05:00.000Z",
        sessionId: L.SESSION
      }) + "\n"
    );
    await sleep(1200); // the meta lands after the child is first listed (two polls tolerate this)
    fs.writeFileSync(
      path.join(sub3, "agent-a1.meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_m" })
    );
    const spawn3 = await waitFor(
      async () => (await events(port)).find((e) => e.type === "spawn" && e.agentId === "a1"),
      "meta-wait child spawn row"
    );
    assert.deepStrictEqual([spawn3.role, spawn3.modelLabel], ["explorer", "Haiku"]);

    // ---- 4 and 5. one busy error on the first read: still a silent replay ----
    const faults = [
      ["open", "enc-four", "proj-four", "openSync", (p, file) => p === file],
      [
        "lstat",
        "enc-five",
        "proj-five",
        "lstatSync",
        (p, file, a) => p === file && !!(a[0] && a[0].bigint)
      ]
    ];
    for (const [what, enc, label, fn, match] of faults) {
      const planted = fault4[enc];
      const proj = await selectProject(port, label);
      const alertsBefore = (await alertsOf(port)).length;
      const toastsBefore = toasts.length;
      const fault = faultOnce(fn, (p, a) => match(p, planted.file, a));
      try {
        assert.strictEqual((await post(port, "/api/select", { id: proj.id })).status, 200);
        await waitFor(() => fault.hits() === 1, "the " + what + " fault");
      } finally {
        fault.restore();
      }
      const rows = await waitFor(
        async () => {
          const dones = (await events(port)).filter((e) => e.type === "done");
          return dones.length === 2 ? dones : null;
        },
        "both finish rows after the " + what + " fault"
      );
      await sleep(1500);
      assert.deepStrictEqual(
        rows.map((e) => e.replay),
        [true, true],
        "after a failed " + what + " the finish rows are still marked replay"
      );
      assert.strictEqual((await alertsOf(port)).length, alertsBefore, what + ": no alert");
      assert.strictEqual(toasts.length, toastsBefore, what + ": no toast");
    }

    // ---- 6. a held child next to a sibling larger than four read caps ----
    const p6 = await selectProject(port, "proj-six");
    assert.strictEqual((await post(port, "/api/select", { id: p6.id })).status, 200);
    await sleep(1500);
    fs.appendFileSync(
      six.file,
      L.agentResult("toolu_h2", "b1", L.SESSION, "claude-haiku-5-5") + "\n"
    );
    const spawn6 = await waitFor(
      async () => (await events(port)).find((e) => e.type === "spawn" && e.agentId === "b1"),
      "held child spawn row beside a big sibling"
    );
    assert.deepStrictEqual(
      [spawn6.role, spawn6.modelLabel],
      ["explorer", "Haiku"],
      "the big sibling's catch-up polls did not burn the hold"
    );

    // ---- 7. a child awaiting its meta next to a sibling larger than four read caps ----
    const p7 = await selectProject(port, "proj-seven");
    assert.strictEqual((await post(port, "/api/select", { id: p7.id })).status, 200);
    await sleep(1200);
    fs.writeFileSync(
      path.join(sub7, "agent-b1.meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_m2" })
    );
    const spawn7 = await waitFor(
      async () => (await events(port)).find((e) => e.type === "spawn" && e.agentId === "b1"),
      "meta-wait child spawn row beside a big sibling"
    );
    assert.deepStrictEqual(
      [spawn7.role, spawn7.modelLabel],
      ["explorer", "Haiku"],
      "the big sibling's catch-up polls did not burn the meta wait"
    );

    // ---- 8. drift counters reset when a newer session replaces the old one ----
    const p8 = await selectProject(port, "proj-eight");
    assert.strictEqual((await post(port, "/api/select", { id: p8.id })).status, 200);
    const st8 = await waitFor(async () => {
      const st = (await get(port, "/api/status")).json;
      return st.drift.unknownStatus >= 1 && st.drift.lastAt ? st : null;
    }, "the unknown status counted");
    assert.ok(st8.drift.lastAt, "the drift time is set");
    const SESSION_B = "99999999-8888-4777-8666-555555555555";
    const session8b = path.join(eight.dir, SESSION_B + ".jsonl");
    fs.writeFileSync(session8b, L.userTurn("next", SESSION_B) + "\n");
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(session8b, later, later);
    await waitFor(
      async () => (await get(port, "/api/status")).json.ingest.sessions === 2,
      "the newer session",
      20000
    );
    await sleep(2000);
    const after8 = (await get(port, "/api/status")).json;
    assert.strictEqual(after8.drift.unknownStatus, 0, "the session's unknown-status count reset");
    assert.strictEqual(after8.drift.lastAt, null, "and so did the drift time");

    // ---- 9. a pending poll-counted wait keeps the replay: no live phase, no alert ----
    // The child's first lstat keeps failing (EBUSY) for its 3-poll fault budget. The parent is
    // read to its end, nothing is capped and `more` is false, so only `!st.waiting` holds the
    // live phase back. A finish row appended inside the wait is still a replay row.
    const p9 = await selectProject(port, "proj-nine");
    const child9 = path.join(nine.dir, L.SESSION, "subagents", "agent-a1.jsonl");
    const alertsBefore9 = (await alertsOf(port)).length;
    const toastsBefore9 = toasts.length;
    const origLstat = fs.lstatSync;
    let faultHits = 0;
    let faultOn = true;
    fs.lstatSync = function (p, ...a) {
      if (faultOn && String(p) === child9 && a[0] && a[0].bigint) {
        faultHits += 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return origLstat.call(this, p, ...a);
    };
    try {
      assert.strictEqual((await post(port, "/api/select", { id: p9.id })).status, 200);
      await waitFor(
        async () => (await events(port)).some((e) => e.type === "done"),
        "the replayed finish row of the wait project"
      );
      assert.ok(faultHits >= 1, "the child's lstat failed while the parent was replayed");
      fs.appendFileSync(
        nine.file,
        [
          L.assistant([L.agentCall("toolu_w", "worker", "sonnet")]),
          L.notification("toolu_w", "agent-w", "completed")
        ].join("\n") + "\n"
      );
      const inWait = await waitFor(async () => {
        const dones = (await events(port)).filter((e) => e.type === "done");
        return dones.length === 2 ? dones : null;
      }, "the finish row appended during the wait");
      assert.deepStrictEqual(
        inWait.map((e) => e.replay),
        [true, true],
        "rows read while a wait is pending stay marked replay"
      );
      assert.strictEqual(
        (await alertsOf(port)).length,
        alertsBefore9,
        "no alert while a wait is pending"
      );
      assert.strictEqual(toasts.length, toastsBefore9, "and no toast");
      // the fault budget (3 regular polls) runs out: the wait ends and the live phase starts
      await sleep(4500);
    } finally {
      faultOn = false;
      fs.lstatSync = origLstat;
    }
    fs.appendFileSync(
      nine.file,
      [
        L.assistant([L.agentCall("toolu_x", "worker", "sonnet")]),
        L.notification("toolu_x", "agent-x", "completed")
      ].join("\n") + "\n"
    );
    await waitFor(
      async () => (await alertsOf(port)).length === alertsBefore9 + 1,
      "the alert after the wait"
    );
    const after9 = (await events(port)).find((e) => e.type === "done" && e.toolUseId === "toolu_x");
    assert.ok(after9 && after9.replay === undefined, "the row after the wait is live");

    console.log(
      "claude-code-wire-edge OK · late session replays silently, hold and meta wait kept"
    );
  } finally {
    await stopBridge();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
