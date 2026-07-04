'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

// Resolve a bundled file to a path a CHILD PROCESS can actually open. When packaged, app
// files live inside app.asar (a single archive) -- Electron's fs can read them, but an
// external process like powershell.exe cannot. Such files (the .ps1 scripts) are unpacked
// via "asarUnpack" to app.asar.unpacked/, so rewrite the path accordingly. No-op in dev.
function resPath (...parts) {
  return path.join(__dirname, ...parts).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
}

const STATE_DIR = path.join(os.homedir(), '.clawd-widget')
function dbg (m) { try { fs.appendFileSync(path.join(STATE_DIR, 'main.log'), new Date().toISOString() + '  ' + m + '\n') } catch (e) {} }
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const ANSWER_FILE = path.join(STATE_DIR, 'answer.json')
const POS_FILE = path.join(STATE_DIR, 'position.json')
const VALID = ['default', 'working', 'complex', 'question', 'done']

function ensureStateFile () {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ state: 'default', ts: Date.now() }, null, 2))
  } catch (e) { console.error('state file init failed', e) }
}
function readState () {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!VALID.includes(raw.state)) raw.state = 'default'
    return raw
  } catch (e) { return { state: 'default', ts: Date.now() } }
}
function writeState (obj) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...obj, ts: Date.now() }, null, 2)) } catch (e) {}
}
function readPos () {
  try { const p = JSON.parse(fs.readFileSync(POS_FILE, 'utf8')); if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y } } catch (e) {}
  return null
}
function writePos (p) {
  try { fs.writeFileSync(POS_FILE, JSON.stringify({ x: p.x, y: p.y, ts: Date.now() }, null, 2)) } catch (e) {}
}

let win = null
let tray = null
let shown = false
let hoverOn = false
let hoverSuspend = false   // true while dragging
let bubbleShown = false    // renderer reports when the bubble (with buttons) is visible
let ignoreOn = true

function reassertTop () {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.moveTop()
}

// Hover + click-through by polling the real cursor (DOM mouseleave is unreliable
// for transparent click-through windows). Capture clicks when the cursor is over
// the window OR while the bubble's buttons are showing (auto-show has no hover).
function pollHover () {
  if (!win || win.isDestroyed() || hoverSuspend) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
  const ignore = !(over || bubbleShown)
  if (ignore !== ignoreOn) { ignoreOn = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }) }
  if (over !== hoverOn) {
    hoverOn = over
    if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('hover', over)
  }
}

function createWindow () {
  win = new BrowserWindow({
    width: 200, height: 200,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  reassertTop()
  win.setIgnoreMouseEvents(true, { forward: true })
  setInterval(reassertTop, 600)
  setInterval(pollHover, 90)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    const d = screen.getPrimaryDisplay().bounds
    win.webContents.send('env', { display: { x: d.x, y: d.y, width: d.width, height: d.height }, pos: readPos() })
    pushState()
    // On startup, if no Claude (desktop or CLI) is running, offer to launch one.
    detectClaude((r) => { if (!r.any) sendLaunchPrompt() })
  })
}

function pushState () { if (win && !win.isDestroyed()) win.webContents.send('state', readState()) }

function watchStateFile () {
  try { fs.watchFile(STATE_FILE, { interval: 250 }, () => pushState()) }
  catch (e) { setInterval(pushState, 400) }
}

// ---------- IPC ----------
ipcMain.on('set-ignore-mouse', (_e, ignore) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true }) })
ipcMain.on('set-bounds', (_e, b) => {
  if (!win || win.isDestroyed()) return
  const x = Math.round(b.x), y = Math.round(b.y)
  const w = Math.max(40, Math.round(b.w)), h = Math.max(40, Math.round(b.h))
  win.setBounds({ x, y, width: w, height: h })
  reassertTop()
  if (!shown) { shown = true; win.showInactive() }
})
ipcMain.on('show-menu', () => {
  if (!win || win.isDestroyed()) return
  // The widget window is normally focusable:false, so a menu popped from it is owned by a
  // never-activated window and Windows never tells it to close on an outside click. Make the
  // window focusable AND focus it so it's the active window; then clicking elsewhere
  // deactivates it and the menu dismisses. BUT setFocusable(true) drops the window's
  // tool-window style, so a focused widget would pop up in the taskbar/alt-tab -- re-assert
  // setSkipTaskbar(true) to keep it hidden there. Populate the live session list like the tray.
  win.setFocusable(true)
  win.setSkipTaskbar(true)
  win.focus()
  win.setSkipTaskbar(true)
  listSessions((sessions) => {
    if (!win || win.isDestroyed()) return
    buildMenu(sessions).popup({
      window: win,
      callback: () => { try { win.setFocusable(false); win.setSkipTaskbar(true) } catch (e) {} }
    })
  })
})
ipcMain.on('drag-state', (_e, d) => { hoverSuspend = !!d })
ipcMain.on('bubble-visible', (_e, v) => { bubbleShown = !!v })
ipcMain.on('save-pos', (_e, p) => { if (p && typeof p.x === 'number' && typeof p.y === 'number') writePos(p) })
ipcMain.on('focus-claude', () => focusClaude())

// A clean click on the sprite: bring the active CLI session forward (raise-only, instant).
// In parallel, check whether a CLI SESSION is running; if none is, offer the launch bubble.
// Keyed on the CLI (not "any Claude") so that closing the terminal surfaces the prompt even
// when the desktop app is still open. The focus call no-ops when there's no CLI window, so
// doing both is safe.
ipcMain.on('idle-click', () => {
  focusClaude()
  detectClaude((r) => { if (!r.cli) sendLaunchPrompt() })
})

// Launch a Claude at the user's choice from the launch bubble. Starts a program only --
// never kills/terminates, never types into a session. target: 'cli' | 'desktop'.
ipcMain.on('launch-claude', (_e, target) => launchClaude(target))

// Selecting an answer records the choice to answer.json. It must never terminate a
// window or process. (It no longer "never touches the session": see 'send-choice'
// below, a user-enabled feature that forwards the chosen option's number to the CLI.)
ipcMain.on('answer', (_e, payload) => {
  try { fs.writeFileSync(ANSWER_FILE, JSON.stringify({ ...payload, ts: Date.now() }, null, 2)) } catch (e) {}
})

// Option-click forwarding (USER-ENABLED): type the chosen option's NUMBER into the
// active CLI session so the choice is selected without re-picking it in the terminal.
// This is a deliberate, user-approved exception to the old "answer never touches the
// session" rule. It reuses focus-session.ps1 with a digit arg; that script sends the
// key ONLY when the resolved CLI window is actually foreground (never types into
// another window) and never sends Enter (number-only). Still NO kill/terminate.
ipcMain.on('send-choice', (_e, n) => sendChoice(n))

// Bring the active Claude Code CLI session's terminal to the front. On Windows
// this is CLI-ONLY: focus-session.ps1 never targets/launches the Claude desktop
// app, and only RAISES windows (no kill/keystroke/terminate calls).
// Optional `pid` targets a SPECIFIC CLI session (tray "Active sessions" click); with no
// pid it uses the last-recorded session (session.json), as before. Still raise-only.
function focusClaude (pid) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'focus-session.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]
      if (Number.isInteger(pid) && pid > 0) args.push('-TargetPid', String(pid))
      spawn(psExe, args, { windowsHide: true, stdio: 'ignore' }).unref()
    } else {
      spawn('sh', ['-c', 'claude || xdg-open claude:// || true'], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) { console.error('focusClaude failed', e) }
}

// Forward a numbered choice (1-9) to the active CLI session WITHOUT switching windows.
// send-choice.ps1 AttachConsole()s the session's console and WriteConsoleInput()s the
// digit straight into its input buffer -- no foreground steal, and the digit can only land
// in that session (never another window). Number-only (no Enter), never kills. Windows-only.
function sendChoice (n) {
  const num = parseInt(n, 10)
  if (!Number.isInteger(num) || num < 1 || num > 9) return
  if (process.platform !== 'win32') return
  try {
    const ps1 = resPath('scripts', 'send-choice.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(num)], { windowsHide: true, stdio: 'ignore' }).unref()
  } catch (e) { console.error('sendChoice failed', e) }
}

// Ask the renderer to show the "no Claude running -- launch one?" bubble.
function sendLaunchPrompt () { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('show-launch') }

// Detect whether ANY Claude is currently running (desktop app or a Claude Code CLI
// session). READ-ONLY: detect-claude.ps1 only enumerates processes. cb receives
// { desktop, cli, any }. On non-Windows or any failure, reports nothing running.
function detectClaude (cb) {
  if (process.platform !== 'win32') { cb({ desktop: false, cli: false, any: false }); return }
  try {
    const ps1 = resPath('scripts', 'detect-claude.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true })
    let out = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; cb(r) } }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('close', () => {
      const desktop = /desktop=1/.test(out)
      const cli = /cli=1/.test(out)
      dbg('detectClaude desktop=' + desktop + ' cli=' + cli)
      finish({ desktop, cli, any: desktop || cli })
    })
    child.on('error', (e) => { dbg('detectClaude error ' + e); finish({ desktop: false, cli: false, any: false }) })
    setTimeout(() => finish({ desktop: false, cli: false, any: false }), 5000)
  } catch (e) { dbg('detectClaude failed ' + e); cb({ desktop: false, cli: false, any: false }) }
}

// Enumerate the active Claude Code CLI sessions for the tray menu. READ-ONLY:
// list-sessions.ps1 only enumerates processes/windows -- never starts/focuses/kills.
// cb receives an array of { pid, title }. Non-Windows or any failure -> empty list.
function listSessions (cb) {
  if (process.platform !== 'win32') { cb([]); return }
  try {
    const ps1 = resPath('scripts', 'list-sessions.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true })
    let out = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; cb(r) } }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('close', () => {
      let list = []
      try {
        const parsed = JSON.parse(out.trim() || '[]')
        list = Array.isArray(parsed) ? parsed : [parsed]   // PS5.1 emits a bare object for a single session
      } catch (e) { list = [] }
      list = list.filter((s) => s && Number.isInteger(s.pid))
      dbg('listSessions n=' + list.length)
      finish(list)
    })
    child.on('error', (e) => { dbg('listSessions error ' + e); finish([]) })
    // list-sessions.ps1 has no Add-Type, so it's fast even cold; 8s is a generous guard.
    setTimeout(() => { if (!done) dbg('listSessions timeout'); finish([]) }, 8000)
  } catch (e) { dbg('listSessions failed ' + e); cb([]) }
}

// Launch a Claude when none is running. Starts a program only -- never kills or types.
// 'cli' opens a fresh terminal running `claude`; 'desktop' starts the Claude desktop app.
function launchClaude (target) {
  const t = target === 'desktop' ? 'desktop' : 'cli'
  try {
    if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'launch-claude.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, t], { windowsHide: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      if (t === 'desktop') spawn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore' }).unref()
      else spawn('open', ['-a', 'Terminal', '--args', 'claude'], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('sh', ['-c', t === 'desktop' ? 'xdg-open claude:// || true' : 'x-terminal-emulator -e claude || claude || true'], { detached: true, stdio: 'ignore' }).unref()
    }
    dbg('launchClaude ' + t)
  } catch (e) { dbg('launchClaude failed ' + e) }
}

function setAutoStart (enable) { try { app.setLoginItemSettings({ openAtLogin: !!enable }) } catch (e) {} }

// `sessions` is the live list from listSessions(); each becomes a clickable item that
// raises that session's terminal (focusClaude(pid)).
function buildMenu (sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const sessionItems = list.length
    ? list.map((s) => ({
        label: (s.title && String(s.title).slice(0, 60)) || ('Claude session ' + s.pid),
        click: () => focusClaude(s.pid)
      }))
    : [{ label: 'No active sessions', enabled: false }]
  return Menu.buildFromTemplate([
    { label: 'Clawd', enabled: false },
    { type: 'separator' },
    { label: 'Switch to Claude', click: () => focusClaude() },
    { label: 'Start at login', type: 'checkbox', checked: (() => { try { return app.getLoginItemSettings().openAtLogin } catch (e) { return false } })(), click: (mi) => setAutoStart(mi.checked) },
    { type: 'separator' },
    { label: 'Active sessions', enabled: false },
    ...sessionItems,
    { type: 'separator' },
    { label: 'Close widget', click: () => app.quit() }
  ])
}

function buildTray () {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'clawd.png'))
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('Clawd')
  // Rebuild on demand so the active-sessions list is always live at open time.
  const popup = () => listSessions((sessions) => { if (tray) tray.popUpContextMenu(buildMenu(sessions)) })
  tray.on('click', popup)
  tray.on('right-click', popup)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.webContents.reloadIgnoringCache(); reassertTop() } })
  app.whenReady().then(() => {
    ensureStateFile()
    createWindow()
    watchStateFile()
    buildTray()
  })
  app.on('window-all-closed', () => app.quit())
}
