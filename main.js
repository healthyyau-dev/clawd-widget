'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog } = require('electron')
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
// Per-session state lives in SESSIONS_DIR/<sid>.json (written by hooks/set-state.js). SESSION_FILE
// is the legacy single-session focus cache still read by focus-session.ps1 / send-choice.ps1 --
// we repoint it at the clicked session on demand (routeToSession).
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions')
const SESSION_FILE = path.join(STATE_DIR, 'session.json')
const ANSWER_FILE = path.join(STATE_DIR, 'answer.json')
const POS_FILE = path.join(STATE_DIR, 'position.json')
// Remembers the folder last chosen in the CLI launch picker, so the next launch defaults to it.
const LAUNCH_DIR_FILE = path.join(STATE_DIR, 'launch-dir.json')
// Small persisted UI preferences (e.g. suppress the Claude Desktop limited-feature warning).
const PREFS_FILE = path.join(STATE_DIR, 'prefs.json')
const VALID = ['default', 'working', 'complex', 'question', 'done', 'error']

// Synthetic sid used for the Claude DESKTOP candidate. Desktop has no hooks/session file, so its
// state is produced by polling detect-desktop-working.ps1 (a UIA scrape) rather than read from
// SESSIONS_DIR. We fold it into the display pool as one synthetic session keyed by this sid so the
// same ranking/click-routing code paths apply, with source-aware branches where it differs.
const DESKTOP_SID = '__desktop__'

// A session is shown until FRESH_MS after its last update; a pending question is honoured longer
// so a slow human answer isn't dropped; files older than PRUNE_MS are deleted from disk.
const FRESH_MS = 15 * 60 * 1000
const QUESTION_FRESH_MS = 30 * 60 * 1000
const PRUNE_MS = 2 * 60 * 60 * 1000
let currentSid = null   // sid of the state currently shown -- routes a click when the renderer sends none
let currentSource = 'cli'   // 'cli' | 'desktop' -- which kind of Claude the shown state belongs to

function ensureDirs () { try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }) } catch (e) {} }

// Read every session state file, dropping unparseable ones and pruning very old ones from disk.
function readAllSessions () {
  const now = Date.now()
  let files = []
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')) } catch (e) { return [] }
  const list = []
  for (const f of files) {
    const p = path.join(SESSIONS_DIR, f)
    let o = null
    try { o = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { o = null }
    if (!o || typeof o !== 'object') continue
    if (now - (Number(o.ts) || 0) > PRUNE_MS) { try { fs.unlinkSync(p) } catch (e) {}; continue }
    if (!VALID.includes(o.state)) o.state = 'default'
    if (!o.sid) o.sid = f.replace(/\.json$/, '')
    list.push(o)
  }
  return list
}

// Is the CLI session behind a state file still alive? A closed terminal (or an interrupted turn
// that never fired Stop) leaves a stale 'working'/'question' file that would otherwise dominate the
// widget for up to FRESH_MS -- showing "working" long after you're done, and (for a stale question)
// killing hover. We check the session's recorded console-client pids (the claude/node/shell chain
// from resolve-session.ps1): if ALL of them are gone, the session is dead. process.kill(pid, 0)
// sends no signal -- it only probes existence (throws ESRCH when gone, EPERM when alive-but-denied).
// Sessions with NO recorded pids (mac/linux, or before resolve ran) are assumed alive so we never
// hide a real session; those still age out via FRESH_MS as before.
function isSessionAlive (o) {
  const pids = Array.isArray(o.consolePids) ? o.consolePids.filter((x) => Number.isInteger(x) && x > 0) : []
  if (!pids.length) return true
  for (const pid of pids) {
    try { process.kill(pid, 0); return true } catch (e) { if (e && e.code === 'EPERM') return true }
  }
  return false
}

// True when `sid` has a fresh, alive session state file -- i.e. a Claude Code session we're
// actively tracking (its state is what the widget is showing). A click over such a session should
// only FOCUS it, never second-guess it with a "no Claude running" launch prompt: detectClaude runs
// a separate process poll that can transiently miss a live session (slow CIM query / timeout), and
// prompting to launch over a visibly-active session is exactly the false positive users hit.
function hasLiveSession (sid) {
  if (!sid) return false
  try {
    const p = path.join(SESSIONS_DIR, String(sid).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json')
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (Date.now() - (Number(o.ts) || 0) < FRESH_MS) && isSessionAlive(o)
  } catch (e) { return false }
}

// ---------- Claude Desktop probe ----------
// Desktop exposes no hooks/session file, so we poll detect-desktop-working.ps1 (a UIA scrape of
// the Desktop window) to observe working/idle/question. It is a LOW-FIDELITY, best-effort signal:
// coarse (no true turn boundaries), can return 'unknown' (window minimized/unrendered), and is
// brittle to UI restyles. So it feeds the display as a fallback/awareness layer only -- a live CLI
// session (event-driven, precise, actionable) always wins a tie (see computeDisplayState).
const DESK_POLL_MS = 2500
// How long a Desktop 'done' (task-completed) pose lingers after a working/question->idle edge before
// it decays to plain idle. This is the Desktop equivalent of a CLI session's FRESH_MS window, so both
// surfaces show "completed" for the same duration -- NOT a brief flash. The pose ends earlier if a new
// task supersedes it, the app closes, or the user focuses Desktop (dismiss-on-focus); see onDeskProbe.
const DESK_DONE_MS = FRESH_MS
let deskBusy = false               // a probe is in flight (skip overlapping ticks)
let deskShown = 'off'              // debounced state we expose: off|working|question|idle
let deskPrevMeaningful = null      // last of working|question|idle, for the done-edge inference
let deskDoneUntil = 0              // 'done' shows until this timestamp (working/question -> idle edge)
let deskIdleStreak = 0             // consecutive idle polls; a lone idle mid-generation is ignored
let deskHwnd = 0                   // Desktop window handle from the probe (used to raise it on click)
let deskStateSince = 0             // when deskShown last CHANGED -- the desktop candidate's "activity started" ts,
                                   // used for the most-recent-wins tiebreak (NOT poll time, which would always be newest)

// Non-blocking probe: spawn PowerShell async so the UIA scan never blocks the widget. A busy guard
// skips a tick while the previous scan is still running. Windows-only; a no-op elsewhere.
function pollDesktop () {
  if (process.platform !== 'win32') return
  if (deskBusy || !win || win.isDestroyed()) return
  deskBusy = true
  const ps1 = resPath('scripts', 'detect-desktop-working.ps1')
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let out = ''
  let child
  try { child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Json'], { windowsHide: true }) } catch (e) { deskBusy = false; return }
  child.stdout.on('data', (d) => { out += d.toString() })
  const done = () => { if (deskBusy) { deskBusy = false; onDeskProbe(out) } }
  child.on('close', done)
  child.on('error', () => { deskBusy = false })
  setTimeout(() => { try { child.kill() } catch (e) {}; done() }, 8000)
}

// Fold one probe result into the debounced desktop state, then push if the exposed state changed.
//   working/question   -> shown as-is.
//   idle               -> only accepted after DESK_IDLE_CONFIRM consecutive idles, so a single
//                         spurious idle mid-generation doesn't blink the sprite. A working/question
//                         -> idle edge arms a 'done' completion pose that lingers DESK_DONE_MS
//                         (15 min, like a CLI session), unless dismissed sooner (focus / app gone).
//   unknown            -> NO signal: keep the current shown state (window likely minimized; it may
//                         still be working behind a hidden window, so we must not call it idle).
//   not-running        -> desktop gone: clear to 'off'.
const DESK_IDLE_CONFIRM = 2
function onDeskProbe (stdout) {
  let r
  try { r = JSON.parse(String(stdout || '').trim()) } catch (e) { r = { state: 'unknown' } }
  const raw = (r && r.state) || 'unknown'
  const now = Date.now()
  if (Number.isFinite(r && r.hwnd)) deskHwnd = Number(r.hwnd) || deskHwnd
  const before = deskShown
  // App gone -> no lingering "completed" pose for a Desktop that no longer exists.
  if (raw === 'not-running') { deskShown = 'off'; deskPrevMeaningful = null; deskIdleStreak = 0; deskHwnd = 0; deskDoneUntil = 0 }
  else if (raw === 'unknown') { /* no signal -- leave deskShown unchanged */ }
  else if (raw === 'idle') {
    deskIdleStreak++
    // Ignore a lone idle between working polls; require DESK_IDLE_CONFIRM in a row to go idle.
    if (deskIdleStreak >= DESK_IDLE_CONFIRM || !(deskPrevMeaningful === 'working' || deskPrevMeaningful === 'question')) {
      if (deskPrevMeaningful === 'working' || deskPrevMeaningful === 'question') deskDoneUntil = now + DESK_DONE_MS
      deskShown = 'idle'
      deskPrevMeaningful = 'idle'
    }
  } else { // working | question
    deskIdleStreak = 0
    deskShown = raw
    deskPrevMeaningful = raw
  }
  // Dismiss-on-focus: while a completion pose is lingering, the user bringing the (now idle) Desktop
  // window to the foreground means they've SEEN the result -- end the pose immediately rather than
  // waiting out the window. r.fg is set by the probe when Desktop is the OS foreground window.
  const changed = deskShown !== before
  if (changed) deskStateSince = now
  let acknowledged = false
  if (deskDoneUntil && now < deskDoneUntil && raw === 'idle' && r && r.fg === true) { deskDoneUntil = 0; acknowledged = true }
  // Push when the raw shown state changed OR we just acknowledged a completion (which flips the
  // candidate done->idle without changing deskShown). Natural time-based expiry of the done window is
  // settled by the 1s pushState poll.
  if (changed || acknowledged) pushState()
}

// The desktop's contribution to the display pool, or null when it shouldn't compete. Returns a
// synthetic session object (source 'desktop', sid DESKTOP_SID) shaped like a CLI session so the
// ranking + click routing reuse the same code. Idle/off desktops don't compete (they equal the
// idle 'default' the widget already shows when nothing else is active).
function desktopCandidate (now) {
  let state = deskShown
  if (state === 'idle' && now < deskDoneUntil) state = 'done'   // completion pose (lingers DESK_DONE_MS)
  if (state !== 'working' && state !== 'question' && state !== 'done') return null
  // ts is when this state STARTED (deskStateSince), not the poll time -- so the most-recent-wins
  // tiebreak compares real activity onset against a CLI session's last update, not a constantly
  // refreshed "now" that would always beat the CLI.
  const o = { sid: DESKTOP_SID, source: 'desktop', state, ts: deskStateSince || now, hwnd: deskHwnd }
  // Human-facing bubble text (the renderer shows state.status for 'working', state.question for
  // 'question'); labelled so the single sprite makes clear it's DESKTOP, not the CLI.
  if (state === 'working') o.status = 'Claude Desktop is working\u2026'
  // 'Open Claude' matches the renderer's passive focus path (buildOptions), so clicking it just
  // raises Desktop (idle-click -> focusDesktop) instead of trying to inject a digit into a CLI
  // console that doesn't exist. Desktop questions aren't answerable from the widget by design.
  else if (state === 'question') { o.question = 'Claude Desktop needs your input'; o.options = ['Open Claude'] }
  else if (state === 'done') o.status = 'Claude Desktop finished'
  return o
}

// Which session's state the single widget shows now. Candidates = fresh, alive CLI sessions
// (source 'cli') PLUS the desktop probe (source 'desktop') when it's active. Ranking ladder:
//   1. tier: pending QUESTION (2) > any ACTIVE non-default (1) > idle default (0)
//   2. within a tier, MOST RECENT activity wins -- newest ts, regardless of source. For CLI that's
//      the session's last hook update; for Desktop it's when its current state started
//      (deskStateSince). So whichever Claude most recently became active/changed is the one shown,
//      and neither source permanently masks the other.
// Sets currentSid + currentSource as a side effect. Dead CLI sessions are excluded so their stale
// state can't lock the widget.
function computeDisplayState () {
  const now = Date.now()
  const cli = readAllSessions()
    .filter((o) => (now - (o.ts || 0) < FRESH_MS) && isSessionAlive(o))
    .map((o) => Object.assign(o, { source: 'cli' }))
  const desk = desktopCandidate(now)
  const pool = desk ? cli.concat([desk]) : cli
  if (!pool.length) { currentSid = null; currentSource = 'cli'; return { state: 'default', source: 'cli', ts: now } }
  // A question only counts for the top tier while still fresh (a CLI question ages out via
  // QUESTION_FRESH_MS; the desktop question carries ts=now so it's always fresh).
  const isQ = (o) => o.state === 'question' && (now - (o.ts || 0) < QUESTION_FRESH_MS)
  // A pending question and an error both sit in the top tier: both need the user's attention and
  // should win over a merely-active (working/complex) session in the single shared widget.
  const tier = (o) => ((isQ(o) || o.state === 'error') ? 2 : (o.state !== 'default' ? 1 : 0))
  // Within a tier, the most recently active candidate wins (newest ts), regardless of source.
  pool.sort((a, b) => (tier(b) - tier(a)) || ((b.ts || 0) - (a.ts || 0)))
  currentSid = pool[0].sid || null
  currentSource = pool[0].source || 'cli'
  return pool[0]
}

// Point the legacy session.json (read by focus-session.ps1 / send-choice.ps1) at a specific
// session's cached terminal so a click acts on THAT session. Returns its pid (or null).
function routeToSession (sid) {
  if (!sid) return null
  try {
    const p = path.join(SESSIONS_DIR, String(sid).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json')
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    const rec = { ts: Date.now() }
    if (Number.isFinite(o.pid) && o.pid > 0) rec.pid = o.pid
    if (Number.isFinite(o.hwnd)) rec.hwnd = o.hwnd
    if (Array.isArray(o.consolePids)) rec.consolePids = o.consolePids
    if (rec.pid) { fs.writeFileSync(SESSION_FILE, JSON.stringify(rec, null, 2)); return rec.pid }
  } catch (e) { dbg('routeToSession failed ' + e) }
  return null
}
function readPos () {
  try { const p = JSON.parse(fs.readFileSync(POS_FILE, 'utf8')); if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y } } catch (e) {}
  return null
}
function writePos (p) {
  try { fs.writeFileSync(POS_FILE, JSON.stringify({ x: p.x, y: p.y, ts: Date.now() }, null, 2)) } catch (e) {}
}
// Last folder the user launched a CLI session in (used as the picker's default). Falls back to
// the home dir when unset or the saved path no longer exists.
function readLaunchDir () {
  try { const o = JSON.parse(fs.readFileSync(LAUNCH_DIR_FILE, 'utf8')); if (o && typeof o.dir === 'string' && fs.existsSync(o.dir)) return o.dir } catch (e) {}
  return os.homedir()
}
function writeLaunchDir (dir) {
  try { fs.writeFileSync(LAUNCH_DIR_FILE, JSON.stringify({ dir, ts: Date.now() }, null, 2)) } catch (e) {}
}
// Persisted UI preferences. Currently just { suppressDesktopWarn: bool } -- when true the
// Claude Desktop "limited features" confirmation is skipped and Desktop launches straight away.
function readPrefs () {
  try { const o = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); if (o && typeof o === 'object') return o } catch (e) {}
  return {}
}
function writePref (key, val) {
  try { const o = readPrefs(); o[key] = val; fs.writeFileSync(PREFS_FILE, JSON.stringify(o, null, 2)) } catch (e) {}
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
    win.webContents.send('env', { display: { x: d.x, y: d.y, width: d.width, height: d.height }, pos: readPos(), prefs: readPrefs() })
    // A freshly (re)loaded renderer boots in the idle 'default' sprite until it receives a state.
    // pushState() dedupes against lastSig, which still holds the PREVIOUS page's signature after a
    // reload -- so an unchanged active state (e.g. a steady 'working'/'question') would be skipped
    // and the new page would stay stuck on the idle bubble. Clear lastSig so the current state is
    // always re-sent to the page that just loaded.
    lastSig = null
    pushState()
    // The launch prompt is click-triggered only (see 'idle-click'): clicking the idle widget
    // with no CLI session running offers to launch one. It never auto-surfaces on startup.
  })
}

let lastSig = null
function stateSig (s) { return [s.sid || '', s.source || '', s.state, s.question || '', s.status || '', (s.questions ? s.questions.length : 0)].join('|') }
function pushState () {
  if (!win || win.isDestroyed()) return
  const s = computeDisplayState()
  const sig = stateSig(s)
  if (sig === lastSig) return   // skip redundant re-pushes (they'd reset the renderer's sub-question index)
  lastSig = sig
  win.webContents.send('state', s)
}

// React to any session file change; also poll so an aging-out question / dead session still
// updates the display even without a filesystem event.
function watchSessions () {
  try { fs.watch(SESSIONS_DIR, { persistent: true }, () => { clearTimeout(watchSessions._t); watchSessions._t = setTimeout(pushState, 60) }) } catch (e) {}
  setInterval(pushState, 1000)
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
ipcMain.on('focus-claude', (_e, sid) => {
  const targetSid = sid || currentSid
  // Desktop-sourced: raise the Desktop window (raise-only), never a CLI terminal.
  if (targetSid === DESKTOP_SID || currentSource === 'desktop') { focusDesktop(); return }
  const pid = routeToSession(targetSid); focusClaude(pid || undefined)
})
// Persist a UI preference from the renderer (e.g. suppressDesktopWarn from the Desktop launch
// confirmation's "don't show again"). Renderer receives the current prefs in the 'env' payload.
ipcMain.on('set-pref', (_e, p) => { if (p && typeof p.k === 'string') writePref(p.k, p.v) })

// A clean click on the sprite: bring the active CLI session forward (raise-only, instant).
// In parallel, check whether ANY Claude is running (CLI session OR the desktop app); if none
// is, offer the launch bubble. Keyed on "any Claude" so an already-running Claude Desktop
// suppresses the launch prompt -- clicking then just focuses, never re-offers to launch what's
// already open. The focus call no-ops when there's no CLI window, so doing both is safe.
ipcMain.on('idle-click', (_e, sid) => {
  const targetSid = sid || currentSid
  // Desktop-sourced click (the widget is showing Desktop's state): bring the Desktop window
  // forward (raise-only). Never route to a CLI terminal.
  if (targetSid === DESKTOP_SID || currentSource === 'desktop') { focusDesktop(); return }
  // The widget is tracking a fresh, alive CLI session (the one it's showing): a click just raises
  // that terminal. Never second-guess a visibly-active session with a launch prompt -- detectClaude
  // is a separate process poll that can transiently miss a live session.
  if (hasLiveSession(targetSid)) {
    const pid = routeToSession(targetSid)
    focusClaude(pid || undefined)
    return
  }
  // Idle: the widget isn't tracking any live CLI session. Act on whatever is ACTUALLY running --
  // raise a running CLI terminal, else raise a running Claude Desktop (so clicking the idle sprite
  // reaches an already-open Desktop, which the old code left unreachable), else (nothing at all is
  // running) offer the launch bubble. This restores the launch prompt AND fixes focusing Desktop.
  detectClaude((r) => {
    if (r.cli) { const pid = routeToSession(targetSid); focusClaude(pid || undefined); return }
    // Desktop with a KNOWN window: raise/restore it (focus-window.ps1 SW_RESTOREs a minimized one).
    if (deskHwnd > 0) { focusDesktop(); return }
    // Desktop PROCESS alive but no window captured by the probe (window closed/minimized to tray, so
    // the UIA probe reported not-running and zeroed deskHwnd, while detect-claude still sees the exe).
    // focusDesktop can't act without an hwnd, so re-open Desktop -- the single-instance app just
    // re-shows/focuses its existing window rather than starting a second copy. Without this the click
    // was a dead no-op (neither focus nor launch bubble).
    if (r.desktop) { launchClaude('desktop'); return }
    sendLaunchPrompt()
  })
})

// Launch a Claude at the user's choice from the launch bubble. Starts a program only --
// never kills/terminates, never types into a session. target: 'cli' | 'desktop'.
ipcMain.on('launch-claude', (_e, target) => launchClaude(target))
// CLI launch in the user's HOME folder (the launch bubble's "Home folder" choice). Start-only,
// like launchClaude: never kills/terminates/types. No folder picker -- home is used directly.
ipcMain.on('launch-cli-home', () => launchClaude('cli', os.homedir()))

// CLI launch WITH a folder chooser. Opens a native folder picker (defaulting to the last
// folder used), then launches `claude` in the chosen directory. Returns the outcome so the
// renderer only dismisses the launch bubble when a folder was actually picked (cancel keeps it).
// Start-only, like launchClaude: never kills/terminates/types.
ipcMain.handle('launch-cli-pick', async () => {
  try {
    // The widget is focusable:false; a parentless dialog is its own OS window and gets focus,
    // avoiding the setFocusable dance the tray menu needs. Restrict to directories.
    const res = await dialog.showOpenDialog({
      title: 'Launch Claude Code in\u2026',
      defaultPath: readLaunchDir(),
      buttonLabel: 'Launch here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { launched: false, canceled: true }
    const dir = res.filePaths[0]
    writeLaunchDir(dir)
    launchClaude('cli', dir)
    return { launched: true, dir }
  } catch (e) { dbg('launch-cli-pick failed ' + e); return { launched: false, canceled: false } }
})

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
ipcMain.on('send-choice', (_e, payload) => {
  // payload is { n, sid } (session-aware) or a bare number (back-compat). Route the digit to the
  // clicked session's console before injecting so it lands in the RIGHT terminal.
  const n = (payload && typeof payload === 'object') ? payload.n : payload
  const sid = (payload && typeof payload === 'object') ? payload.sid : null
  routeToSession(sid || currentSid)
  sendChoice(n)
})
// Submit a multi-question AskUserQuestion (inject Enter) into the routed session.
ipcMain.on('submit-answer', (_e, sid) => { routeToSession(sid || currentSid); sendSubmit() })

// Bring the active Claude Code CLI session's terminal to the front. On Windows
// this is CLI-ONLY: focus-session.ps1 never targets/launches the Claude desktop
// app, and only RAISES windows (no kill/keystroke/terminate calls).
// Optional `pid` targets a SPECIFIC CLI session (tray "Active sessions" click); with no
// pid it uses the last-recorded session (session.json), as before. Still raise-only.
function focusClaude (pid) {
  try {
    if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'focus-session.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]
      if (Number.isInteger(pid) && pid > 0) args.push('-TargetPid', String(pid))
      spawn(psExe, args, { windowsHide: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      // Raise the terminal HOSTING the CLI (focus-session.sh), not the desktop app.
      const sh = resPath('scripts', 'mac', 'focus-session.sh')
      const args = [sh]
      if (Number.isInteger(pid) && pid > 0) args.push(String(pid))
      spawn('sh', args, { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('sh', ['-c', 'claude || xdg-open claude:// || true'], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) { console.error('focusClaude failed', e) }
}

// Raise the Claude DESKTOP window (raise-only) via scripts/focus-window.ps1, targeting the hwnd the
// probe last reported. Deliberately separate from focusClaude/focus-session.ps1, which are CLI-only
// by design and must never touch the desktop app. Windows-only; no-op without a known hwnd.
function focusDesktop () {
  if (process.platform !== 'win32' || !(deskHwnd > 0)) return
  // Opening Desktop from the widget counts as acknowledging any lingering completion pose: end it now
  // (the 1s pushState poll flips the candidate done->idle within a second). The probe's dismiss-on-focus
  // covers the user focusing Desktop directly; this covers the click-to-open path instantly.
  if (deskDoneUntil) deskDoneUntil = 0
  try {
    const ps1 = resPath('scripts', 'focus-window.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Hwnd', String(deskHwnd)], { windowsHide: true, stdio: 'ignore' }).unref()
    dbg('focusDesktop hwnd=' + deskHwnd)
  } catch (e) { dbg('focusDesktop failed ' + e) }
}

// Forward a numbered choice (1-9) to the active CLI session WITHOUT switching windows.
// send-choice.ps1 AttachConsole()s the session's console and WriteConsoleInput()s the
// digit straight into its input buffer -- no foreground steal, and the digit can only land
// in that session (never another window). Number-only (no Enter), never kills. Windows-only.
function sendChoice (n) {
  // macOS/Linux have no focus-free console injection (Windows AttachConsole+WriteConsoleInput
  // has no portable equivalent). Degrade gracefully: bring the session's terminal forward so the
  // user answers there. Keystroke injection via the Accessibility API is a future enhancement.
  if (process.platform !== 'win32') { if (process.platform === 'darwin') focusClaude(); return }
  const num = parseInt(n, 10)
  if (!Number.isInteger(num) || num < 1 || num > 9) return
  try {
    const ps1 = resPath('scripts', 'send-choice.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(num)], { windowsHide: true, stdio: 'ignore' }).unref()
  } catch (e) { console.error('sendChoice failed', e) }
}

// Submit a multi-question AskUserQuestion by injecting ENTER into the session's console (same
// AttachConsole+WriteConsoleInput path as sendChoice, via send-choice.ps1 -Enter). Used ONLY
// after the last sub-question's digit is forwarded -- never after a shell command.
function sendSubmit () {
  if (process.platform !== 'win32') return
  try {
    const ps1 = resPath('scripts', 'send-choice.ps1')
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Enter'], { windowsHide: true, stdio: 'ignore' }).unref()
  } catch (e) { console.error('sendSubmit failed', e) }
}

// Ask the renderer to show the "no Claude running -- launch one?" bubble.
function sendLaunchPrompt () { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('show-launch') }

// Detect whether ANY Claude is currently running (desktop app or a Claude Code CLI
// session). READ-ONLY: detect-claude.ps1 only enumerates processes. cb receives
// { desktop, cli, any }. On non-Windows or any failure, reports nothing running.
function detectClaude (cb) {
  try {
    let child
    if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'detect-claude.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true })
    } else if (process.platform === 'darwin') {
      child = spawn('sh', [resPath('scripts', 'mac', 'detect-claude.sh')])
    } else { cb({ desktop: false, cli: false, any: false }); return }
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
  try {
    let child
    if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'list-sessions.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      child = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true })
    } else if (process.platform === 'darwin') {
      child = spawn('sh', [resPath('scripts', 'mac', 'list-sessions.sh')])
    } else { cb([]); return }
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
// Optional `workDir` (CLI only) is the folder the new terminal starts in; when unset the
// launcher uses the terminal's own default directory.
function launchClaude (target, workDir) {
  const t = target === 'desktop' ? 'desktop' : 'cli'
  // Only honour an existing directory; anything else is dropped so the launcher keeps its default.
  const dir = (t === 'cli' && typeof workDir === 'string' && workDir && fs.existsSync(workDir)) ? workDir : ''
  try {
    // Belt-and-suspenders: the widget may itself run inside a Claude Code session, so its
    // env carries the nested-session markers (CLAUDECODE + the SSE-port vars). Any child
    // we spawn inherits them and a launched `claude` would abort with "cannot be launched
    // inside another Claude Code session". Strip them from the env handed to every child
    // so no launcher can leak them, regardless of platform. Harmless no-op in a shipped
    // build launched normally (the vars simply aren't present).
    const env = { ...process.env }
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_CODE_SSE_PORT
    if (process.platform === 'win32') {
      const ps1 = resPath('scripts', 'launch-claude.ps1')
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, t]
      if (dir) args.push('-WorkDir', dir)
      spawn(psExe, args, { windowsHide: true, stdio: 'ignore', env }).unref()
    } else if (process.platform === 'darwin') {
      const args = [resPath('scripts', 'mac', 'launch-claude.sh'), t]
      if (dir) args.push(dir)
      spawn('sh', args, { detached: true, stdio: 'ignore', env }).unref()
    } else if (t === 'desktop') {
      spawn('sh', ['-c', 'xdg-open claude:// || true'], { detached: true, stdio: 'ignore', env }).unref()
    } else {
      // Linux CLI: run in the chosen dir when given (spawn cwd), else the launcher's default.
      spawn('sh', ['-c', 'x-terminal-emulator -e claude || claude || true'], { detached: true, stdio: 'ignore', env, cwd: dir || undefined }).unref()
    }
    dbg('launchClaude ' + t + (dir ? ' dir=' + dir : ''))
  } catch (e) { dbg('launchClaude failed ' + e) }
}

function setAutoStart (enable) { try { app.setLoginItemSettings({ openAtLogin: !!enable }) } catch (e) {} }

// Status glyph shown next to each active session in the menu, from its per-session state.
const STATE_EMOJI = { question: '\u2753', working: '\u{1F504}', complex: '\u{1F9E0}', done: '\u2705', default: '\u{1F4A4}' }
// Find the freshest per-session state file matching a LIVE session (by console-client pid, else
// by project title) and return its status emoji. '' when nothing matches.
function statusEmojiFor (live, states) {
  const matches = states.filter((s) =>
    (Array.isArray(s.consolePids) && s.consolePids.includes(live.pid)) ||
    (s.title && live.title && s.title === live.title))
  if (!matches.length) return STATE_EMOJI.default   // live but no tracked activity -> idle
  matches.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return STATE_EMOJI[matches[0].state] || STATE_EMOJI.default
}

// `sessions` is the live list from listSessions(); each becomes a clickable item that
// raises that session's terminal (focusClaude(pid)), prefixed with a status emoji read from
// the session's per-session state file.
function buildMenu (sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const states = readAllSessions()
  const sessionItems = []
  // Claude Desktop, when running (the probe knows its window), listed alongside the CLI sessions.
  // Clicking it RAISES the Desktop window (focusDesktop) -- never a CLI terminal. Its status glyph
  // comes from the probe's debounced state (working/question/idle).
  if (deskHwnd > 0 || (deskShown && deskShown !== 'off')) {
    const demoji = STATE_EMOJI[deskShown] || STATE_EMOJI.default
    sessionItems.push({ label: demoji + '  Desktop Claude', click: () => focusDesktop() })
  }
  for (const s of list) {
    const emoji = statusEmojiFor(s, states)
    const base = (s.title && String(s.title).slice(0, 60)) || ('Claude session ' + s.pid)
    sessionItems.push({ label: (emoji ? emoji + '  ' : '') + base, click: () => focusClaude(s.pid) })
  }
  if (!sessionItems.length) sessionItems.push({ label: 'No active sessions', enabled: false })
  // A checkbox/radio item makes Windows reserve an empty left icon gutter for EVERY row
  // (the "phantom" spacing). Use a plain item with a leading check glyph instead so no
  // gutter is reserved and the menu hugs its text.
  let loginOn = false
  try { loginOn = app.getLoginItemSettings().openAtLogin } catch (e) {}
  return Menu.buildFromTemplate([
    { label: 'Clawd', enabled: false },
    { type: 'separator' },
    { label: (loginOn ? '\u2713 ' : '') + 'Start at login', click: () => setAutoStart(!loginOn) },
    { type: 'separator' },
    { label: 'Active sessions', enabled: false },
    ...sessionItems,
    { type: 'separator' },
    // Surface the launch bubble (CLI/Desktop -> where to start) so a session can be started
    // straight from the menu. sendLaunchPrompt just asks the renderer to show it; start-only.
    { label: 'New session\u2026', click: () => sendLaunchPrompt() },
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
  // A duplicate launch (e.g. the SessionStart hook starting the installed Clawd.exe while this
  // instance already holds the single-instance lock) must NOT reload the renderer -- that blanks
  // the widget for a moment ("disappears"). Just re-show it and re-assert it on top.
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (!win.isVisible()) win.showInactive(); reassertTop() } })
  app.whenReady().then(() => {
    ensureDirs()
    // Heartbeat pid so the SessionStart hook (ensureWidgetRunning) knows a widget -- installed or
    // this dev instance -- is already up and doesn't launch a duplicate that would bounce off the
    // single-instance lock and reload/blank the widget.
    try { fs.writeFileSync(path.join(STATE_DIR, 'widget.pid'), String(process.pid)) } catch (e) {}
    createWindow()
    watchSessions()
    buildTray()
    // Poll the Claude Desktop window state (Windows-only). Low-fidelity awareness layer: it fills
    // the sprite when no CLI session is louder, so the widget is no longer blind to Desktop.
    if (process.platform === 'win32') { setTimeout(pollDesktop, 1500); setInterval(pollDesktop, DESK_POLL_MS) }
  })
  app.on('window-all-closed', () => app.quit())
}
