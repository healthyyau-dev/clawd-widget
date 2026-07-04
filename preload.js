'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clawd', {
  isElectron: true,
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEnv: (cb) => ipcRenderer.on('env', (_e, env) => cb(env)),
  onHover: (cb) => ipcRenderer.on('hover', (_e, over) => cb(over)),
  dragState: (d) => ipcRenderer.send('drag-state', d),
  savePosition: (p) => ipcRenderer.send('save-pos', p),
  setBounds: (b) => ipcRenderer.send('set-bounds', b),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setBubbleVisible: (v) => ipcRenderer.send('bubble-visible', v),
  focusClaude: () => ipcRenderer.send('focus-claude'),
  showMenu: () => ipcRenderer.send('show-menu'),
  answer: (payload) => ipcRenderer.send('answer', payload),
  sendChoice: (n) => ipcRenderer.send('send-choice', n),
  idleClick: () => ipcRenderer.send('idle-click'),
  launchClaude: (target) => ipcRenderer.send('launch-claude', target),
  onLaunchPrompt: (cb) => ipcRenderer.on('show-launch', () => cb())
})
