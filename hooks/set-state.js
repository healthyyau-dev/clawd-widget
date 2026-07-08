#!/usr/bin/env node
'use strict'

/*
 * Called by Claude Code lifecycle hooks. Writes the widget state to
 * ~/.clawd-widget/state.json (watched by the Electron widget) and records the
 * terminal session so the widget can focus it on click.
 *   node set-state.js <state> [--reset]
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

const DIR = path.join(os.homedir(), '.clawd-widget')
// Each Claude Code CLI session writes its OWN state file under sessions/, keyed by the hook's
// session_id, so concurrent sessions never overwrite each other's bubble in the single shared
// widget. main.js watches this directory and aggregates (a pending question always wins).
const SESSIONS_DIR = path.join(DIR, 'sessions')

const args = process.argv.slice(2)
let state = args[0] || 'default'
const reset = args.includes('--reset')
// PostToolUse marker: after a tool finishes (e.g. a permission was approved and the tool
// ran, or an AskUserQuestion was answered), clear a lingering question bubble.
const afterTool = args.includes('--after-tool')
// 'perm' marks a PermissionRequest-driven question ("Do you want to proceed?"). It
// surfaces like a question but must NOT force a (slow) session re-resolve, so the
// permission prompt isn't delayed by the hook.
const perm = args.includes('perm')
// --launch-widget (SessionStart): make sure the desktop widget is running when a Claude
// Code CLI session starts, launching the INSTALLED build if it isn't already up.
const launchWidget = args.includes('--launch-widget')

let hook = {}
try {
  const raw = fs.readFileSync(0, 'utf8')
  if (raw && raw.trim()) hook = JSON.parse(raw)
} catch (e) { /* no stdin / not JSON */ }

// SessionStart begins a NEW session. State files are keyed by cwd (see `sid` below), so a session
// relaunched in the SAME folder reuses the previous session's file -- whose cached focus info
// (pid/hwnd/consolePids) now points at the CLOSED terminal. Carrying that dead cache forward makes
// main.js treat the fresh session as dead: isSessionAlive() sees only dead pids, filters the
// session out of the display pool, so the widget IGNORES its hook events (stuck idle) and routes
// clicks to the dead terminal (nothing happens). So on SessionStart we drop the stale focus cache
// and force a fresh resolve. `--launch-widget` is passed only on SessionStart (see settings.json).
const sessionStart = launchWidget || hook.hook_event_name === 'SessionStart'

// A tool-permission prompt ("Do you want to proceed?") -- detected from the 'perm' arg
// (PermissionRequest hook) OR from the payload itself, so the Notification path (current
// session) also gets permission treatment. We do NOT fabricate options (the hook doesn't
// reveal them); the bubble just shows the command + "Open Claude" to decide in the terminal.
const isPermission = perm ||
  hook.notification_type === 'permission_prompt' ||
  hook.hook_event_name === 'PermissionRequest'

// This session's identity. Key the state file by the PROJECT (cwd): it is present on EVERY hook
// payload and stable for the session. session_id is NOT always present -- several events omit it
// -- and keying on it split ONE session across two files (session_id vs a pid fallback), so a
// question set under one key was never cleared under the other (stale/mismatched bubbles). cwd is
// computed identically for all events, so every event for a project updates the same file.
const cwd = hook.cwd || process.cwd()
const title = (String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop()) || null
const sid = String(cwd || hook.session_id || ('pid-' + process.ppid)).replace(/[^A-Za-z0-9_.-]/g, '_')

fs.mkdirSync(SESSIONS_DIR, { recursive: true })
const FILE = path.join(SESSIONS_DIR, sid + '.json')

// --- DIAGNOSTIC (remove after debugging) -------------------------------------
// Append one line per hook invocation so we can see exactly which events fire
// (esp. PermissionRequest vs Notification) and with what payload.
try {
  fs.appendFileSync(path.join(DIR, 'hook-trace.log'),
    JSON.stringify({
      t: new Date().toISOString(),
      event: hook.hook_event_name || null,
      args,
      notification_type: hook.notification_type || null,
      tool_name: hook.tool_name || hook.toolName || null,
      isPermission
    }) + '\n')
} catch (e) { /* diagnostic only */ }
// --- END DIAGNOSTIC ----------------------------------------------------------

// SessionStart: bring the widget up if it isn't already. Done first (and independent of
// the state write) so a fresh CLI session always gets its companion widget.
if (launchWidget) ensureWidgetRunning()

// Write this session's state file ATOMICALLY (temp + rename) so main.js never reads a
// half-written file mid-poll -- a partial read would drop this session and momentarily flip the
// widget to the idle sprite while it's actually working. rename is atomic on the same volume.
function writeStateFile (obj) {
  const str = JSON.stringify(obj, null, 2)
  try {
    const tmp = FILE + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, str)
    fs.renameSync(tmp, FILE)
  } catch (e) {
    try { fs.writeFileSync(FILE, str) } catch (e2) {}
  }
}

let cur = {}
try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch (e) {}

// PostToolUse: a tool just finished. If a question bubble is still showing (a permission
// that was approved, or an answered AskUserQuestion), clear it back to "working". Only
// touch a lingering question -- never disturb complex/done/working/default.
if (afterTool) {
  // Clear a lingering question ONLY if it belongs to the tool that just finished. A tool's
  // PostToolUse can fire slightly AFTER a newer question (e.g. an AskUserQuestion) has already
  // replaced it in state.json; without this check that stale event would wipe the newer
  // question, making it flash on screen and vanish. Fall back to the old clear-anything
  // behaviour when either tool name is unknown.
  const doneTool = hook.tool_name || hook.toolName || null
  if (cur.state === 'question' && (!cur.tool || !doneTool || cur.tool === doneTool)) {
    // Preserve this session's identity + focus cache so main.js can still route/aggregate.
    writeStateFile({ ...identity(cur), ...focusCache(cur), state: 'working', ts: Date.now(), status: 'Working…' })
  }
  process.exit(0)
}

// Auto-approved permissions: under bypassPermissions the CLI never shows an interactive prompt,
// yet a PermissionRequest hook can still fire. Raising a 'question' there is wrong -- the user is
// never asked, so the bubble would sit on-screen for the whole (possibly long) tool run, only
// clearing on PostToolUse. So for a genuinely auto-approved permission we do NOT raise a question
// -- and we clear any stale one -- letting the tool show as 'working' (PreToolUse already set it).
//
// CRITICAL: the ONLY mode that auto-approves without ever prompting is bypassPermissions. Do NOT
// treat acceptEdits as auto-approving: acceptEdits auto-accepts edits SILENTLY (no PermissionRequest
// fires at all in that case -- PreToolUse goes straight to PostToolUse), but it STILL shows an
// interactive prompt for some edits (e.g. a file not yet read) as well as for Bash/WebFetch/etc.
// Those real prompts DO fire a PermissionRequest. An earlier version suppressed Edit-in-acceptEdits
// on the assumption edits never prompt there, so genuine edit-permission prompts never surfaced
// (proven by the hook trace: PermissionRequest(Edit) followed ~30s later by PostToolUse = a human
// answering). The rule is simply: if a PermissionRequest fires and we're not bypassing, surface it.
const pmode = hook.permission_mode || hook.permissionMode || ''
const autoApproved = pmode === 'bypassPermissions'
if (isPermission && autoApproved) {
  // Only overwrite a lingering question (spurious, from this auto-approve path). Never disturb a
  // running subagent's 'complex' or anything else -- just leave the working state PreToolUse set.
  if (cur.state === 'question') {
    writeStateFile({ ...identity(cur), ...focusCache(cur), state: 'working', ts: Date.now(), status: statusFor(hook) || 'Working\u2026' })
  }
  process.exit(0)
}

// Error notifications (e.g. an API "401 authentication error", rate-limit, or other failure)
// surface as a distinct ERROR state rather than the generic waiting/question bubble. Claude Code
// delivers these via the Notification hook (which invokes this script with `question`), so detect
// them from the payload text before the question/idle handling below claims the event. Not a
// permission prompt, and never from a UserPromptSubmit reset (which starts a fresh turn).
const notifText = [hook.message, hook.notification, hook.notification_type]
  .filter((x) => typeof x === 'string').join(' ')
const ERROR_RE = /\b(4\d{2}|5\d{2}|unauthorized|forbidden|authentication|auth error|api error|rate.?limit|overloaded|quota|invalid api key|failed|error)\b/i
// AskUserQuestion carries its own structured questions/options in the payload; a question whose
// text happens to contain "error" must NOT be misread as an error notification, so exclude it.
const ti0 = hook.tool_input || hook.toolInput || {}
const hasAskUI = Array.isArray(ti0.questions) && ti0.questions.length > 0
const looksLikeError = (hook.hook_event_name === 'Notification' || state === 'question') &&
  !isPermission && !reset && !hasAskUI && notifText && ERROR_RE.test(notifText)
if (looksLikeError) {
  const msg = String(hook.message || hook.notification || notifText).replace(/\s+/g, ' ').trim().slice(0, 160)
  const out = { ...identity(cur), ...focusCache(cur), state: 'error', ts: Date.now() }
  if (msg) out.status = msg
  writeStateFile(out)
  recordSession()
  process.exit(0)
}

// An "idle" notification ("Claude is waiting for your input") means the turn is DONE, not
// a question -- otherwise it clobbers "Task completed!" with a generic waiting bubble.
// But if a REAL question is already pending, keep it (idle just means "answer it").
if (state === 'question' && hook.notification_type === 'idle_prompt') {
  if (cur.state === 'question') process.exit(0)
  state = 'done'
}

// Don't let a stray PreToolUse "working" downgrade a complex/question turn.
if (state === 'working' && !reset && (cur.state === 'complex' || cur.state === 'question')) process.exit(0)

// Don't let a bare Notification "question" (no options) clobber a live
// AskUserQuestion that already carries real options.
if (state === 'question' && !reset) {
  const incoming = extractOptions(hook)
  const curHasOptions = cur.state === 'question' && Array.isArray(cur.options) && cur.options.length
  if ((!incoming || !incoming.length) && curHasOptions && (Date.now() - (cur.ts || 0) < 5 * 60 * 1000)) process.exit(0)
}

// A SINGLE tool permission fires several hooks -- a PermissionRequest ("Allow <tool>: <cmd>?")
// and then a generic Notification ("Claude needs your permission to use <tool>"), sometimes
// repeated. Without a guard these overwrite each other and the bubble visibly cycles between
// the two texts. Keep the FIRST (most informative) permission bubble for a tool: skip a later
// permission event for the SAME tool while its question is still live. A different tool, or a
// later permission after this one was answered (cur is no longer a question), still gets through.
if (state === 'question' && isPermission && !reset && cur.state === 'question' && cur.perm) {
  const incomingTool = hook.tool_name || hook.toolName || cur.tool
  if (cur.tool && incomingTool === cur.tool && (Date.now() - (cur.ts || 0) < 5 * 60 * 1000)) process.exit(0)
}

const out = { sid, cwd, title, state, ts: Date.now() }
// Carry forward this session's resolved focus cache (pid/hwnd/consolePids) so it survives state
// writes; recordSession() refreshes it when needed. EXCEPT on SessionStart, where the previous
// session's cache is dead (see `sessionStart` above) -- dropping it lets recordSession re-resolve
// the new terminal, and meanwhile main.js treats a session with no pids as alive (not filtered).
if (!sessionStart) Object.assign(out, focusCache(cur))
if (state === 'question') {
  // Tag the question with the tool that raised it (AskUserQuestion, or the tool being
  // permission-prompted). --after-tool uses this to clear ONLY the question of the tool that
  // just finished, so a stale PostToolUse can't wipe a newer question. When a follow-up event
  // for the same prompt carries no tool name (e.g. a permission Notification), keep the tool
  // already recorded rather than dropping it to null.
  out.tool = hook.tool_name || hook.toolName || (cur.state === 'question' ? cur.tool : null) || null
  // Mark permission prompts so the dedupe guard above can tell a permission question from an
  // AskUserQuestion on the NEXT event and avoid the two forms overwriting each other.
  if (isPermission) out.perm = true
  const q = extractQuestion(hook)
  let opts = extractOptions(hook)
  if (q) out.question = q
  // AskUserQuestion carries its choices in the payload (opts above). A permission prompt does NOT
  // (its choice count varies, 2 vs 3), so when a question arrives WITHOUT payload options we read
  // the REAL numbered list from this session's terminal (read-options.ps1). The widget then shows
  // those exact options as buttons and forwards the matching number on click. If the scrape comes
  // up empty (e.g. the prompt isn't painted yet) the renderer falls back to "Open Claude".
  if (isPermission || !(opts && opts.length)) {
    const scraped = readPermissionOptions()
    if (scraped && scraped.length) opts = scraped
  }
  // Highlight the tool + command/target in Claude orange so it's clear what's being asked
  // (no-op for plain questions with no tool/command).
  const acc = permissionAccents(hook, q)
  if (acc.length) out.accent = acc
  if (opts && opts.length) out.options = opts
  // AskUserQuestion can bundle 1-4 questions into ONE tool call -- and PreToolUse fires only
  // once for the whole call (there's no per-sub-question hook). Capture the FULL list so the
  // widget can walk it as a local queue; question/options above stay as the first item for
  // back-compat (the clobber guards + permission path all read them).
  const all = extractAllQuestions(hook)
  if (all && all.length) out.questions = all
}
if (state === 'working' || state === 'complex') {
  const status = statusFor(hook)
  if (status) out.status = status
}
writeStateFile(out)

// Debug: dump the raw payload so option shapes can be inspected. Safe to delete.
try { fs.writeFileSync(path.join(DIR, 'last-hook.json'), JSON.stringify({ state, hook }, null, 2)) } catch (e) {}

recordSession()

// ---------- helpers ----------
// Launch the INSTALLED desktop widget (Clawd.exe) when a CLI session starts, if it's
// installed and not already running. Start-only: never focuses, types, or kills. If the
// widget is already up its single-instance lock makes a redundant launch a harmless no-op,
// but we still guard on the process name to avoid spawning needless processes.
function ensureWidgetRunning () {
  if (process.platform !== 'win32') return
  try {
    // Skip if ANY widget is already up -- installed Clawd.exe OR a dev `electron .`. The widget
    // writes its pid to widget.pid on startup; check it's alive. This avoids launching the
    // installed build on top of a running dev widget, which used to bounce off the shared
    // single-instance lock and reload/blank the widget.
    try {
      const wpid = parseInt(fs.readFileSync(path.join(DIR, 'widget.pid'), 'utf8').trim(), 10)
      if (Number.isFinite(wpid) && wpid > 0) { process.kill(wpid, 0); return } // alive -> nothing to do
    } catch (e) { /* no/stale pid file, or process not alive -> fall through and launch */ }
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'clawd-widget', 'Clawd.exe')
    if (!fs.existsSync(exe)) return // not installed -> nothing to launch
    const { spawn } = require('child_process')
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
  } catch (e) { /* best-effort; a failed launch never blocks the session */ }
}

// The stable identity fields for this session's state file.
function identity (prev) {
  return { sid, cwd, title }
}
// The resolved focus cache (pid/hwnd/consolePids) carried forward from the previous write so
// it isn't lost when only the state changes. main.js reads these to route a click (focus /
// digit injection) to THIS specific session's terminal.
function focusCache (prev) {
  const out = {}
  if (prev && Number.isFinite(prev.pid) && prev.pid > 0) out.pid = prev.pid
  if (prev && Number.isFinite(prev.hwnd)) out.hwnd = prev.hwnd
  if (prev && Array.isArray(prev.consolePids) && prev.consolePids.length) out.consolePids = prev.consolePids
  return out
}

// Resolve THIS session's terminal window + console-client pids (via resolve-session.ps1, which
// walks the hook process's own ancestry) and store them IN this session's state file, so main.js
// can route a click to the correct terminal even when several sessions are active.
function recordSession () {
  if (process.platform !== 'win32') return
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch (e) {}
  // Permission prompts should not force a re-resolve (keeps the prompt snappy); resolve on
  // question/done, on SessionStart (a fresh session whose stale cache we just dropped), or
  // whenever we lack a cached pid / console-client pids for this session.
  let need = !isPermission && (state === 'question' || state === 'done' || sessionStart)
  if (!need) need = !(Number.isFinite(cache.pid) && cache.pid > 0) || !(Array.isArray(cache.consolePids) && cache.consolePids.length)
  if (!need) return
  try {
    const rp = path.join(__dirname, 'resolve-session.ps1')
    const o = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + rp + '"',
      { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const [pidStr, hwnd, cpids] = o.split(/\s+/)
    const pid = parseInt(pidStr, 10)
    const consolePids = (cpids || '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0)
    if (Number.isFinite(pid) && pid > 0) {
      const merged = { ...cache, pid, hwnd: hwnd ? Number(hwnd) : 0, consolePids }
      writeStateFile(merged)
    }
  } catch (e) { /* resolve failed; focus is CLI-only and will simply do nothing (never the desktop app) */ }
}

function labelsOf (arr) {
  return arr.map((o) => (typeof o === 'string' ? o : (o && (o.label || o.title || o.text)))).filter(Boolean)
}
// Substrings to render in Claude orange in the bubble: the tool name and the command/
// target. Sliced identically to extractQuestion so the substring exists in the question.
function permissionAccents (h, q) {
  const ti = h.tool_input || h.toolInput || {}
  let tool = h.tool_name || h.toolName
  if (!tool && typeof q === 'string') {
    const m = q.match(/\bAllow\s+([A-Za-z]+)/) || q.match(/\buse\s+([A-Za-z]+)/)
    if (m) tool = m[1]
  }
  const hintRaw = ti.command || ti.file_path || ti.path || ti.url || ti.pattern
  const hint = hintRaw ? String(hintRaw).replace(/\s+/g, ' ').slice(0, 70) : null
  const acc = []
  if (tool) acc.push(String(tool))
  if (hint) acc.push(hint)
  return acc
}
// Read the live permission options from THIS session's terminal via read-options.ps1 (UI
// Automation over Windows Terminal/conhost). Returns the labels positioned by their number (so
// the renderer's idx+1 equals the CLI's option number), or null if unavailable.
function readPermissionOptions () {
  if (process.platform !== 'win32') return null
  try {
    const rp = path.join(__dirname, 'read-options.ps1')
    const o = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + rp + '"',
      { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const opts = []
    o.split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^(\d+)\t(.+)$/)
      if (m) opts[parseInt(m[1], 10) - 1] = m[2].trim()
    })
    if (opts.length && opts.every((x) => typeof x === 'string' && x.length)) return opts
  } catch (e) { /* scrape failed; renderer falls back to Open Claude */ }
  return null
}
function extractQuestion (h) {
  const ti = h.tool_input || h.toolInput
  if (ti && Array.isArray(ti.questions) && ti.questions[0]) return ti.questions[0].question
  if (h.message) return h.message
  // Tool-permission prompt (PermissionRequest payload has no message): build a short
  // "Allow <tool>: <hint>?" so the bubble shows what's awaiting approval.
  const tool = h.tool_name || h.toolName
  if (tool) {
    const t2 = ti || {}
    const hint = t2.command || t2.file_path || t2.path || t2.url || t2.pattern
    return 'Allow ' + tool + (hint ? ': ' + String(hint).replace(/\s+/g, ' ').slice(0, 70) : '') + '?'
  }
  return (h.elicitation && h.elicitation.message) || (h.params && h.params.question) || h.notification || null
}
// Every question in an AskUserQuestion payload, as [{ question, options }, ...]. Returns
// null for anything without a questions array (permission prompts, bare Notifications) so
// the single-question path is untouched.
function extractAllQuestions (h) {
  const ti = h.tool_input || h.toolInput || {}
  if (!Array.isArray(ti.questions) || !ti.questions.length) return null
  const out = []
  for (const q of ti.questions) {
    if (!q || typeof q.question !== 'string') continue
    out.push({ question: q.question, options: Array.isArray(q.options) ? labelsOf(q.options) : [] })
  }
  return out.length ? out : null
}
function extractOptions (h) {
  const ti = h.tool_input || h.toolInput || {}
  if (Array.isArray(ti.questions) && ti.questions[0] && Array.isArray(ti.questions[0].options)) return labelsOf(ti.questions[0].options)
  if (Array.isArray(ti.options)) return labelsOf(ti.options)
  if (Array.isArray(h.options)) return labelsOf(h.options)
  if (Array.isArray(h.choices)) return labelsOf(h.choices)
  if (h.elicitation && Array.isArray(h.elicitation.options)) return labelsOf(h.elicitation.options)
  return null
}
function statusFor (h) {
  const name = h.tool_name || h.toolName
  if (!name) return null
  const map = {
    Read: 'Reading files…', Glob: 'Searching files…', Grep: 'Searching code…',
    Edit: 'Editing files…', Write: 'Writing files…', Bash: 'Running commands…',
    WebSearch: 'Searching the web…', WebFetch: 'Reading the web…',
    Task: 'Coordinating subagents…', TaskCreate: 'Planning the work…'
  }
  return map[name] || 'Working…'
}
