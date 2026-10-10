/**
 * Electron main process.
 * Starts live-bridge in-process (no cmd.exe / visible node.exe console)
 * and opens the dashboard in a native window.
 * Desktop alerts: agent finished / error / stalled. name + status only.
 */
"use strict";

const { app, BrowserWindow, Notification } = require("electron");
const path = require("path");
const { startBridge, stopBridge } = require(path.join(__dirname, "..", "live-bridge.js"));

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

async function bootBridge() {
  // quiet: no bridge console chatter; never spawn cmd/node. require() only
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
