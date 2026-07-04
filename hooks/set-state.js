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
const FILE = path.join(DIR, 'state.json')

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

// A tool-permission prompt ("Do you want to proceed?") -- detected from the 'perm' arg
// (PermissionRequest hook) OR from the payload itself, so the Notification path (current
// session) also gets permission treatment. We do NOT fabricate options (the hook doesn't
// reveal them); the bubble just shows the command + "Open Claude" to decide in the terminal.
const isPermission = perm ||
  hook.notification_type === 'permission_prompt' ||
  hook.hook_event_name === 'PermissionRequest'

fs.mkdirSync(DIR, { recursive: true })

// SessionStart: bring the widget up if it isn't already. Done first (and independent of
// the state write) so a fresh CLI session always gets its companion widget.
if (launchWidget) ensureWidgetRunning()

let cur = {}
try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch (e) {}

// PostToolUse: a tool just finished. If a question bubble is still showing (a permission
// that was approved, or an answered AskUserQuestion), clear it back to "working". Only
// touch a lingering question -- never disturb complex/done/working/default.
if (afterTool) {
  if (cur.state === 'question') {
    try { fs.writeFileSync(FILE, JSON.stringify({ state: 'working', ts: Date.now(), status: 'Working…' }, null, 2)) } catch (e) {}
  }
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

const out = { state, ts: Date.now() }
if (state === 'question') {
  const q = extractQuestion(hook)
  let opts = extractOptions(hook)
  if (q) out.question = q
  // AskUserQuestion carries its choices in the payload (opts above). A permission prompt
  // never does, and its choice count varies (2 vs 3) -- so when a question arrives WITHOUT
  // payload options, read the REAL numbered list straight from the terminal. The widget
  // then shows those exact options and forwards the matching number on click. If the scrape
  // comes up empty (e.g. the prompt isn't painted yet) the renderer falls back to "Open Claude".
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
fs.writeFileSync(FILE, JSON.stringify(out, null, 2))

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
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'clawd-widget', 'Clawd.exe')
    if (!fs.existsSync(exe)) return // not installed -> nothing to launch
    const n = execSync('powershell -NoProfile -Command "@(Get-Process -Name Clawd -ErrorAction SilentlyContinue).Count"',
      { timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (parseInt(n, 10) > 0) return // already running
    const { spawn } = require('child_process')
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
  } catch (e) { /* best-effort; a failed launch never blocks the session */ }
}

function recordSession () {
  if (process.platform !== 'win32') return
  const SESSION = path.join(DIR, 'session.json')
  // Permission prompts should not force a re-resolve (keeps the prompt snappy); only
  // resolve if we have no cached session pid yet.
  let need = !isPermission && (state === 'question' || state === 'done')
  if (!need) {
    // Resolve when we lack a cached pid OR lack console-client pids (needed to inject a
    // choice without focusing). Permission prompts otherwise reuse the cache to stay snappy.
    try {
      const s = JSON.parse(fs.readFileSync(SESSION, 'utf8'))
      need = !(Number.isFinite(s.pid) && s.pid > 0) || !(Array.isArray(s.consolePids) && s.consolePids.length)
    } catch (e) { need = true }
  }
  if (!need) return
  try {
    const rp = path.join(__dirname, 'resolve-session.ps1')
    const o = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + rp + '"',
      { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const [pidStr, hwnd, cpids] = o.split(/\s+/)
    const pid = parseInt(pidStr, 10)
    const consolePids = (cpids || '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0)
    if (Number.isFinite(pid) && pid > 0) {
      fs.writeFileSync(SESSION, JSON.stringify({ pid, hwnd: hwnd ? Number(hwnd) : 0, consolePids, ts: Date.now() }, null, 2))
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
// Read the live permission options from the terminal via read-options.ps1, which prints
// "<number>\t<label>" lines in CLI order. Returns the labels positioned by their number
// (so the renderer's idx+1 equals the CLI's option number), or null if unavailable.
function readPermissionOptions () {
  if (process.platform !== 'win32') return null
  try {
    const rp = path.join(__dirname, 'read-options.ps1')
    const o = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + rp + '"',
      { timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
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
