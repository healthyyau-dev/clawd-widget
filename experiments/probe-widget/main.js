'use strict'

/*
 * PROTOTYPE / THROWAWAY TEST BUILD -- lives entirely inside experiments/.
 * A standalone Electron widget that shows the Claude DESKTOP working/idle state
 * from ../detect-desktop-working.ps1. It is completely independent of the real
 * clawd widget: its own userData dir (so it does NOT fight the dev widget's
 * single-instance lock), its own window, no hooks, no session files.
 *
 * Run:  node_modules/.bin/electron experiments/probe-widget
 * Quit: right-click the panel -> Quit (or close the tray/kill the electron proc).
 * Dump: delete the experiments/ folder -- nothing else is touched.
 */

const { app, BrowserWindow, Menu, screen } = require('electron')
const path = require('path')
const { execFile } = require('child_process')

// Isolate from the real widget: a distinct userData path gives this instance its
// own single-instance lock, so both widgets can run side by side.
app.setPath('userData', path.join(__dirname, '.userdata'))

const PROBE = path.join(__dirname, '..', '..', 'scripts', 'detect-desktop-working.ps1')
const POLL_MS = 2000

let win = null
let busy = false

// Desktop has no "completed" event, so we infer it: a working/question -> idle edge
// means the turn just finished. Emit a transient 'done' for DONE_MS, then fall back
// to idle. State lives HERE (the poller), not in the stateless .ps1 probe.
let prevMeaningful = null   // last of working|question|idle we saw
let doneUntil = 0
const DONE_MS = 4000

function withDone (r) {
  const now = Date.now()
  const raw = (r && r.state) || 'unknown'
  if (raw === 'idle' && (prevMeaningful === 'working' || prevMeaningful === 'question')) {
    doneUntil = now + DONE_MS
  }
  if (raw === 'working' || raw === 'question' || raw === 'idle') prevMeaningful = raw
  if (raw === 'idle' && now < doneUntil) {
    return { state: 'done', reason: 'just-finished', ts: now }
  }
  return Object.assign({ ts: now }, r)
}

function createWindow () {
  const d = screen.getPrimaryDisplay().bounds
  win = new BrowserWindow({
    width: 260, height: 150,
    x: d.x + d.width - 280, y: d.y + 48,   // top-right, away from the real widget (bottom-left)
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'index.html'))
  win.webContents.on('did-finish-load', tick)
}

// Non-blocking probe: spawn PowerShell async so the UIA scan never freezes the
// window. A busy guard skips a tick if the previous scan is still running.
function tick () {
  if (busy || !win || win.isDestroyed()) return
  busy = true
  execFile('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE, '-Json'],
    { timeout: 8000, windowsHide: true },
    (err, stdout) => {
      busy = false
      let r
      try { r = JSON.parse(String(stdout || '').trim()) } catch (e) { r = { state: 'unknown', reason: 'bad-json' } }
      if (err && !stdout) r = { state: 'unknown', reason: 'probe-error' }
      if (win && !win.isDestroyed()) win.webContents.send('probe', withDone(r))
    })
}

function menu () {
  return Menu.buildFromTemplate([
    { label: 'Claude Desktop probe (test build)', enabled: false },
    { type: 'separator' },
    { label: 'Probe now', click: tick },
    { label: 'Quit', click: () => app.quit() }
  ])
}

app.whenReady().then(() => {
  createWindow()
  setInterval(tick, POLL_MS)
  const { ipcMain } = require('electron')
  ipcMain.on('ctxmenu', () => menu().popup({ window: win }))
})
app.on('window-all-closed', () => app.quit())
