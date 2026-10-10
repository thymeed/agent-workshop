/**
 * Transcript → history: warm-up dedupe, structured terminal, stall/alerts.
 */
"use strict";

process.env.BRIDGE_TEST = "1";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const {
  startBridge,
  stopBridge,
  scanTranscripts,
  checkStalledAgents,
  selectProject,
  terminalTypeFromTranscript,
  TRANSCRIPT_SCAN_LIMIT,
  TRANSCRIPT_READ_MAX_PER_POLL
} = require("../live-bridge.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function tmpTranscripts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-history-"));
  const parent = path.join(root, "parent.jsonl");
  const subDir = path.join(root, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  return { root, parent, subDir };
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function line(role, text, extra) {
  extra = extra || {};
  const ts =
    extra.timestamp != null
      ? extra.timestamp
      : new Date(Date.now() + (extra.tsOffsetMs || 0)).toISOString();
  const rest = Object.assign({}, extra);
  delete rest.timestamp;
  delete rest.tsOffsetMs;
  return Object.assign(
    {
      role,
      timestamp: ts,
      message: { content: [{ type: "text", text }] }
    },
    rest
  );
}

async function withBridge(dir, fn, opts) {
  opts = opts || {};
  const logDir = opts.logDir || fs.mkdtempSync(path.join(os.tmpdir(), "transcript-log-"));
  const ownedProjectsRoot = !opts.projectsRoot;
  const projectsRoot =
    opts.projectsRoot || fs.mkdtempSync(path.join(os.tmpdir(), "transcript-projects-"));
  const alerts = [];
  const port = await getFreePort();
  await startBridge(
    Object.assign(
      {
        port,
        quiet: true,
        dir,
        projectsRoot,
        eventLogDir: logDir,
        stallMs: 50,
        onAgentAlert: (a) => alerts.push(a)
      },
      opts
    )
  );
  try {
    await fn({ logDir, alerts, port });
  } finally {
    await stopBridge();
    if (!opts.keepLogDir) {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    }
    if (ownedProjectsRoot) {
      try {
        fs.rmSync(projectsRoot, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

function historyEvents(logDir) {
  const { createEventLog } = require("../lib/event-log");
  return createEventLog({ logDir, retentionMs: 365 * 24 * 60 * 60 * 1000 }).query();
}

function fetchLiveEvents(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/api/events`, (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).events || []);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function fetchAlerts(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/api/alerts`, (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Open SSE /api/stream and collect named `alert` events until timeout or count.
 * @param {number} port
 * @param {{count?:number, timeoutMs?:number}} [opts]
 */
function collectSseAlerts(port, opts) {
  opts = opts || {};
  const want = opts.count != null ? opts.count : 1;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 4000;
  return new Promise((resolve, reject) => {
    const found = [];
    let buf = "";
    let settled = false;
    const req = http.get(`http://127.0.0.1:${port}/api/stream`, (res) => {
      res.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const block of parts) {
          const lines = block.split("\n");
          let eventName = "";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
          }
          if (eventName !== "alert" || !dataLine) continue;
          try {
            found.push(JSON.parse(dataLine));
          } catch (_e) {
            /* ignore */
          }
          if (found.length >= want && !settled) {
            settled = true;
            clearTimeout(timer);
            req.destroy();
            resolve(found);
          }
        }
      });
      res.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(found);
    }, timeoutMs);
  });
}

function transcriptLiveEvents(liveEvents) {
  return liveEvents.filter(
    (e) => e && e.source !== "bridge" && String(e.message || "").includes("warm-tail-")
  );
}

function seedParentTranscriptForWarmTail(parentFile, lineCount) {
  for (let i = 0; i < lineCount; i++) {
    appendLine(
      parentFile,
      line("user", `<user_query>warm-tail-${i} ${"p".repeat(500)}</user_query>`, {
        tsOffsetMs: -200000 + i * 1000
      })
    );
    appendLine(
      parentFile,
      line("assistant", `reply warm-tail-${i} ${"q".repeat(500)}`, {
        tsOffsetMs: -199000 + i * 1000
      })
    );
  }
  assert(
    fs.statSync(parentFile).size > 8 * 1024,
    "warm-tail fixture must exceed 8 KB for tail ingest"
  );
}

async function testRestartDedupeAndTimestamps() {
  const { root, parent } = tmpTranscripts();
  const tsWarm = new Date(Date.now() - 5000).toISOString();
  const tsNew = new Date().toISOString();
  appendLine(parent, line("user", "<user_query>hello</user_query>", { timestamp: tsWarm }));

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-log-dedupe-"));
  try {
    await withBridge(
      root,
      async ({ logDir: ld }) => {
        scanTranscripts();
        assert(historyEvents(ld).length === 0, "warm-up must not persist history");

        appendLine(
          parent,
          line("user", "<user_query>second turn</user_query>", { timestamp: tsNew })
        );
        scanTranscripts();
        const after = historyEvents(ld);
        assert(after.length === 1, "only new line recorded, got " + after.length);
        assert(after[0].ts === tsNew, "preserve transcript timestamp");
      },
      { logDir, keepLogDir: true }
    );

    await withBridge(
      root,
      async ({ logDir: ld }) => {
        scanTranscripts();
        const again = historyEvents(ld);
        assert(again.length === 1, "bridge restart must not duplicate warm-up tail");
      },
      { logDir, keepLogDir: true }
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  fs.rmSync(root, { recursive: true, force: true });
}

async function testKeywordFalsePositiveAndStructuredTerminal() {
  const prose = terminalTypeFromTranscript(
    line("assistant", "We fixed the error handling and are not done yet.")
  );
  assert(prose === null, "prose must not mark done/error");

  const done = terminalTypeFromTranscript(line("assistant", "<final>shipped</final>"));
  assert(done === "done", "final marker is structured done");

  const structuredErr = terminalTypeFromTranscript(
    line("assistant", "<error>task aborted</error>")
  );
  assert(structuredErr === "error", "error tag is structured terminal failure");

  const toolErr = terminalTypeFromTranscript({
    role: "user",
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "fail" }]
    }
  });
  assert(toolErr === null, "tool_result is_error must not be terminal error");

  const { root, subDir } = tmpTranscripts();
  const subId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "You are the Implementation worker.", { tsOffsetMs: -3000 }));
  appendLine(
    subFile,
    line("assistant", "We fixed the error handling in the module.", { tsOffsetMs: -2000 })
  );

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    scanTranscripts();
    const events = historyEvents(logDir);
    assert(events.length === 0, "warm-up only for subagent file");

    appendLine(subFile, line("assistant", "Still working on error messages."));
    scanTranscripts();
    const ev = historyEvents(logDir);
    assert(ev.length === 1 && ev[0].type === "turn", "prose error must stay turn");
    assert(!alerts.some((a) => a.status === "error"), "no error alert on prose");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testOneAlertPerTerminalChange() {
  const { root, subDir } = tmpTranscripts();
  const subId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "Implementation worker task", { tsOffsetMs: -3000 }));

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    appendLine(subFile, line("assistant", "<final>complete</final>", { tsOffsetMs: -1000 }));
    scanTranscripts();
    appendLine(subFile, line("assistant", "<final>again</final>"));
    scanTranscripts();

    const finished = alerts.filter((a) => a.status === "finished");
    assert(finished.length === 1, "one finished alert per agent, got " + finished.length);
    const doneRows = historyEvents(logDir).filter((e) => e.type === "done");
    assert(doneRows.length === 2, "both done rows may persist");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testNoPhantomParentStall() {
  const { root, parent } = tmpTranscripts();
  appendLine(parent, line("user", "<user_query>parent only</user_query>"));

  await withBridge(root, async ({ alerts }) => {
    scanTranscripts();
    appendLine(parent, line("assistant", "reply without final"));
    scanTranscripts();
    await new Promise((r) => setTimeout(r, 80));
    checkStalledAgents();
    assert(!alerts.some((a) => a.status === "stalled"), "parent must not stall-alert");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testNewFileReadFromOffsetZero() {
  const { root, subDir } = tmpTranscripts();
  const subId = "dddddddd-eeee-ffff-0000-111111111111";
  const subFile = path.join(subDir, subId + ".jsonl");

  await withBridge(root, async ({ logDir }) => {
    scanTranscripts();
    appendLine(subFile, line("user", "You are the Implementation worker."));
    scanTranscripts();
    const events = historyEvents(logDir);
    assert(
      events.some((e) => e.type === "spawn" && e.agentId === subId),
      "new transcript file must record spawn from first line"
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testToolErrorNotTerminal() {
  const { root, subDir } = tmpTranscripts();
  const subId = "eeeeeeee-ffff-0000-1111-222222222222";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "Implementation worker task", { tsOffsetMs: -3000 }));

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    appendLine(
      subFile,
      line("user", "tool failed", {
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "command failed" }
          ]
        }
      })
    );
    scanTranscripts();
    appendLine(subFile, line("assistant", "<final>recovered</final>"));
    scanTranscripts();

    assert(
      !historyEvents(logDir).some((e) => e.type === "error"),
      "tool error must not log error row"
    );
    const errorAlerts = alerts.filter((a) => a.status === "error");
    assert(errorAlerts.length === 0, "tool error must not alert, got " + errorAlerts.length);
    assert(
      alerts.filter((a) => a.status === "finished").length === 1,
      "agent should still finish after tool error"
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testStructuredTerminalErrorAlert() {
  const { root, subDir } = tmpTranscripts();
  const subId = "ffffffff-0000-1111-2222-333333333333";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "Implementation worker task", { tsOffsetMs: -3000 }));

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    appendLine(subFile, line("assistant", "<error>unrecoverable failure</error>"));
    scanTranscripts();

    const errors = historyEvents(logDir).filter((e) => e.type === "error");
    assert(errors.length === 1, "structured error should log one error row");
    const errorAlerts = alerts.filter((a) => a.status === "error");
    assert(errorAlerts.length === 1, "structured error should alert once");
    assert(!alerts.some((a) => a.status === "finished"), "error terminal should not finish");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testResumedOldTranscriptBeyondScanLimit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-many-"));
  const now = Date.now() / 1000;
  const oldFile = path.join(root, "chat-040.jsonl");
  assert(TRANSCRIPT_SCAN_LIMIT === 40, "test assumes scan limit 40");

  for (let i = 0; i < TRANSCRIPT_SCAN_LIMIT; i++) {
    const f = path.join(root, `chat-${String(i).padStart(3, "0")}.jsonl`);
    appendLine(f, line("user", `<user_query>chat ${i}</user_query>`));
    fs.utimesSync(f, now, now);
  }
  appendLine(
    oldFile,
    line("user", "<user_query>old session</user_query>", { tsOffsetMs: -200000 })
  );
  appendLine(
    oldFile,
    line("assistant", "<final>old session complete</final>", { tsOffsetMs: -190000 })
  );
  fs.utimesSync(oldFile, now - 7200, now - 7200);

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    assert(historyEvents(logDir).length === 0, "warm-up must not log history");
    assert(!alerts.some((a) => a.status === "finished"), "no stale finished on warm-up");

    appendLine(oldFile, line("assistant", "resumed work after idle"));
    // Strictly newest mtime so this file enters the scan window (ties exclude it).
    fs.utimesSync(oldFile, now + 120, now + 120);
    scanTranscripts();

    const events = historyEvents(logDir);
    assert(events.length === 1, "only resumed line logged, got " + events.length);
    assert(events[0].type === "turn", "resumed line is a turn");
    assert(!alerts.some((a) => a.status === "finished"), "no stale finished alert on resume");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testStartupWarmPushesLiveEvents() {
  const { root, parent } = tmpTranscripts();
  seedParentTranscriptForWarmTail(parent, 24);

  await withBridge(root, async ({ port }) => {
    const live = await fetchLiveEvents(port);
    const fromTranscript = transcriptLiveEvents(live);
    assert(
      fromTranscript.length >= 2,
      "startup warm-up must push live transcript events from 8 KB tail, got " +
        fromTranscript.length
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testProjectSwitchWarmPushesLiveEvents() {
  const stamp = String(Date.now());
  const idA = "cursor-warm-live-a-" + stamp;
  const idB = "cursor-warm-live-b-" + stamp;
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-projects-root-"));
  const dirA = path.join(projectsRoot, idA, "agent-transcripts");
  const dirB = path.join(projectsRoot, idB, "agent-transcripts");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const parentA = path.join(dirA, "parent.jsonl");
  const parentB = path.join(dirB, "parent.jsonl");
  seedParentTranscriptForWarmTail(parentA, 20);
  seedParentTranscriptForWarmTail(parentB, 20);

  const port = await getFreePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-project-switch-log-"));
  const prevProjectsRoot = process.env.CURSOR_PROJECTS_ROOT;
  process.env.CURSOR_PROJECTS_ROOT = projectsRoot;
  try {
    await startBridge({ port, quiet: true, dir: dirA, eventLogDir: logDir });
    let live = transcriptLiveEvents(await fetchLiveEvents(port));
    assert(live.length >= 2, "project A startup must warm live feed, got " + live.length);

    const switched = selectProject(idB);
    assert(switched.ok, "select project B: " + (switched.error || ""));
    live = transcriptLiveEvents(await fetchLiveEvents(port));
    assert(live.length >= 2, "project switch must warm live feed, got " + live.length);
  } finally {
    await stopBridge();
    if (prevProjectsRoot === undefined) delete process.env.CURSOR_PROJECTS_ROOT;
    else process.env.CURSOR_PROJECTS_ROOT = prevProjectsRoot;
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  }
}

async function testResumedOldFileLargeAppendBeforeFirstPoll() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-resume-bulk-"));
  const now = Date.now() / 1000;
  const oldFile = path.join(root, "chat-040.jsonl");
  assert(TRANSCRIPT_SCAN_LIMIT === 40, "test assumes scan limit 40");

  for (let i = 0; i < TRANSCRIPT_SCAN_LIMIT; i++) {
    const f = path.join(root, `chat-${String(i).padStart(3, "0")}.jsonl`);
    appendLine(f, line("user", `<user_query>chat ${i}</user_query>`));
    fs.utimesSync(f, now, now);
  }
  appendLine(
    oldFile,
    line("user", "<user_query>old session baseline</user_query>", { tsOffsetMs: -200000 })
  );
  fs.utimesSync(oldFile, now - 7200, now - 7200);

  const resumeTimestamps = [];
  for (let i = 0; i < 6; i++) {
    resumeTimestamps.push(`2030-02-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`);
  }

  await withBridge(root, async ({ logDir }) => {
    scanTranscripts();
    assert(historyEvents(logDir).length === 0, "warm-up must not log history");

    const bytesBeforeAppend = fs.statSync(oldFile).size;
    for (let i = 0; i < resumeTimestamps.length; i++) {
      const pad = "z".repeat(1800);
      appendLine(
        oldFile,
        line("user", `<user_query>resume-bulk-${i} ${pad}</user_query>`, {
          timestamp: resumeTimestamps[i]
        })
      );
    }
    assert(
      fs.statSync(oldFile).size - bytesBeforeAppend > 8 * 1024,
      "appended payload must exceed 8 KB before first poll on resumed file"
    );

    fs.utimesSync(oldFile, now + 120, now + 120);
    scanTranscripts();

    const events = historyEvents(logDir);
    assert(
      events.length === resumeTimestamps.length,
      "all post-snapshot bytes must reach history in one poll, got " + events.length
    );
    for (const ts of resumeTimestamps) {
      assert(
        events.some((e) => e.ts === ts && e.type === "turn"),
        "missing history for resumed bulk line at " + ts
      );
    }
  });

  fs.rmSync(root, { recursive: true, force: true });
}

function appendBigUserLine(file, marker, padBytes) {
  const pad = "a".repeat(Math.max(0, padBytes));
  appendLine(file, line("user", `<user_query>${marker} ${pad}</user_query>`));
}

function historyLogRaw(logDir) {
  return fs.readFileSync(path.join(logDir, "event-log.jsonl"), "utf8");
}

function writeUtf8Chunks(fd, text, chunkSize) {
  const piece = "x".repeat(Math.min(chunkSize, 65536));
  let written = 0;
  while (written < text) {
    const n = Math.min(piece.length, text - written);
    fs.writeSync(fd, n === piece.length ? piece : piece.slice(0, n));
    written += n;
  }
}

/** One JSONL line longer than minLineBytes (UTF-8), without holding the full pad in memory. */
function appendOversizedAssistantLine(file, minLineBytes, opts) {
  opts = opts || {};
  const ts = new Date().toISOString();
  const prefix = `{"role":"assistant","timestamp":"${ts}","message":{"content":[{"type":"text","text":"`;
  const suffix = '"}]}}\n';
  const overhead = Buffer.byteLength(prefix + suffix, "utf8");
  const padLen = Math.max(0, minLineBytes - overhead);
  const embedSecret = opts.embedSecret || "";
  const secretAt = opts.secretByteOffset != null ? opts.secretByteOffset : Math.floor(padLen / 2);
  const chunk = 65536;
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, prefix);
    const beforeSecret = Math.min(secretAt, padLen);
    writeUtf8Chunks(fd, beforeSecret, chunk);
    if (embedSecret && beforeSecret < padLen) {
      fs.writeSync(fd, embedSecret);
      const afterSecret = Math.max(
        0,
        padLen - beforeSecret - Buffer.byteLength(embedSecret, "utf8")
      );
      writeUtf8Chunks(fd, afterSecret, chunk);
    } else if (beforeSecret < padLen) {
      writeUtf8Chunks(fd, padLen - beforeSecret, chunk);
    }
    fs.writeSync(fd, suffix);
  } finally {
    fs.closeSync(fd);
  }
}

async function testResumedLargeFileNonAscii() {
  const { root, parent } = tmpTranscripts();
  const em = "\u2014";
  let bytes = 0;
  while (bytes < 12000) {
    const text = em.repeat(80) + " pad " + bytes;
    appendLine(parent, line("user", `<user_query>${text}</user_query>`));
    bytes = fs.statSync(parent).size;
  }
  appendLine(parent, line("assistant", "<final>warm terminal</final>"));

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    assert(historyEvents(logDir).length === 0, "warm-up must not log history");
    assert(!alerts.some((a) => a.status === "finished"), "no stale finished on large tail warm-up");

    const tsNew = new Date().toISOString();
    appendLine(
      parent,
      line("user", `<user_query>resumed ${em} turn</user_query>`, { timestamp: tsNew })
    );
    scanTranscripts();

    const events = historyEvents(logDir);
    assert(events.length === 1, "only resumed line logged, got " + events.length);
    assert(events[0].ts === tsNew, "preserve transcript timestamp on resumed large file");
    assert(!alerts.some((a) => a.status === "finished"), "warm final must not alert on resume");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testOversizedLineSkippedNoStall() {
  const { root, subDir } = tmpTranscripts();
  const subId = "11111111-2222-3333-4444-555555555555";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "Implementation worker task", { tsOffsetMs: -3000 }));

  const fakeSecret = "ghp_OVERSIZED_SKIP_TEST_PROBE_a1b2c3d4e5f6";
  const secretProbe = "OVERSIZED_SKIP_TEST_PROBE";
  const tsAfterSkip = "2028-03-15T18:22:11.000Z";

  await withBridge(root, async ({ logDir, alerts }) => {
    scanTranscripts();
    appendOversizedAssistantLine(subFile, TRANSCRIPT_READ_MAX_PER_POLL + 80 * 1024, {
      embedSecret: fakeSecret,
      secretByteOffset: 200000
    });
    appendLine(
      subFile,
      line("assistant", "normal line after oversized skip", { timestamp: tsAfterSkip })
    );
    appendLine(subFile, line("assistant", "<final>ok after skip</final>"));

    for (let i = 0; i < 8; i++) {
      scanTranscripts();
    }

    const rawLog = historyLogRaw(logDir);
    assert(
      !rawLog.includes(fakeSecret) && !rawLog.includes(secretProbe),
      "skipped oversized line must not leak any fragment into history log"
    );
    assert(
      !rawLog.includes("ghp_OVERSIZED_SKIP"),
      "no partial secret prefix from skipped line in history"
    );

    const events = historyEvents(logDir);
    assert(
      events.some((e) => e.type === "turn" && e.ts === tsAfterSkip),
      "normal line after oversized row must reach history"
    );
    assert(
      events.some((e) => e.type === "done"),
      "terminal done after skip"
    );
    assert(
      !alerts.some((a) => a.status === "stalled"),
      "must not stall when offset skips huge line"
    );

    await new Promise((r) => setTimeout(r, 80));
    checkStalledAgents();
    assert(!alerts.some((a) => a.status === "stalled"), "stall check after skip ingest");
    assert(
      alerts.filter((a) => a.status === "finished").length === 1,
      "one finished alert, got " + alerts.filter((a) => a.status === "finished").length
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testChunkedReadCappedPerPoll() {
  const { root, parent } = tmpTranscripts();
  appendLine(parent, line("user", "<user_query>bootstrap</user_query>"));

  const lineBytes = 72000;
  assert(
    lineBytes * 4 > TRANSCRIPT_READ_MAX_PER_POLL,
    "four padded lines must exceed per-poll read cap"
  );

  await withBridge(root, async ({ logDir }) => {
    scanTranscripts();
    const base = historyEvents(logDir).length;

    for (let i = 0; i < 4; i++) {
      appendBigUserLine(parent, `chunk-line-${i}`, lineBytes);
    }
    scanTranscripts();
    const afterFirst = historyEvents(logDir).length - base;
    scanTranscripts();
    const afterSecond = historyEvents(logDir).length - base;

    assert(afterSecond === 4, "all appended lines recorded after two polls, got " + afterSecond);
    assert(
      afterFirst > 0 && afterFirst < 4,
      "first poll must process a partial chunk, got " + afterFirst
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testSubagentFinishedNotStalled() {
  const { root, subDir } = tmpTranscripts();
  const subId = "cccccccc-dddd-eeee-ffff-000000000001";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "explorer task"));

  await withBridge(root, async ({ alerts }) => {
    scanTranscripts();
    appendLine(subFile, line("assistant", "<final>ok</final>"));
    scanTranscripts();
    await new Promise((r) => setTimeout(r, 80));
    checkStalledAgents();
    assert(
      alerts.some((a) => a.status === "finished"),
      "subagent finished alert"
    );
    assert(!alerts.some((a) => a.status === "stalled"), "finished subagent must not stall");
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function testAlertBusSseAndApi() {
  const { root, subDir } = tmpTranscripts();
  const subId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001";
  const subFile = path.join(subDir, subId + ".jsonl");
  appendLine(subFile, line("user", "Implementation worker task", { tsOffsetMs: -3000 }));

  await withBridge(root, async ({ alerts, port }) => {
    scanTranscripts();

    const ssePromise = collectSseAlerts(port, { count: 1, timeoutMs: 5000 });
    // Let the SSE client attach before the terminal emit.
    await new Promise((r) => setTimeout(r, 80));

    appendLine(subFile, line("assistant", "<final>alert-bus-done</final>"));
    scanTranscripts();

    assert(
      alerts.some((a) => a.status === "finished" && a.name),
      "onAgentAlert callback must still fire for desktop notifications"
    );
    assert(
      alerts.every((a) => a.name != null && a.status != null && a.message == null),
      "callback payload is name+status only (no message/prompt)"
    );

    const sseAlerts = await ssePromise;
    assert(sseAlerts.length >= 1, "SSE must broadcast event: alert, got " + sseAlerts.length);
    const sseHit = sseAlerts.find((a) => a.status === "finished" && a.agentId === subId);
    assert(sseHit, "SSE alert should include finished status and agentId");
    assert(typeof sseHit.id === "number" && sseHit.id > 0, "SSE alert needs numeric id");
    assert(typeof sseHit.ts === "string" && Date.parse(sseHit.ts), "SSE alert needs ts");
    assert(typeof sseHit.name === "string" && sseHit.name.length > 0, "SSE alert needs name");
    assert(
      sseHit.message == null && sseHit.path == null && sseHit.prompt == null,
      "SSE alert must not carry prompt/path fields"
    );

    const api = await fetchAlerts(port);
    assert(api.status === 200, "GET /api/alerts expected 200, got " + api.status);
    assert(Array.isArray(api.body.alerts), "GET /api/alerts returns alerts array");
    const apiHit = api.body.alerts.find((a) => a.status === "finished" && a.agentId === subId);
    assert(apiHit, "GET /api/alerts must include the finished alert with agentId");
    assert(apiHit.id === sseHit.id, "API alert id should match SSE alert id");
    assert(apiHit.name === sseHit.name, "API alert name should match SSE");
    assert(
      api.body.alerts.every(
        (a) =>
          a &&
          typeof a.id === "number" &&
          typeof a.ts === "string" &&
          typeof a.name === "string" &&
          typeof a.status === "string" &&
          a.message == null
      ),
      "stored alerts are id/ts/name/status (+ optional agentId) only"
    );
  });

  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  await testRestartDedupeAndTimestamps();
  await testKeywordFalsePositiveAndStructuredTerminal();
  await testOneAlertPerTerminalChange();
  await testNoPhantomParentStall();
  await testNewFileReadFromOffsetZero();
  await testToolErrorNotTerminal();
  await testStructuredTerminalErrorAlert();
  await testStartupWarmPushesLiveEvents();
  await testProjectSwitchWarmPushesLiveEvents();
  await testResumedOldTranscriptBeyondScanLimit();
  await testResumedOldFileLargeAppendBeforeFirstPoll();
  await testResumedLargeFileNonAscii();
  await testOversizedLineSkippedNoStall();
  await testChunkedReadCappedPerPoll();
  await testSubagentFinishedNotStalled();
  await testAlertBusSseAndApi();
  console.log(
    "transcript-history tests OK · dedupe, timestamps, terminal signals, alerts, stall, alert bus"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
