import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { registerIpc } from "./ipc";
import { MetadataStore } from "./metadata-store";
import { RuntimeManager } from "./runtime-manager";
import { SessionIndex } from "./session-index";
import { isSafeExternalUrl } from "./security";

let mainWindow: BrowserWindow | undefined;
let cleanupIpc: (() => void) | undefined;
let store: MetadataStore | undefined;
const runtimes = new RuntimeManager();
let allowClose = false;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#121419",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#121419",
      symbolColor: "#d4d8e4",
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("close", event => {
    if (allowClose || runtimes.list().length === 0) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "OMP 仍在运行",
      message: "关闭 App 会停止当前 OMP 会话。",
      detail: "会话内容仍由 OMP 保存，之后可以恢复。",
      buttons: ["停止并退出", "取消"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 1) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    allowClose = true;
    void runtimes.stopAll().finally(() => window.destroy());
  });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId("io.github.eijnewgnaw.ompdesktop");
    store = new MetadataStore(path.join(app.getPath("userData"), "omp-desktop.sqlite3"));
    mainWindow = createWindow();
    cleanupIpc = registerIpc(mainWindow, {
      store,
      sessions: new SessionIndex(store),
      runtimes,
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });
}

app.on("before-quit", () => {
  allowClose = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  cleanupIpc?.();
  store?.close();
});
