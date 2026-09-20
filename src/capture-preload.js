// src/capture-preload.js — preload for the hidden off-screen capture window
// used by PNG export (see capture.js and the png:render handler in main.js).
// Separate from the main window's preload.js because this window exposes a
// completely different, smaller bridge — it only ever renders one LaTeX
// string and reports back how big it turned out to be.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureBridge', {
  onRender:   (cb)   => ipcRenderer.on('capture:render', (_evt, payload) => cb(payload)),
  reportSize: (size) => ipcRenderer.send('capture:size-reported', size)
});
