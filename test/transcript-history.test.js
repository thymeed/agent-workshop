/**
 * Transcript → history: warm-up dedupe, structured terminal, stall/alerts.
 */
"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const {
  startBridge,
  stopBridge,
  scanTranscripts,
  checkStalledAgents,
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
  const alerts = [];
  const port = await getFreePort();
  await startBridge(
    Object.assign(
      {
        port,
        quiet: true,
        dir,
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
  }
}

function historyEvents(logDir) {
  const { createEventLog } = require("../lib/event-log");
  return createEventLog({ logDir, retentionMs: 365 * 24 * 60 * 60 * 1000 }).query();
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

async function main() {
  await testRestartDedupeAndTimestamps();
  await testKeywordFalsePositiveAndStructuredTerminal();
  await testOneAlertPerTerminalChange();
  await testNoPhantomParentStall();
  await testNewFileReadFromOffsetZero();
  await testToolErrorNotTerminal();
  await testStructuredTerminalErrorAlert();
  await testResumedOldTranscriptBeyondScanLimit();
  await testResumedLargeFileNonAscii();
  await testOversizedLineSkippedNoStall();
  await testChunkedReadCappedPerPoll();
  await testSubagentFinishedNotStalled();
  console.log("transcript-history tests OK · dedupe, timestamps, terminal signals, alerts, stall");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
