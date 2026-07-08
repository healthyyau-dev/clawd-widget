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
  focusClaude: (sid) => ipcRenderer.send('focus-claude', sid),
  showMenu: () => ipcRenderer.send('show-menu'),
  answer: (payload) => ipcRenderer.send('answer', payload),
  sendChoice: (n, sid) => ipcRenderer.send('send-choice', { n, sid }),
  submitAnswer: (sid) => ipcRenderer.send('submit-answer', sid),
  idleClick: (sid) => ipcRenderer.send('idle-click', sid),
  launchClaude: (target) => ipcRenderer.send('launch-claude', target),
  // CLI launch with a folder chooser: opens a native folder picker in main, launches
  // `claude` in the chosen directory, and resolves { launched, dir, canceled }.
  pickFolderAndLaunchCli: () => ipcRenderer.invoke('launch-cli-pick'),
  // CLI launch directly in the user's home folder (no picker).
  launchCliHome: () => ipcRenderer.send('launch-cli-home'),
  // Persist a UI preference (e.g. suppressDesktopWarn from the Desktop launch confirmation's
  // "don't show again"). Current prefs arrive with the initial env payload (onEnv).
  setPref: (k, v) => ipcRenderer.send('set-pref', { k, v }),
  onLaunchPrompt: (cb) => ipcRenderer.on('show-launch', () => cb())
})
