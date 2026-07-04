# Clawd widget

An always-on-top, draggable desktop pet that mirrors what Claude is doing. Each
state is a pixel-art Clawd sprite (rebuilt from the source GIFs as frame-accurate
SVG + CSS — no GIFs are used at runtime).

## States

| State | Sprite | Hover bubble | Click |
|---|---|---|---|
| **Default / idle** | `clawd-bubble` | "What can I take off your plate?" | Switch to the Claude app (co-work chat) |
| **Pending question** | `clawd-think` | The question + answer options | Pick an option → records it & opens Claude · "Other" → opens Claude for free-form context |
| **Working (normal)** | `ClawdMascot` | "Thinking…" (live status, streams) | Switch to the Claude in-progress chat |
| **Working (complex)** | `clawd-working` | "Working on a complex response" | Switch to the Claude in-progress chat |
| **Done** | `clawd-idea` | "I'm done!" | Switch to the Claude in-progress chat |

## Quick preview (no install)

Open `renderer/preview.html` in any browser. Use the top bar to switch states and
hover Clawd (bottom-centre) to see the bubbles. This previews look & behaviour only.

## Install it like a real app (pin to Start / taskbar)

**Recommended — build the installer once, then pin.** Produces a normal Windows
installer; after running it, "Clawd" appears in the Start menu and on the desktop,
and you can right-click → **Pin to Start** / **Pin to taskbar**. No folder, no
terminal afterward. Build once (needs Node + internet just for this step):

```bash
npm install
npm run dist
```

This creates **`dist/Clawd Setup 1.0.0.exe`**. Run it → it installs per-user (no
admin), drops a **Clawd** shortcut on the desktop + Start menu, and launches. Pin
that shortcut wherever you like. To launch on every boot, use the tray menu →
**Start at login** (or it's a normal app you can add to Startup).

Updating later: `npm run dist` again and re-run the new Setup.

**Alternatives**
- Portable single file: `npm run dist:portable` → `dist/ClawdWidget.exe` (copy
  anywhere, double-click; you can pin this too).
- No build, just Node: double-click **`Launch Clawd.vbs`** (installs deps on first
  run, then launches silently).
- Developer run: `npm install` then `npm start` (or `npm run demo`).

The widget floats above other apps (including over the taskbar), sits on every
virtual desktop, and is draggable — grab Clawd and move it. Clicks on the
transparent area pass through to whatever is underneath; only Clawd and its
bubble capture the mouse.

**Controls** (tray icon menu, or hotkeys):
`Ctrl/Cmd+Alt+1..5` = Default / Working / Complex / Question / Done ·
`Ctrl/Cmd+Alt+0` = auto-loop.

## Driving it from Claude (real, hook-based)

The widget reads its state from `~/.clawd-widget/state.json`. Claude Code
lifecycle **hooks** write that file as Claude works — so the widget reflects the
real session, not a simulation.

Install the hooks (safe merge, backs up your existing settings):

```bash
node hooks/install-hooks.js          # install
node hooks/install-hooks.js --remove # uninstall
```

Then start a new Claude Code session. Mapping:

| Hook event | → state |
|---|---|
| `SessionStart` | default |
| `UserPromptSubmit` | working (resets the turn) |
| `PreToolUse` (any tool) | working (with a per-tool status line) |
| `PreToolUse` (`Task`) / `SubagentStart` | complex |
| `PreToolUse` (`AskUserQuestion`) | question (pulls the real question + options) |
| `Notification` | question |
| `Stop` | done |

A guard stops a stray tool event from downgrading a `complex` or `question` turn
back to plain `working`.

## Honest limitations

- **No public "Claude state" API.** The hooks above are the supported way to read
  the session; there's no event stream beyond them. If your Claude Code build
  lacks an event (e.g. a dedicated question hook), the snippet falls back to the
  stable events.
- **Answer send-back is a mock.** There's no supported way to inject an answer
  into a live Claude chat. Picking an option saves it to
  `~/.clawd-widget/answer.json` and brings the Claude app forward — it does not
  auto-submit. "Other" simply opens Claude.
- **"Switch to Claude" is best-effort.** It launches/focuses the Claude app per
  OS; tweak `focusClaude()` in `main.js` if your install path differs.

## Files

```
clawd-widget/
├─ main.js                 Electron main: floating window, watcher, tray, hotkeys
├─ preload.js              Secure bridge to the renderer
├─ renderer/
│  ├─ index.html           The widget
│  ├─ renderer.js          State → sprite, bubbles, drag/click, mouse pass-through
│  ├─ styles.css           Bubble & layout
│  ├─ sprites.css          Namespaced sprite animations (all 5 states)
│  ├─ sprites.json         The 5 inline SVG sprites
│  └─ preview.html         Browser preview (no Electron)
└─ hooks/
   ├─ set-state.js         Writes state.json (called by hooks)
   ├─ install-hooks.js     Safe merge into ~/.claude/settings.json
   └─ clawd-hooks.snippet.json   Manual copy/paste version
```

Sprite sizes are easy to tweak: edit the `h` values in `STATES` in
`renderer/renderer.js`.
