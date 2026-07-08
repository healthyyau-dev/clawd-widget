'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('probeAPI', {
  onProbe: (cb) => ipcRenderer.on('probe', (_e, data) => cb(data)),
  ctxMenu: () => ipcRenderer.send('ctxmenu')
})
