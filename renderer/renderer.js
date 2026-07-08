'use strict'

const STATES = {
  default:  { key: 'bubble',  h: 82, text: "What can I take off your plate?", mode: 'static' },
  working:  { key: 'mascot',  h: 82, text: "Thinking...",                     mode: 'status' },
  complex:  { key: 'working', h: 82, text: "Working on a complex response",   mode: 'status' },
  done:     { key: 'idea',    h: 82, text: "Task completed!",                   mode: 'static' },
  question: { key: 'think',   h: 82, text: "I've got a question for you",      mode: 'question' },
  launch:   { key: 'think',   h: 82, text: "Would you like to start a new CLI session?",   mode: 'launch' },
  // Transient informational bubble (e.g. after launching Claude Desktop). Text comes from
  // state.message; no options, auto-hides. mode 'notice' keeps state pushes from clobbering it.
  notice:   { key: 'idea',    h: 82, text: '',                                  mode: 'notice' },
  // Claude hit a runtime error (e.g. a 401 auth error). The specific message is carried on
  // state.status (set by set-state.js); mode 'status' surfaces it, else the fallback text.
  error:    { key: 'error',   h: 82, text: "Something went wrong",              mode: 'status' }
}
// Launch-bubble option. CLI-only by design: the widget tracks state via Claude Code lifecycle
// hooks, which Claude Desktop doesn't expose, so launching Desktop would leave the widget blind.
// The prompt still ASKS before launching (it never auto-starts). Starts a program only -- never
// focuses/kills, and there's no session to forward to.
const LAUNCH_OPTS = [
  { label: 'Launch Claude Code CLI', target: 'cli' },
  // DISPOSABLE TESTING FEATURE: launches the experimental Claude Desktop build. Desktop
  // exposes no lifecycle hooks, so the widget stays blind to its state after launch --
  // this is a start-only convenience for probe testing, not a supported tracked session.
  { label: 'Launch Claude Desktop (test)', target: 'desktop' }
]
// Step 2 of the launch flow: after choosing the CLI, ask WHERE to start it. "Home folder"
// launches in the user's home dir (no picker); "Pick a project…" opens the native folder picker.
const LAUNCH_FOLDER_OPTS = [
  { label: 'Home folder', act: 'home' },
  { label: 'Pick a project\u2026', act: 'pick' }
]
// Launch step 2: shown before launching Claude Desktop, to set expectations. Desktop exposes no
// lifecycle hooks, so the widget can only DISPLAY its status (from a UIA scrape) -- it can't answer
// prompts, forward option-clicks, or focus-to-answer the way it can for the CLI. Steer users to the
// CLI for the full experience, but let them proceed (and opt out of this warning) if they want.
const DESK_WARN_TEXT = "With Claude Desktop, I can only display status with no actions \u2014 answering prompts, granting permissions etc. Try the Claude Code CLI if you wish to try the full experience."
// Static labels used only to size the bubble wide enough (the checkbox row adds a box glyph prefix).
const DESK_WARN_OPT_LABELS = ['Launch Claude Desktop anyway', 'Launch Claude Code CLI', 'Do not show this again']

const root = document.getElementById('root')
const els = {
  hot: document.getElementById('hot'),
  sprite: document.getElementById('sprite'),
  bubble: document.getElementById('bubble'),
  bubbleText: document.getElementById('bubbleText'),
  options: document.getElementById('options'),
  tail: document.querySelector('.bubble-tail')
}
const isElectron = !!(window.clawd && window.clawd.isElectron)

let SPRITES = {}
let current = null
let curKey = null
let display = null
let anchorX = null
let anchorY = null
let cw = 0, ch = 0
let bubbleVisible = false
let typer = null
let dragging = false
let hovering = false
let autoShow = false
let autoTimer = null
// A transient notice (e.g. after launching Claude Desktop) shows for a few seconds and must not
// be clobbered by the ~1s state poll; onState is ignored while noticeUntil is in the future.
let noticeUntil = 0
let noticeTimer = null
// Gate for the question bubble: set true when a question arrives (so it auto-surfaces in the
// question pose) and cleared once the user answers, so an answered question won't re-appear
// on hover before the state officially clears back to working.
let questionRevealed = false
// AskUserQuestion may carry several sub-questions in one payload (state.questions[]). Only
// the first fires a hook, so the widget walks the rest itself: qIndex is the sub-question
// currently shown. Reset to 0 whenever a new question state arrives.
let qIndex = 0
// Which step of the launch bubble is showing: 0 = pick a Claude (CLI/Desktop); 1 = pick where to
// start the CLI (Home / Pick a project); 2 = the Claude Desktop limited-feature confirmation.
// Reset to 0 each time the launch prompt is (re)surfaced.
let launchStep = 0
// Persisted UI preferences from main (delivered in the env payload). { suppressDesktopWarn: bool }.
let prefs = {}
// Local toggle for the Desktop-warning step's "don't show again" affordance; when set and the user
// proceeds, it's persisted via setPref. Reset whenever the launch prompt is (re)surfaced.
let launchDeskDontShow = false

// ---------- boot ----------
SPRITES = window.SPRITES || {}
if (!Object.keys(SPRITES).length) { console.error('sprites missing') }
setSprite(STATES.default)

// ---------- sprite ----------
function setSprite (cfg) {
  if (cfg.key !== curKey) { els.sprite.innerHTML = SPRITES[cfg.key] || ''; curKey = cfg.key }
  const svg = els.sprite.querySelector('svg')
  if (svg) { svg.style.height = cfg.h + 'px'; svg.removeAttribute('width'); svg.removeAttribute('height') }
}
function measureSprite () {
  const svg = els.sprite.querySelector('svg')
  if (!svg) return
  const r = svg.getBoundingClientRect()
  cw = r.width || (svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 60)
  ch = r.height || 60
}

// ---------- geometry ----------
function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function clampAnchor () {
  if (!display) return
  anchorX = clamp(anchorX, display.x + cw / 2, display.x + display.width - cw / 2)
  anchorY = clamp(anchorY, display.y + ch, display.y + display.height)
}

function applyLayout (L) {
  if (!isElectron) {
    root.style.left = L.win.x + 'px'; root.style.top = L.win.y + 'px'
    root.style.width = L.win.w + 'px'; root.style.height = L.win.h + 'px'
  } else {
    root.style.left = ''; root.style.top = ''; root.style.width = ''; root.style.height = ''
  }
  els.hot.style.left = L.hot.left + 'px'
  els.hot.style.top = L.hot.top + 'px'
  if (L.show) {
    els.bubble.style.left = L.bubble.left + 'px'
    // Pin the bottom edge (top:auto) so the bubble's height:auto growth expands
    // upward while its bottom stays put on the sprite's bottom line.
    els.bubble.style.top = 'auto'
    els.bubble.style.bottom = L.bubble.bottom + 'px'
    els.bubble.classList.remove('left', 'right')
    els.bubble.classList.add(L.side)
  }
  if (bubbleVisible) els.bubble.classList.remove('hidden')
  else els.bubble.classList.add('hidden')
}

let pendingL = null
let pendingTimer = null
function scheduleApply (L) {
  clearTimeout(pendingTimer)
  pendingL = null
  if (!isElectron || dragging || (L.win.w === window.innerWidth && L.win.h === window.innerHeight)) { applyLayout(L); return }
  pendingL = L
  pendingTimer = setTimeout(() => { if (pendingL) { const x = pendingL; pendingL = null; applyLayout(x) } }, 140)
}
window.addEventListener('resize', () => { if (pendingL) { const x = pendingL; pendingL = null; applyLayout(x) } })

const PAD = 16
function layout (show, bw, bh) {
  if (!display || anchorX == null) return
  const clawdLeft = anchorX - cw / 2
  const clawdTop = anchorY - ch
  let side = 'right', bleft = 0, btop = 0
  let cx1 = clawdLeft, cy1 = clawdTop, cx2 = clawdLeft + cw, cy2 = clawdTop + ch
  if (show) {
    const gap = 12
    const roomRight = (display.x + display.width) - (clawdLeft + cw)
    side = roomRight >= bw + gap ? 'right' : 'left'
    bleft = side === 'right' ? (clawdLeft + cw + gap) : (clawdLeft - gap - bw)
    bleft = clamp(bleft, display.x + 4, display.x + display.width - bw - 4)
    // Bottom-anchored: pin the bubble's bottom edge to the sprite's bottom line so it
    // grows UPWARD as more text streams in (rather than centering on the sprite).
    const clawdBottom = clawdTop + ch
    btop = clamp(clawdBottom - bh, display.y + 4, display.y + display.height - bh - 4)
    cx1 = Math.min(clawdLeft, bleft); cy1 = Math.min(clawdTop, btop)
    cx2 = Math.max(clawdLeft + cw, bleft + bw); cy2 = Math.max(clawdTop + ch, btop + bh)
  }
  const wx1 = Math.max(display.x, cx1 - PAD)
  const wy1 = Math.max(display.y, cy1 - PAD)
  const wx2 = Math.min(display.x + display.width, cx2 + PAD)
  const wy2 = Math.min(display.y + display.height, cy2 + PAD)
  const win = { x: Math.floor(wx1), y: Math.floor(wy1), w: Math.ceil(wx2 - wx1), h: Math.ceil(wy2 - wy1) }
  const bTopInWin = btop - win.y
  const L = { win, show, side, hot: { left: clawdLeft - win.x, top: clawdTop - win.y }, bubble: { left: bleft - win.x, top: bTopInWin, bottom: win.h - (bTopInWin + bh) } }
  window.clawd.setBounds(win)
  scheduleApply(L)
}

// ---------- bubble content ----------
function clearTyper () { if (typer) { clearInterval(typer); typer = null } }
function streamText (text, keepCaret) {
  clearTyper()
  els.bubbleText.classList.add('caret')
  els.bubbleText.textContent = ''
  let i = 0
  typer = setInterval(() => {
    els.bubbleText.textContent = text.slice(0, ++i)
    if (i >= text.length) { clearInterval(typer); typer = null; if (!keepCaret) els.bubbleText.classList.remove('caret') }
  }, 20)
}
function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// Escape the text, then wrap the first occurrence of each accent substring in an orange
// span (longest first so a command containing the tool name still highlights cleanly).
function highlight (text, accents) {
  let html = escapeHtml(text)
  if (Array.isArray(accents)) {
    const needles = accents.filter(Boolean).slice().sort((a, b) => b.length - a.length)
    for (const a of needles) {
      const e = escapeHtml(a)
      const i = html.indexOf(e)
      if (i >= 0) html = html.slice(0, i) + '<span class="accent">' + e + '</span>' + html.slice(i + e.length)
    }
  }
  return html
}
function buildOptions (q, opts) {
  els.options.innerHTML = ''
  opts.forEach((label, idx) => {
    const b = document.createElement('button')
    // "Other"/"Open Claude" bring Claude forward (focus only). A real option records the
    // choice AND forwards its number to the CLI so it's selected there without re-picking --
    // WITHOUT switching windows: send-choice.ps1 injects the digit into the session's console
    // via AttachConsole+WriteConsoleInput (no foreground steal, can't land in another window).
    // The number is the option's 1-based position, matching the CLI's numbered list. Never
    // sends Enter — so it can never run a command.
    const passive = /^(other|open claude)$/i.test(label)
    // "Yes"/affirmative options stay Claude-orange (primary); a "No"/deny option uses the
    // same cream "other" style to set it apart. Deny is still ACTIVE (forwards its digit).
    const deny = /^(no|cancel|deny)\b/i.test(label)
    b.className = 'opt' + ((passive || deny) ? ' other' : '')
    b.textContent = label
    b.addEventListener('mousedown', (e) => e.stopPropagation())
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      // "Open Claude" focuses the active session AND, when no CLI session is running
      // (e.g. the terminal was closed while this bubble lingered), surfaces the launch
      // bubble -- same detect path as the sprite click. Fall back to plain focus in the
      // preview harness where idleClick isn't exposed.
      const sid = current && current.sid
      if (passive) {
        // "Open Claude"/"Other": focus Claude and dismiss back to the idle pose.
        if (window.clawd.idleClick) window.clawd.idleClick(sid); else window.clawd.focusClaude(sid)
        questionRevealed = false; setSprite(STATES.default); measureSprite(); clampAnchor()
        hovering = false; autoShow = false; clearTimeout(autoTimer); hideBubble()
        return
      }
      window.clawd.answer({ question: q, choice: label, options: opts, sid })
      window.clawd.sendChoice(idx + 1, sid)
      // More sub-questions queued in this same AskUserQuestion? No further hook fires for them,
      // so advance locally: bump the index and re-render the next one in place. The CLI advances
      // its own prompt in lockstep as each digit is forwarded.
      if (current && current.state === 'question' && qIndex < questionCount(current) - 1) {
        qIndex++
        renderBubble(current)
        return
      }
      // Last sub-question answered. A MULTI-question AskUserQuestion needs a final submit (Enter)
      // after the last selection; a single question / permission submits on the digit alone, so
      // only send Enter when there was more than one question.
      if (current && current.state === 'question' && questionCount(current) > 1 && window.clawd.submitAnswer) {
        window.clawd.submitAnswer(sid)
      }
      // Answering RESUMES Claude, so show the WORKING pose immediately -- NOT the idle "bubble"
      // sprite. Setting default here made the widget flash idle for a beat before the hooks
      // pushed the working state. The real working/complex/done state arrives shortly and takes
      // over from this placeholder pose.
      questionRevealed = false; setSprite(STATES.working); measureSprite(); clampAnchor()
      hovering = false; autoShow = false; clearTimeout(autoTimer); hideBubble()
    })
    els.options.appendChild(b)
  })
  els.options.classList.add('show')
}
// Options for the "launch a Claude" bubble. Clicking one STARTS that Claude (via main's
// launch-claude IPC) -- it never focuses/types/kills, and there's no session to forward to.
// Two steps: step 0 chooses the CLI; step 1 chooses where to start it (home / picked folder).
function buildLaunchOptions () {
  els.options.innerHTML = ''
  // Once a Claude is actually started, stop treating the widget as "no Claude running":
  // reset to default so the hover poller doesn't re-surface the launch prompt.
  const dismissLaunchBubble = () => {
    launchStep = 0
    current = { state: 'default' }; setSprite(STATES.default); measureSprite(); clampAnchor()
    hovering = false; autoShow = false; clearTimeout(autoTimer); hideBubble()
  }
  // Actually start Claude Desktop, then dismiss the launch flow (the desktop probe drives the
  // sprite from there). Shared by the suppressed-fast-path and the confirm.
  const proceedDesktop = () => {
    if (window.clawd.launchClaude) window.clawd.launchClaude('desktop')
    dismissLaunchBubble()
  }
  // Step 2: the Claude Desktop limited-feature confirmation. Three controls: proceed, redirect to
  // the (recommended) CLI flow, and a "don't show again" toggle that persists the preference.
  if (launchStep === 2) {
    const mk = (label, cls, onClick) => {
      const b = document.createElement('button')
      b.className = 'opt' + (cls ? ' ' + cls : '')
      b.textContent = label
      b.addEventListener('mousedown', (e) => e.stopPropagation())
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
      els.options.appendChild(b)
    }
    mk('Launch Claude Desktop anyway', '', () => {
      if (launchDeskDontShow && window.clawd.setPref) { window.clawd.setPref('suppressDesktopWarn', true); prefs.suppressDesktopWarn = true }
      proceedDesktop()
    })
    // The recommended path: jump straight to the CLI's "where to start" step.
    mk('Launch Claude Code CLI', 'other', () => { launchStep = 1; renderBubble(current) })
    // "Do not show this again" is a CHECKBOX affordance, not a button -- flips the local flag and
    // re-renders so the tick toggles; never launches or dismisses on its own.
    const chk = document.createElement('div')
    chk.className = 'opt-check' + (launchDeskDontShow ? ' checked' : '')
    chk.innerHTML = '<span class="box">' + (launchDeskDontShow ? '\u2713' : '') + '</span><span>Do not show this again</span>'
    chk.addEventListener('mousedown', (e) => e.stopPropagation())
    chk.addEventListener('click', (e) => { e.stopPropagation(); launchDeskDontShow = !launchDeskDontShow; renderBubble(current) })
    els.options.appendChild(chk)
    els.options.classList.add('show')
    return
  }
  const opts = launchStep === 0 ? LAUNCH_OPTS : LAUNCH_FOLDER_OPTS
  opts.forEach((it) => {
    const b = document.createElement('button')
    b.className = 'opt'
    b.textContent = it.label
    b.addEventListener('mousedown', (e) => e.stopPropagation())
    b.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (launchStep === 0) {
        // Chose Claude Desktop: Desktop has no folder step. Show the limited-feature confirmation
        // first (step 2) UNLESS the user previously ticked "don't show again", in which case launch
        // straight away. The widget can only DISPLAY Desktop's state (see DESK_WARN_TEXT).
        if (it.target === 'desktop') {
          if (prefs && prefs.suppressDesktopWarn) { proceedDesktop() }
          else { launchStep = 2; renderBubble(current) }
          return
        }
        // Chose the CLI: advance to the folder question in place (no launch yet).
        launchStep = 1
        renderBubble(current)
        return
      }
      // Step 1: WHERE to start the CLI.
      if (it.act === 'home') {
        // Launch directly in the user's home folder (no picker), then dismiss.
        if (window.clawd.launchCliHome) window.clawd.launchCliHome()
        else if (window.clawd.launchClaude) window.clawd.launchClaude('cli')
        dismissLaunchBubble()
      } else {
        // Pick a project: native folder picker in main. Only dismiss if a folder was actually
        // chosen -- cancelling leaves the folder question up so another choice can be made.
        if (window.clawd.pickFolderAndLaunchCli) {
          const res = await window.clawd.pickFolderAndLaunchCli()
          if (res && res.launched) dismissLaunchBubble()
        } else {
          if (window.clawd.launchClaude) window.clawd.launchClaude('cli')
          dismissLaunchBubble()
        }
      }
    })
    els.options.appendChild(b)
  })
  els.options.classList.add('show')
}
let _mctx = null
function measureCtx () {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d')
  // Must match .bubble-text in styles.css (16px / line-height 1.25 = 20px). Measuring at
  // 14px under-sized the box, so real 16px text wrapped earlier than the box's true width.
  _mctx.font = '400 16px Consolas, "Cascadia Mono", "Courier New", monospace'
  return _mctx
}
const PADX = 16, PADY = 12, LH = 20, OPT_H = 38, OPT_GAP = 7
function measureBubble (text, opts) {
  const ctx = measureCtx()
  const maxContent = Math.min(368, (display ? display.width : 800) - 80)
  const words = String(text).split(' ')
  const lines = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (!cur || ctx.measureText(t).width <= maxContent) cur = t
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  let longest = 0
  for (const ln of lines) longest = Math.max(longest, ctx.measureText(ln).width)
  // Reserve room for the widest option button so a short question/launch prompt with long
  // option labels stays wide enough (height assumes one line per option, so a wrapped label
  // would clip). Options render at 13px with 12px side padding.
  if (opts && opts.length) {
    ctx.font = '500 13px Consolas, "Cascadia Mono", "Courier New", monospace'
    for (const o of opts) longest = Math.max(longest, ctx.measureText(String(o)).width + 24)
  }
  const contentW = Math.max(110, Math.min(maxContent, Math.ceil(longest)))
  let h = lines.length * LH
  if (opts && opts.length) h += 10 + opts.length * (OPT_H + OPT_GAP)
  return { bw: Math.ceil(contentW) + PADX * 2, bh: Math.ceil(h) + PADY * 2 }
}
// Number of sub-questions in this state (1 for a single/permission question).
function questionCount (state) {
  return (state && Array.isArray(state.questions) && state.questions.length) ? state.questions.length : 1
}
// The sub-question to show at index i: prefers the queue (state.questions[]), falls back to
// the flat question/options/accent (permission prompts, older payloads).
function questionAt (state, i) {
  const arr = (state && Array.isArray(state.questions) && state.questions.length) ? state.questions : null
  if (arr) {
    const it = arr[Math.min(i, arr.length - 1)] || {}
    return { text: it.question, options: it.options, accent: it.accent }
  }
  return { text: state.question, options: state.options, accent: state.accent }
}
function renderBubble (state) {
  const cfg = STATES[state.state] || STATES.default
  els.options.classList.remove('show'); els.options.innerHTML = ''
  const isQ = cfg.mode === 'question'
  const isLaunch = cfg.mode === 'launch'
  const isNotice = cfg.mode === 'notice'
  const qv = isQ ? questionAt(state, qIndex) : null
  const qcount = isQ ? questionCount(state) : 1
  // The question text used for buttons/records (no counter suffix).
  const launchText = isLaunch ? (launchStep === 2 ? DESK_WARN_TEXT : (launchStep === 1 ? 'Where should Claude start?' : cfg.text)) : cfg.text
  const baseText = isNotice ? (state.message || cfg.text) : (isLaunch ? launchText : (isQ ? ((qv && qv.text) || cfg.text) : ((cfg.mode === 'status' && state.status) ? state.status : cfg.text)))
  // Show "(2/3)" when several sub-questions are queued so it's clear more follow.
  const text = (isQ && qcount > 1) ? (baseText + '  (' + (qIndex + 1) + '/' + qcount + ')') : baseText
  const qOpts = (qv && Array.isArray(qv.options) && qv.options.length) ? qv.options : ['Open Claude']
  const optsForMeasure = isLaunch
    ? (launchStep === 2 ? DESK_WARN_OPT_LABELS : (launchStep === 1 ? LAUNCH_FOLDER_OPTS : LAUNCH_OPTS).map((o) => o.label))
    : (isQ ? qOpts : null)
  const maxContent = Math.min(368, (display ? display.width : 800) - 80)
  const m = measureBubble(text, optsForMeasure)
  els.bubble.style.width = m.bw + 'px'
  els.bubble.style.height = 'auto'
  els.bubbleText.classList.remove('caret')
  // Questions/permission prompts render statically with the tool + command highlighted in
  // orange (highlight() needs HTML, which the char-by-char typer can't stream). The launch
  // prompt is also static (two action buttons). Other states keep the typewriter effect.
  if (isQ) {
    els.bubbleText.innerHTML = highlight(text, (qv && qv.accent) || state.accent)
    buildOptions(baseText, qOpts)
  } else if (isLaunch) {
    els.bubbleText.textContent = text
    buildLaunchOptions()
  } else if (isNotice) {
    // Static, wrapped informational text; no options, no typewriter caret.
    els.bubbleText.textContent = text
  } else {
    // Plain streamed text (status/default/done). The canvas estimate + CSS min-width can be a
    // pixel or two short and force an unexpected wrap ("Running / commands…"). Measure the TRUE
    // single-line width from the DOM (at nowrap), then size the box to it, capped at the max
    // container width -- so the text uses the full available width before it ever wraps.
    els.bubbleText.textContent = text
    els.bubble.style.width = maxContent + 'px'
    // Shrink the text node to its content before measuring: as a BLOCK element it fills the
    // bubble, so scrollWidth would report the container width for short (non-overflowing) text
    // and the box could never shrink below max. inline-block + nowrap sizes it to the real
    // one-line text width instead.
    els.bubbleText.style.whiteSpace = 'nowrap'
    els.bubbleText.style.display = 'inline-block'
    const natural = els.bubbleText.scrollWidth
    els.bubbleText.style.display = ''
    els.bubbleText.style.whiteSpace = ''
    // Reserve room for the blinking caret: it's an inline ::after (~6px incl. margin) that
    // would wrap onto a new line if the box hugged the text exactly. CARET keeps it inline.
    const CARET = 8
    els.bubble.style.width = (Math.min(maxContent, natural + CARET) + PADX * 2) + 'px'
  }
  // Size the host window from the ACTUAL rendered box, not the estimate. The estimate can
  // miss the real 16px font / 20px line-height, the 1px border and wrapped option labels, so
  // the true box may be larger than the estimate and overflow:hidden clips its corners.
  // getBoundingClientRect reports full size even while the bubble is hidden (opacity/transform
  // don't change box metrics).
  const r = els.bubble.getBoundingClientRect()
  const bw = Math.max((isQ || isLaunch || isNotice) ? m.bw : 0, Math.ceil(r.width))
  const bh = Math.ceil(r.height)
  els.bubble.style.width = bw + 'px'
  layout(true, bw, bh)
  // Keep the caret after typing for every streamed state (default/working/complex/done);
  // questions, the launch prompt and notices render caret-free (static text / options).
  if (!isQ && !isLaunch && !isNotice) streamText(text, true)
}

function showBubble () {
  if (bubbleVisible || !current) return
  bubbleVisible = true
  if (isElectron) window.clawd.setBubbleVisible(true)
  renderBubble(current)
}
// Surface the "no Claude running -- launch one?" prompt. Triggered by main on startup
// (and on an idle sprite click) when neither the desktop app nor a CLI session is found.
// Persists like a question until the user picks an option (or it's replaced by a real
// state once a session starts).
function showLaunch () {
  current = { state: 'launch' }
  launchStep = 0
  launchDeskDontShow = false
  setSprite(STATES.launch)
  measureSprite()
  clampAnchor()
  autoShow = true
  clearTimeout(autoTimer)
  if (bubbleVisible) renderBubble(current)
  reconcile()
}
// Show a transient informational bubble for `ms` (default 9s), immune to the state poll while
// it's up (see the onState gate). Used after launching Claude Desktop from the widget.
function showNotice (msg, ms) {
  ms = ms || 9000
  current = { state: 'notice', message: msg }
  setSprite(STATES.notice)
  measureSprite()
  clampAnchor()
  questionRevealed = false
  hovering = false
  autoShow = true
  noticeUntil = Date.now() + ms
  clearTimeout(autoTimer)
  if (!bubbleVisible) { bubbleVisible = true; if (isElectron) window.clawd.setBubbleVisible(true) }
  renderBubble(current)
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeUntil = 0
    autoShow = false
    current = { state: 'default' }
    setSprite(STATES.default); measureSprite(); clampAnchor()
    hideBubble()
    reconcile()
  }, ms)
}
let shrinkTimer = null
function hideBubble () {
  if (!bubbleVisible) return
  bubbleVisible = false
  if (isElectron) window.clawd.setBubbleVisible(false)
  els.bubble.classList.add('hidden')
  clearTyper()
  clearTimeout(shrinkTimer)
  shrinkTimer = setTimeout(() => { if (!bubbleVisible && !dragging) layout(false) }, 150)
}
function reconcile () {
  if (dragging) return
  // Hover (and the ~2s auto-show) can surface the bubble in ANY state. A pending question ALSO
  // stays up on its own via questionRevealed (set true when it arrives, cleared once answered), so
  // it doesn't need the cursor. Previously question state made `want` depend ONLY on questionRevealed,
  // so hovering the widget while a (possibly stale) question was showing did nothing -- hover was
  // effectively dead. OR-ing hover back in fixes that without losing the question's auto-persist.
  const isQ = current && current.state === 'question'
  const want = hovering || autoShow || (isQ && questionRevealed)
  if (want) { if (!bubbleVisible) showBubble() }
  else if (bubbleVisible) hideBubble()
}

// ---------- drag (click on Clawd body switches to Claude) ----------
function rect (el) { return el.getBoundingClientRect() }
function inside (x, y, r, pad) { pad = pad || 0; return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad }
let didDrag = false
els.hot.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  didDrag = false
  if (isElectron) window.clawd.dragState(true)
  els.sprite.classList.add('pressed')
  bubbleVisible = false
  if (isElectron) window.clawd.setBubbleVisible(false)
  els.bubble.classList.add('hidden')
  clearTyper()
  layout(false)
  const sx = e.screenX, sy = e.screenY
  const onMove = (ev) => {
    if (!didDrag && Math.hypot(ev.screenX - sx, ev.screenY - sy) > 4) { didDrag = true; els.sprite.classList.remove('pressed') }
    anchorX += ev.movementX; anchorY += ev.movementY
    clampAnchor(); layout(false)
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    dragging = false
    els.sprite.classList.remove('pressed')
    if (isElectron) window.clawd.dragState(false)
    if (didDrag) { if (isElectron) window.clawd.savePosition({ x: anchorX, y: anchorY }) }
    // A clean click switches to the active Claude; main also checks whether any Claude is
    // running and, if none is, shows the "launch one?" bubble. Fall back to plain focus when
    // idleClick isn't available (e.g. the preview harness).
    else if (window.clawd.idleClick) { window.clawd.idleClick(current && current.sid) }
    else { window.clawd.focusClaude(current && current.sid) }
    reconcile()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

els.hot.addEventListener('contextmenu', (e) => { e.preventDefault(); window.clawd.showMenu() })

// ---------- hover source ----------
if (isElectron) {
  window.clawd.onHover((over) => { hovering = over; reconcile() })
  if (window.clawd.onLaunchPrompt) window.clawd.onLaunchPrompt(() => showLaunch())
} else {
  window.addEventListener('mousemove', (e) => {
    if (dragging) return
    const overHot = inside(e.clientX, e.clientY, rect(els.hot), 4)
    const overWin = bubbleVisible && inside(e.clientX, e.clientY, rect(root), 2)
    hovering = overHot || overWin
    reconcile()
  })
  document.addEventListener('mouseleave', () => { hovering = false; reconcile() })
}

// ---------- feeds ----------
window.clawd.onEnv((env) => {
  display = env.display
  if (env.prefs && typeof env.prefs === 'object') prefs = env.prefs
  measureSprite()
  if (anchorX == null) {
    if (env.pos && typeof env.pos.x === 'number' && typeof env.pos.y === 'number') { anchorX = env.pos.x; anchorY = env.pos.y }
    else { anchorX = display.x + 70; anchorY = display.y + display.height - 14 }   // first launch: bottom-left
  }
  clampAnchor()
  if (bubbleVisible) renderBubble(current); else layout(false)
})

window.clawd.onState((state) => {
  // While a transient notice is showing, ignore state pushes (incl. the ~1s idle poll) so the
  // notice isn't clobbered before the user can read it.
  if (noticeUntil && Date.now() < noticeUntil) return
  current = state
  const isQ = state.state === 'question'
  // A pending question auto-surfaces: clawd switches to its question pose and the bubble opens
  // on its own. questionRevealed guards re-showing after an answer (cleared in buildOptions).
  questionRevealed = isQ
  // A fresh question payload restarts the sub-question queue at the first one.
  if (isQ) qIndex = 0
  setSprite(STATES[state.state] || STATES.default)
  measureSprite()
  clampAnchor()
  if (bubbleVisible) renderBubble(state)
  // A question stays up (persistent, driven by questionRevealed in reconcile) until answered.
  // Other non-default states auto-show for ~2s; default shows only on hover.
  if (isQ) { autoShow = false; clearTimeout(autoTimer) }
  // An error is important and easy to miss -- keep it up longer than the usual 2s auto-show.
  else if (state.state === 'error') { autoShow = true; clearTimeout(autoTimer); autoTimer = setTimeout(() => { autoShow = false; reconcile() }, 8000) }
  else if (state.state !== 'default') { autoShow = true; clearTimeout(autoTimer); autoTimer = setTimeout(() => { autoShow = false; reconcile() }, 2000) }
  else { autoShow = false; clearTimeout(autoTimer) }
  reconcile()
})
