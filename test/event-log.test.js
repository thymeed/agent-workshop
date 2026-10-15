/**
 * Unit tests: event-log redaction, retention/prune, clear, contract shape, permissions.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createEventLog,
  redactSecrets,
  normalizeEvent,
  EVENT_TYPES,
  RETENTION_MS,
  LOG_DIR_MODE,
  LOG_FILE_MODE
} = require("../lib/event-log");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "event-log-" + label + "-"));
}

function sampleEvent(overrides) {
  return Object.assign(
    {
      ts: new Date().toISOString(),
      sessionId: "sess-1",
      agentId: "agent-1",
      parentId: null,
      name: "Worker",
      model: "sonnet",
      type: "turn",
      inputTokens: 10,
      outputTokens: 20,
      files: ["a.js"]
    },
    overrides || {}
  );
}

/** @param {string} input @param {string[]} mustNotContain secret substrings */
function expectRedacted(input, mustNotContain) {
  const out = String(redactSecrets(input));
  if (!out.includes("[REDACTED]")) {
    throw new Error(
      "expected redaction in: " + JSON.stringify(input) + " → " + JSON.stringify(out)
    );
  }
  for (const leak of mustNotContain || []) {
    if (out.includes(leak)) {
      throw new Error("secret leaked (" + leak + ") in: " + out);
    }
  }
  return out;
}

/** @param {string} input */
function expectUntouched(input) {
  const out = redactSecrets(input);
  if (out !== input) {
    throw new Error("over-redacted: " + JSON.stringify(input) + " → " + JSON.stringify(out));
  }
}

function testRedactionFormats() {
  const errors = [];

  // Fake fixtures, split so secret scanning does not flag this file. Do not inline.

  function runGroup(name, secretSample, leaks, safeSamples) {
    try {
      expectRedacted(secretSample, leaks);
      for (const safe of safeSamples) {
        expectUntouched(safe);
      }
    } catch (e) {
      errors.push(name + ": " + e.message);
    }
  }

  runGroup(
    "github gho/ghs tokens",
    "gho_" + "abcdefghijklmnopqrstuvwxyzABCD",
    ["abcdefghijklmnopqrstuvwxyzABCD"],
    [
      "github oauth docs",
      "gho is not a token prefix alone",
      "ghp_short",
      "mention gho_ in prose without 20+ chars"
    ]
  );

  runGroup(
    "bare JWT",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ["SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    [
      "version 1.2.3.release",
      "file.name.with.dots.js",
      "not.a.jwt.without-eyJ-prefix",
      "eyJincomplete"
    ]
  );

  runGroup(
    "URL ?token= param",
    "https://example.com/callback?token=supersecretvalue123",
    ["supersecretvalue123"],
    [
      "https://example.com/page?foo=bar",
      "https://example.com/page?mytoken=ignored",
      "query token= without question mark",
      "path/to/file?notoken=here"
    ]
  );

  runGroup(
    "URL ?key= param",
    "wss://stream.example/live?key=abcdef0123456789",
    ["abcdef0123456789"],
    [
      "https://example.com/page?keyword=abc",
      "https://example.com/page?foo=bar&sort=name",
      "?other=value"
    ]
  );

  runGroup(
    "JSON quoted password",
    '{"user":"alice","password":"hunter2","role":"admin"}',
    ["hunter2"],
    [
      '{"name":"password","value":"field label"}',
      '{"note":"use password manager"}',
      "password field mentioned in prose"
    ]
  );

  runGroup(
    "Google AIza key",
    "AIza" + "Sy012345678901234567890123456789012",
    ["012345678901234567890123456789012"],
    ["AIza prefix alone", "maps API docs", "AIzaSy-short"]
  );

  runGroup(
    "GitLab glpat",
    "glpat-" + "abcdefghijklmnopqrstuvwxyz12",
    ["abcdefghijklmnopqrstuvwxyz12"],
    ["gitlab personal access token docs", "glpat-short", "no-gitlab-here"]
  );

  const pemBody = "MIIEpAIBAAKCAQEA7secretkeybodybytes9Z8Y7X6W5V4U3T2S1R0Q";
  const pemBlock =
    "-----BEGIN " + "RSA PRIVATE KEY-----\n" + pemBody + "\n-----END RSA PRIVATE KEY-----";
  runGroup(
    "PEM private key block",
    pemBlock,
    [pemBody, "BEGIN RSA PRIVATE KEY", "END RSA PRIVATE KEY"],
    ["-----BEGIN CERTIFICATE-----", "public key documentation", "BEGIN PRIVATE KEY without dashes"]
  );

  const pemDir = tmpDir("pem-block");
  const pemLog = createEventLog({ logDir: pemDir });
  pemLog.append(
    sampleEvent({
      name: "Worker",
      files: [pemBlock]
    })
  );
  const pemRaw = fs.readFileSync(pemLog.getLogPath(), "utf8");
  if (pemBody.split("").some((ch) => pemRaw.includes(ch) && pemRaw.indexOf(pemBody) >= 0)) {
    errors.push("PEM body written to JSONL: " + pemRaw);
  }
  if (pemRaw.includes(pemBody) || pemRaw.includes("MIIEpAIBAAKCAQEA7secret")) {
    errors.push("PEM key material in JSONL: " + pemRaw);
  }
  if (!pemRaw.includes("[REDACTED]")) {
    errors.push("PEM JSONL missing [REDACTED]: " + pemRaw);
  }

  // Sensitive object field names (one positive each + shared safe object fields)
  const fieldCases = [
    ["authToken", { authToken: "tok_secret_value_99" }, "tok_secret_value_99"],
    ["privateKey", { privateKey: "-----BEGIN KEY-----" }, "BEGIN KEY"],
    ["x-api-key", { "x-api-key": "abc123secretkey" }, "abc123secretkey"],
    ["cookie", { cookie: "session=deadbeef" }, "deadbeef"]
  ];
  for (const [label, obj, leak] of fieldCases) {
    try {
      const out = redactSecrets(obj);
      if (
        typeof out[Object.keys(obj)[0]] !== "string" ||
        out[Object.keys(obj)[0]] !== "[REDACTED]"
      ) {
        throw new Error("field not redacted: " + JSON.stringify(out));
      }
      if (JSON.stringify(out).includes(leak)) {
        throw new Error("leak in object: " + JSON.stringify(out));
      }
      expectUntouched(JSON.stringify({ username: "alice", count: 3 }));
      expectUntouched(JSON.stringify({ model: "sonnet", role: "worker" }));
    } catch (e) {
      errors.push("field " + label + ": " + e.message);
    }
  }

  // Legacy / existing patterns still covered
  const legacy = [
    ["sk-" + "abcdefghijklmnopqrstuv", ["supersecret"]],
    ["Authorization: Bearer abc.def.ghi", ["abc.def"]],
    ["api_key=supersecretvalue", ["supersecret"]],
    ["ghp_" + "abcdefghijklmnopqrstuvwx", ["abcdefghijklmnopqrstuvwx"]],
    ["AKIA" + "IOSFODNN7EXAMPLE", ["IOSFODNN7EXAMPLE"]]
  ];
  for (const [input, leaks] of legacy) {
    try {
      expectRedacted(input, leaks);
    } catch (e) {
      errors.push("legacy: " + e.message);
    }
  }

  const dir = tmpDir("redact");
  const log = createEventLog({ logDir: dir });
  log.append(
    sampleEvent({
      name: "Worker api_key=leakmeNOW123",
      files: ["path/with/password=secretval.js"]
    })
  );
  const raw = fs.readFileSync(log.getLogPath(), "utf8");
  if (/leakmeNOW123|secretval/.test(raw)) {
    errors.push("secret written to JSONL: " + raw);
  }
  if (!raw.includes("[REDACTED]")) {
    errors.push("JSONL missing [REDACTED]: " + raw);
  }

  if (errors.length) {
    throw new Error("redaction failed:\n- " + errors.join("\n- "));
  }
}

function testContractShape() {
  const errors = [];
  const ev = normalizeEvent(
    sampleEvent({
      parentId: "parent:parent",
      type: "spawn",
      inputTokens: 1.7,
      outputTokens: -3,
      files: ["x.js", "", null]
    })
  );
  const keys = [
    "ts",
    "sessionId",
    "agentId",
    "parentId",
    "name",
    "model",
    "type",
    "inputTokens",
    "outputTokens",
    "files"
  ];
  for (const k of keys) {
    if (!(k in ev)) errors.push("missing key " + k);
  }
  if (Object.keys(ev).sort().join(",") !== keys.slice().sort().join(",")) {
    errors.push("unexpected keys: " + Object.keys(ev).join(","));
  }
  assert(typeof ev.ts === "string" && !Number.isNaN(Date.parse(ev.ts)), "ts ISO");
  assert(typeof ev.sessionId === "string", "sessionId string");
  assert(typeof ev.agentId === "string", "agentId string");
  assert(ev.parentId === "parent:parent" || ev.parentId === null, "parentId");
  assert(typeof ev.name === "string", "name");
  assert(typeof ev.model === "string", "model");
  assert(EVENT_TYPES.has(ev.type), "type in contract");
  assert(ev.inputTokens === 2, "inputTokens rounded");
  assert(ev.outputTokens === 0, "outputTokens clamped");
  assert(Array.isArray(ev.files) && ev.files.length === 1 && ev.files[0] === "x.js", "files");

  assert(normalizeEvent({ type: "nope" }) === null, "reject bad type");
  assert(normalizeEvent(sampleEvent({ parentId: null })).parentId === null, "null parentId");

  if (errors.length) throw new Error("contract failed:\n- " + errors.join("\n- "));
}

function testRetentionAndClear() {
  const dir = tmpDir("retain");
  const log = createEventLog({ logDir: dir, retentionMs: 1000 });
  const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const freshTs = new Date().toISOString();

  const p = log.getLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    [
      JSON.stringify(sampleEvent({ ts: oldTs, agentId: "old" })),
      JSON.stringify(sampleEvent({ ts: freshTs, agentId: "new" }))
    ].join("\n") + "\n",
    "utf8"
  );

  const pruned = log.prune();
  assert(pruned.removed >= 1, "expected old event removed");
  const left = log.query();
  assert(left.length === 1 && left[0].agentId === "new", "only fresh kept");

  assert(RETENTION_MS === 30 * 24 * 60 * 60 * 1000, "30-day retention");

  log.append(sampleEvent({ agentId: "extra", sessionId: "s2" }));
  assert(log.query({ session: "s2" }).length === 1, "session filter");
  assert(log.query({ since: freshTs }).length >= 1, "since filter");

  const cleared = log.clear();
  assert(cleared && cleared.ok === true, "clear ok");
  assert(log.query().length === 0, "empty after clear");
  assert(fs.existsSync(p), "log file remains after clear");
  assert(fs.readFileSync(p, "utf8").trim() === "", "log emptied");
}

function testExistingLogDirChmodOnStart() {
  if (process.platform === "win32") {
    return;
  }

  const base = tmpDir("dir-chmod");
  const logDir = path.join(base, "preexisting");
  fs.mkdirSync(logDir, { recursive: true });
  fs.chmodSync(logDir, 0o755);
  const log = createEventLog({ logDir });
  log.ensureStarted();
  const dirMode = fs.statSync(logDir).mode & 0o777;
  assert(
    dirMode === LOG_DIR_MODE,
    "existing dir chmod expected 0o700, got 0o" + dirMode.toString(8)
  );
}

function testFilePermissions() {
  if (process.platform === "win32") {
    return;
  }

  const base = tmpDir("perms");
  const logDir = path.join(base, "nested-app-data");
  const log = createEventLog({ logDir });
  log.append(sampleEvent({ agentId: "first" }));

  const logPath = log.getLogPath();
  assert(fs.existsSync(logDir), "log dir created");
  assert(fs.existsSync(logPath), "log file created");

  const dirMode = fs.statSync(logDir).mode & 0o777;
  const fileMode = fs.statSync(logPath).mode & 0o777;
  assert(dirMode === LOG_DIR_MODE, "dir mode expected 0o700, got 0o" + dirMode.toString(8));
  assert(fileMode === LOG_FILE_MODE, "file mode expected 0o600, got 0o" + fileMode.toString(8));

  fs.chmodSync(logPath, 0o644);
  log.append(sampleEvent({ agentId: "second" }));
  const fileModeAfter = fs.statSync(logPath).mode & 0o777;
  assert(
    fileModeAfter === LOG_FILE_MODE,
    "existing file rechmod expected 0o600, got 0o" + fileModeAfter.toString(8)
  );
}

function testPemFullBlockRedaction() {
  const bodyLine1 = "MIIEpAIBAAKCAQEA7secretkeybodybytes9Z8Y7X6W5V4U3T2S1R0Q";
  const bodyLine2 = "moreBase64KeyMaterialThatMustNotPersistInLogFile012345";
  const pem =
    "-----BEGIN " +
    "EC PRIVATE KEY-----\n" +
    bodyLine1 +
    "\n" +
    bodyLine2 +
    "\n-----END EC PRIVATE KEY-----";
  const redacted = redactSecrets(pem);
  if (!redacted.includes("[REDACTED]")) {
    throw new Error("PEM block should redact to [REDACTED]");
  }
  if (redacted.includes(bodyLine1) || redacted.includes(bodyLine2)) {
    throw new Error("PEM key body bytes must not survive: " + redacted);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(redacted)) {
    throw new Error("PEM header must not remain after redaction");
  }

  const normal =
    "Docs mention -----BEGIN CERTIFICATE----- and installing a public key. " +
    "This paragraph is not a private key block.";
  if (redactSecrets(normal) !== normal) {
    throw new Error("normal text must not be over-redacted: " + redactSecrets(normal));
  }
}

function testRedactionSignedUrls() {
  const groups = [
    [
      "aws presigned query",
      "https://bucket.s3.amazonaws.com/o?X-Amz-Credential=" +
        "AKIA" +
        "IOSFODNN7EXAMPLE&X-Amz-Signature=deadbeefcafe1234&X-Amz-Security-Token=FwoGZXIvYXdz",
      ["deadbeefcafe1234", "FwoGZXIvYXdz", "IOSFODNN7EXAMPLE"]
    ],
    [
      "generic signature param",
      "https://example.com/cb?Signature=abc123def456xyz",
      ["abc123def456xyz"]
    ],
    [
      "oauth code param",
      "https://example.com/cb?code=4/0AY0e-g7secretcode",
      ["0AY0e-g7secretcode"]
    ],
    ["npm token", "//registry.npmjs.org/:_authToken=npm_" + "a".repeat(36), ["a".repeat(36)]]
  ];

  for (const [name, sample, leaks] of groups) {
    try {
      expectRedacted(sample, leaks);
    } catch (e) {
      throw new Error(name + ": " + e.message);
    }
  }

  const userinfo = "fetch https://svc:hunter2pw@internal.example.com/repo";
  const out = expectRedacted(userinfo, ["hunter2pw"]);
  if (!out.includes("[REDACTED]@")) {
    throw new Error("url userinfo must redact to [REDACTED]@: " + out);
  }

  expectUntouched("https://example.com/docs?page=2");
  expectUntouched("see the signature section of the docs");
}

function testSharedLogDirNotChmodded() {
  if (process.platform === "win32") {
    return;
  }

  const base = tmpDir("shared-dir");
  const shared = path.join(base, "home");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "unrelated.txt"), "not ours\n", "utf8");
  fs.chmodSync(shared, 0o755);

  const log = createEventLog({ logDir: shared });
  log.ensureStarted();

  const dirMode = fs.statSync(shared).mode & 0o777;
  assert(
    dirMode === 0o755,
    "a directory holding other files must keep its mode, got 0o" + dirMode.toString(8)
  );
  const fileMode = fs.statSync(log.getLogPath()).mode & 0o777;
  assert(
    fileMode === LOG_FILE_MODE,
    "the log file itself is still 0o600, got 0o" + fileMode.toString(8)
  );
}

async function main() {
  testRedactionFormats();
  testRedactionSignedUrls();
  testPemFullBlockRedaction();
  testContractShape();
  testRetentionAndClear();
  testExistingLogDirChmodOnStart();
  testFilePermissions();
  testSharedLogDirNotChmodded();
  console.log("event-log tests OK · redaction, retention, clear, contract, permissions");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
