// src/preload.js — runs in an isolated context between main and renderer.
// We expose a tiny API surface so the renderer never touches Node directly.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floater', {
  copyText:      (text)    => ipcRenderer.invoke('clipboard:write-text',  text),
  copyImage:     (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  togglePin:     ()        => ipcRenderer.invoke('window:toggle-pin'),
  minimize:      ()        => ipcRenderer.invoke('window:minimize'),
  close:         ()        => ipcRenderer.invoke('window:close'),
  platform:      process.platform,  // 'win32' | 'darwin' | 'linux'
  onFocus:       (cb) => ipcRenderer.on('window:focused', cb),
  setOpacity:    (v)  => ipcRenderer.invoke('window:set-opacity', v),
  getPinState:   ()      => ipcRenderer.invoke('window:get-pin-state'),
  renderPng:     (latex, fontSize) => ipcRenderer.invoke('png:render', { latex, fontSize })
});
