/**
 * Electron main process.
 * Starts live-bridge in-process (no cmd.exe / visible node.exe console)
 * and opens the dashboard in a native window.
 * Desktop alerts: agent finished / error / stalled. Name + status only.
 */
"use strict";

const http = require("http");
const { app, BrowserWindow, Notification, dialog } = require("electron");
const path = require("path");
const { startBridge, stopBridge, BRIDGE_ID } = require(
  path.join(__dirname, "..", "live-bridge.js")
);

const PORT = Number(process.env.CURSOR_BRIDGE_PORT || 3847);
const WINDOW_TITLE = "Cursor Agents · Model Routing";

let mainWindow = null;
let bridgeOwned = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/**
 * Show a desktop notification with ONLY agent name and status.
 * Never include prompt text or file paths.
 */
function showAgentAlert(alert) {
  if (!alert || typeof alert !== "object") return;
  const name = String(alert.name || "agent").slice(0, 80);
  const status = String(alert.status || "").slice(0, 40);
  if (!status) return;
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: "Cursor Agents",
      body: name + " · " + status,
      silent: false
    });
    n.show();
  } catch (_e) {
    /* ignore notification failures */
  }
}

function isAllowedNavigationUrl(urlString, port) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    const urlPort = u.port || "80";
    return urlPort === String(port);
  } catch (_e) {
    return false;
  }
}

function probeBridgeIdentity(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/status",
        timeout: 2000
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.ok === true && j.bridgeId === BRIDGE_ID ? j : null);
          } catch (_e) {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

async function bootBridge() {
  // Start the bridge in-process: quiet, no console chatter, no spawned cmd/node.
  const result = await startBridge({
    port: PORT,
    quiet: true,
    reuseExisting: true,
    onAgentAlert: showAgentAlert
  });
  bridgeOwned = !result.reused;
  return result;
}

async function createWindow() {
  const bridge = await bootBridge();
  const identity = await probeBridgeIdentity(bridge.port);
  if (!identity) {
    dialog.showErrorBox(
      WINDOW_TITLE,
      `Could not verify the model-routing bridge on port ${bridge.port}. ` +
        "Another app may be using that port, or the bridge failed to start. " +
        "Close other listeners on this port and restart the app."
    );
    await shutdown();
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: WINDOW_TITLE,
    backgroundColor: "#0a0e0f",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigationUrl(url, bridge.port)) {
      event.preventDefault();
    }
  });

  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow.setTitle(WINDOW_TITLE);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  await mainWindow.loadURL(`http://127.0.0.1:${bridge.port}/`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function shutdown() {
  if (bridgeOwned) {
    try {
      await stopBridge();
    } catch (_) {
      /* ignore */
    }
    bridgeOwned = false;
  }
}

if (gotLock) {
  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error("[electron] failed to start:", err);
      app.quit();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(() => app.quit());
      }
    });
  });

  app.on("window-all-closed", () => {
    shutdown().finally(() => {
      if (process.platform !== "darwin") app.quit();
    });
  });

  app.on("before-quit", () => {
    shutdown();
  });
}
