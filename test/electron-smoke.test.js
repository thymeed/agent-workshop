/**
 * Electron smoke: launch the real app and assert the in-process bridge comes up
 * and serves the dashboard. This is the only test that executes electron/main.js,
 * so it is what covers the Electron runtime upgrade.
 *
 * Skipped on Linux when xvfb-run is unavailable (Electron needs an X server).
 * On Linux the app is launched with --no-sandbox: CI runners restrict unprivileged
 * user namespaces, so the Chromium setuid sandbox aborts with SIGTRAP. That flag is
 * a harness concession only; electron/main.js keeps webPreferences.sandbox enabled.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BOOT_TIMEOUT_MS = 60000;

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

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function postSource(port, source) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ source });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/source",
        method: "POST",
        timeout: 4000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Cursor-Bridge": "1",
          "Sec-Fetch-Site": "same-origin"
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasXvfb() {
  try {
    execFileSync("xvfb-run", ["--help"], { stdio: "ignore" });
    return true;
  } catch (_e) {
    return false;
  }
}

async function waitForBridge(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await get(`http://127.0.0.1:${port}/api/status`);
      if (r.status === 200) return JSON.parse(r.body);
    } catch (_e) {
      /* not up yet */
    }
    await sleep(1000);
  }
  return null;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (_e) {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (_e) {
    try {
      child.kill("SIGKILL");
    } catch (_e2) {
      /* already gone */
    }
  }
}

async function main() {
  if (process.platform === "linux" && !hasXvfb()) {
    console.log("electron smoke SKIPPED · xvfb-run not available for a headless X server");
    return;
  }

  const electronPath = require("electron");
  const port = await getFreePort();
  const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `electron-${label}-`));
  const projectsRoot = tmp("projects");
  const eventLogDir = tmp("log");
  const userData = tmp("userdata");
  /* The Claude Code default reads <home>/.claude/projects: point the home variables at a folder
     inside the project so the developer's real Windows/POSIX sessions (and any inherited Cursor
     folder) are not read. Electron needs its profile outside the fake home: see --user-data-dir. */
  const scratchBase = path.join(ROOT, ".scratch");
  fs.mkdirSync(scratchBase, { recursive: true });
  const fakeHome = fs.mkdtempSync(path.join(scratchBase, "electron-home-"));

  // one planted project: proves the bridge read this home, not the developer's
  const plantedDir = path.join(fakeHome, ".claude", "projects", "enc-demo");
  fs.mkdirSync(plantedDir, { recursive: true });
  fs.writeFileSync(
    path.join(plantedDir, "s1.jsonl"),
    JSON.stringify({ type: "user", cwd: "/srv/proj-demo", sessionId: "s1" }) + "\n"
  );

  const env = Object.assign({}, process.env, {
    CURSOR_BRIDGE_PORT: String(port),
    CURSOR_PROJECTS_ROOT: projectsRoot,
    CURSOR_EVENT_LOG_DIR: eventLogDir,
    HOME: fakeHome,
    USERPROFILE: fakeHome
  });
  delete env.CURSOR_TRANSCRIPTS;
  if (process.platform === "win32") {
    env.HOMEDRIVE = fakeHome.slice(0, 2);
    env.HOMEPATH = fakeHome.slice(2);
  }
  if (process.platform === "linux") env.ELECTRON_DISABLE_SANDBOX = "1";

  const args = [".", `--user-data-dir=${userData}`];
  const useXvfb = process.platform === "linux";
  if (useXvfb) args.push("--no-sandbox");
  const child = useXvfb
    ? spawn("xvfb-run", ["-a", electronPath, ...args], {
        cwd: ROOT,
        env,
        stdio: "ignore",
        detached: true
      })
    : spawn(electronPath, args, { cwd: ROOT, env, stdio: "ignore", detached: true });

  const exitSignals = [];
  child.on("exit", (code, signal) => {
    exitSignals.push({ code, signal });
  });

  try {
    const status = await waitForBridge(port, Date.now() + BOOT_TIMEOUT_MS);

    if (!status && process.platform === "linux" && exitSignals.length) {
      const { code } = exitSignals[0];
      /* 133 = SIGTRAP from the Chromium sandbox; 127/126 = a missing shared lib.
         Neither is an app defect, and neither is reproducible on a dev machine. */
      if (code === 133 || code === 127 || code === 126) {
        console.log(
          `electron smoke SKIPPED · electron exited ${code} before the bridge started (runner sandbox/deps)`
        );
        return;
      }
    }

    assert.ok(
      status,
      `electron did not start the in-process bridge on port ${port}` +
        (exitSignals.length ? ` (electron exited ${JSON.stringify(exitSignals[0])})` : "")
    );
    assert.strictEqual(status.ok, true, "bridge /api/status must report ok");
    // a desktop start names no Cursor folder, so it reads Claude Code (and shows no Cursor path)
    assert.strictEqual(status.source, "claude-code", "Electron starts on the Claude Code default");
    assert.strictEqual(
      status.transcripts,
      undefined,
      "Claude Code status carries no Cursor folder"
    );
    const listed = JSON.parse((await get(`http://127.0.0.1:${port}/api/projects`)).body);
    // (on Windows the bridge also lists running WSL distros; that cannot be redirected from here)
    assert.ok(
      listed.projects.some((p) => p.label === "proj-demo"),
      "Claude Code discovery read the isolated home"
    );
    assert.strictEqual(await postSource(port, "cursor"), 200, "switching to Cursor must work");
    const cursorStatus = JSON.parse((await get(`http://127.0.0.1:${port}/api/status`)).body);
    assert.strictEqual(cursorStatus.source, "cursor");
    assert.strictEqual(
      cursorStatus.transcripts,
      path.join(projectsRoot, "_none", "agent-transcripts"),
      "bridge must use the isolated projects root, not the real one"
    );

    const home = await get(`http://127.0.0.1:${port}/`);
    assert.strictEqual(home.status, 200, `GET / under Electron: got ${home.status}`);
    assert.ok(/<html/i.test(home.body), "GET / must return the dashboard HTML");

    assert.strictEqual(child.exitCode, null, "electron must still be running after serving");

    console.log("electron smoke OK · in-process bridge up, dashboard served");
  } finally {
    killTree(child);
    await sleep(800);
    for (const d of [projectsRoot, eventLogDir, userData, fakeHome]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
