// src/main.js — the Electron main process.
// Responsibilities:
//   1. Create a small, frameless, always-on-top window that remembers its position.
//   2. Handle IPC calls from the renderer to write to the system clipboard
//      (text for LaTeX, or a PNG image).
//   3. Provide a "toggle pin" IPC so the UI can turn always-on-top on/off.
//   4. Render PNG exports in a hidden second window (see "Off-screen PNG
//      rendering" below) so exporting never resizes the visible app window.

const { app, BrowserWindow, ipcMain, clipboard, nativeImage, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Tiny JSON-file settings store. Avoids pulling in electron-store as a dep.
const settingsPath = () => path.join(app.getPath('userData'), 'floater-settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); }
  catch (e) { console.error('Could not save settings:', e); }
}

let mainWindow = null;

// The single source of truth for "is the window pinned". Electron's own
// mainWindow.isAlwaysOnTop() looked like it should serve this purpose, but on
// Windows it doesn't reliably reflect what setAlwaysOnTop() was last called
// with — querying it fed a wrong value back into both the toggle handler
// (computing the wrong "next" state) and the pin button's displayed state
// (always showing the same thing regardless of the real state). Tracking our
// own flag and treating it as authoritative sidesteps that entirely.
let pinned = true;

function createWindow() {
  const saved = loadSettings();
  pinned = saved.pinned !== false;   // default ON — that's the whole point of this app

  // Default size tuned for the palette + input + action row. Mirrors Symbolab's
  // compact editor but narrower so it doesn't hog screen real estate.
  const defaultBounds = { width: 620, height: 380 };

  // Clamp any saved bounds to the current display in case monitors changed.
  let bounds = { ...defaultBounds, ...(saved.bounds || {}) };
  const displays = screen.getAllDisplays();
  const onScreen = displays.some(d => {
    const a = d.workArea;
    return bounds.x != null && bounds.y != null &&
           bounds.x >= a.x && bounds.y >= a.y &&
           bounds.x < a.x + a.width && bounds.y < a.y + a.height;
  });
  if (!onScreen) { delete bounds.x; delete bounds.y; }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 280,
    frame: false,             // custom title bar; lets us make the whole top edge draggable
    transparent: false,
    alwaysOnTop: pinned,
    skipTaskbar: false,
    resizable: true,
    roundedCorners: false,    // keep appearance identical on macOS and Windows
    backgroundColor: '#12131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Ensure the always-on-top state is applied. On Windows, "screen-saver" level
  // keeps it above fullscreen apps; we use the default level so it plays nicely
  // with normal apps while still staying on top of them.
  mainWindow.setAlwaysOnTop(pinned, 'floating');

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Persist window geometry and pin state on close.
  mainWindow.on('focus', () => mainWindow.webContents.send('window:focused'));

  mainWindow.on('close', () => {
    const [x, y] = mainWindow.getPosition();
    const [width, height] = mainWindow.getSize();
    const current = loadSettings();
    saveSettings({
      ...current,
      bounds: { x, y, width, height },
      pinned
    });

    // window-all-closed (below) only fires once every BrowserWindow is gone.
    // The hidden PNG capture window is invisible and has no taskbar icon, so
    // without this, closing the visible main window wouldn't actually quit
    // the app — it'd keep running with nothing on screen to show for it.
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
  });
}

app.whenReady().then(() => {
  createWindow();

  // Summon the window from any app.
  globalShortcut.register('CommandOrControl+Alt+L', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  // Normal desktop-app behavior on Windows: quit when the window closes.
  app.quit();
});

// --- IPC handlers ---------------------------------------------------------

// Write plain text to the clipboard (used for both LaTeX and MathML).
ipcMain.handle('clipboard:write-text', (_evt, text) => {
  clipboard.writeText(text ?? '');
  return true;
});

// Write a PNG image to the clipboard. The renderer sends a data-URL string
// (e.g. "data:image/png;base64,AAAA..."). We turn it into a NativeImage.
ipcMain.handle('clipboard:write-image', (_evt, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
});

// Toggle always-on-top. Returns the new state so the UI can update its icon.
ipcMain.handle('window:toggle-pin', () => {
  if (!mainWindow) return false;
  pinned = !pinned;
  mainWindow.setAlwaysOnTop(pinned, 'floating');
  return pinned;
});

// Lets the renderer sync a UI toggle (the pin button) to the real state
// instead of assuming — needed on boot, since the actual always-on-top value
// comes from last session's saved settings, not a fixed default.
ipcMain.handle('window:get-pin-state', () => pinned);

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('window:set-opacity', (_evt, value) => {
  mainWindow?.setOpacity(Math.max(0.2, Math.min(1, value)));
});

// --- Off-screen PNG rendering ----------------------------------------------
//
// PNG export used to work by resizing the *visible* app window to fit
// whatever expression was too big for it, capturing, then resizing back —
// which meant the real window visibly ballooned for a moment on every export
// of a wide/tall expression. Instead, we keep one hidden, never-shown
// BrowserWindow around (created lazily, reused across exports) that renders
// nothing but the math field being exported. It gets resized to fit — but
// since it's never shown, nothing the user sees ever moves.
let captureWindow = null;
let captureWindowReady = null;

function getCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    return { win: captureWindow, ready: captureWindowReady };
  }
  captureWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    frame: false,
    resizable: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  captureWindowReady = new Promise((resolve) => {
    captureWindow.webContents.once('did-finish-load', resolve);
  });
  captureWindow.loadFile(path.join(__dirname, 'capture.html'));
  return { win: captureWindow, ready: captureWindowReady };
}

// Renders `latex` in the hidden capture window, resizes that window to fit
// the result exactly, screenshots it, and returns a PNG data URL. Used by
// copyPng() in the renderer.
ipcMain.handle('png:render', async (_evt, { latex, fontSize }) => {
  const { win, ready } = getCaptureWindow();
  await ready;

  const size = await new Promise((resolve) => {
    ipcMain.once('capture:size-reported', (_e, s) => resolve(s));
    win.webContents.send('capture:render', { latex, fontSize });
  });

  win.setContentSize(Math.max(1, Math.ceil(size.width)), Math.max(1, Math.ceil(size.height)));
  // Let the resize's layout settle before capturing.
  await new Promise((r) => setTimeout(r, 30));

  const image = await win.webContents.capturePage();
  return image.toDataURL();
});
