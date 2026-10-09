"use strict";

const assert = require("assert");
const net = require("net");

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
const {
  normalizePathSlashes,
  pathSegments,
  isSubagentTranscriptPath,
  subagentUuidFromTranscriptPath
} = require("../lib/path-segments");

function testPathSegments() {
  const winSub =
    "C:\\Users\\dev\\.cursor\\projects\\workspace\\agent-transcripts\\subagents\\aaaaaaaa-bbbb.jsonl";
  assert.strictEqual(isSubagentTranscriptPath(winSub), true);
  assert.strictEqual(subagentUuidFromTranscriptPath(winSub), "aaaaaaaa-bbbb");

  const mixed = "C:/Users/dev/.cursor/projects/x/agent-transcripts/subagents/cccc-dddd.jsonl";
  assert.strictEqual(isSubagentTranscriptPath(mixed), true);
  assert.strictEqual(subagentUuidFromTranscriptPath(mixed), "cccc-dddd");

  assert.strictEqual(isSubagentTranscriptPath("C:\\agent-transcripts\\parent.jsonl"), false);
  assert.strictEqual(pathSegments("a\\b/c\\d").join("/"), normalizePathSlashes("a\\b/c\\d"));
}

async function testCrlfSnapshotResume() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { startBridge, stopBridge, scanTranscripts } = require("../live-bridge.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-resume-"));
  const parent = path.join(root, "parent.jsonl");
  const crlfLine =
    JSON.stringify({
      role: "user",
      timestamp: new Date(Date.now() - 60000).toISOString(),
      message: { content: [{ type: "text", text: "<user_query>warm</user_query>" }] }
    }) + "\r\n";
  fs.writeFileSync(parent, crlfLine, "utf8");

  const tsNew = "2031-04-01T12:00:00.000Z";
  const newLine =
    JSON.stringify({
      role: "user",
      timestamp: tsNew,
      message: { content: [{ type: "text", text: "<user_query>after resume</user_query>" }] }
    }) + "\r\n";

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-log-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-projects-"));
  const { createEventLog } = require("../lib/event-log");

  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    dir: root,
    projectsRoot,
    eventLogDir: logDir,
    reuseExisting: false
  });
  try {
    scanTranscripts();
    fs.appendFileSync(parent, newLine, "utf8");
    scanTranscripts();
    const events = createEventLog({ logDir, retentionMs: 365 * 24 * 60 * 60 * 1000 }).query();
    assert.ok(
      events.some((e) => e.ts === tsNew),
      "CRLF file must record post-snapshot line"
    );
  } finally {
    await stopBridge();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

async function testSubagentIngestWithWindowsPath() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { startBridge, stopBridge, scanTranscripts } = require("../live-bridge.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "win-path-ingest-"));
  const subDir = path.join(root, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const subId = "dddddddd-eeee-ffff-0000-111111111111";
  const subFile = path.join(subDir, subId + ".jsonl");
  const winStylePath = subFile.split(path.sep).join("\\");

  const line = (role, text) =>
    JSON.stringify({
      role,
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text }] }
    }) + "\n";

  fs.writeFileSync(subFile, line("user", "explorer task"), "utf8");

  assert.strictEqual(isSubagentTranscriptPath(winStylePath), true);
  assert.strictEqual(subagentUuidFromTranscriptPath(winStylePath), subId);

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-path-log-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "win-path-projects-"));
  const { createEventLog } = require("../lib/event-log");

  const port = await getFreePort();
  await startBridge({
    port,
    quiet: true,
    dir: root,
    projectsRoot,
    eventLogDir: logDir,
    reuseExisting: false
  });
  try {
    scanTranscripts();
    fs.appendFileSync(subFile, line("assistant", "<final>done</final>"), "utf8");
    scanTranscripts();
    const events = createEventLog({ logDir, retentionMs: 365 * 24 * 60 * 60 * 1000 }).query();
    assert.ok(
      events.some((e) => e.agentId === subId && e.type === "done"),
      "post-snapshot subagent line must record history with subagent agentId"
    );
  } finally {
    await stopBridge();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

async function main() {
  testPathSegments();
  await testCrlfSnapshotResume();
  await testSubagentIngestWithWindowsPath();
  console.log("paths-windows tests OK · backslash privacy + subagent paths");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
