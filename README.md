# Clawd widget

An always-on-top, draggable desktop pet that mirrors what Claude Code is doing. Each
state is a pixel-art Clawd sprite (frame-accurate SVG + CSS — no GIFs at runtime). It
watches per-session state files that Claude Code lifecycle **hooks** write, so it
reflects your real session(s), not a simulation.

Windows is fully supported. macOS is scaffolded (see **Cross-platform**) but not yet
tested.

## States

| State | Sprite | Bubble | Click |
|---|---|---|---|
| **Default / idle** | `clawd-bubble` | "What can I take off your plate?" | Focus the active Claude terminal |
| **Working** | `ClawdMascot` | "Thinking…" (live per-tool status) | Focus the active Claude terminal |
| **Working (complex)** | `clawd-working` | "Working on a complex response" | Focus the active Claude terminal |
| **Question / permission** | `clawd-think` | The question + real answer buttons | Click an option → injects it into the right session |
| **Done** | `clawd-idea` | "Task completed!" | Focus the active Claude terminal |

The widget floats above other apps and virtual desktops and is draggable — grab Clawd
and move it. The transparent area is click-through; only Clawd and its bubble capture
the mouse.

**Tray / right-click menu:** Start at login · Active sessions (each with a status
emoji: ❓ question · 🔄 working · 🧠 complex · ✅ done · 💤 idle — click to focus that
session) · Close widget.

## Quick preview (no install)

Open `renderer/preview.html` in any browser to see the look & behaviour (state switch
bar + hover). No Electron required.

## Build & install

Needs Node.js + internet for the build step only.

**Windows installer (recommended):**
```bash
npm install
npm run dist
```
Produces `dist/Clawd Setup.exe` (a copy is surfaced at the repo root). The name is fixed
(no version), so each build overwrites the same file. Run it → it installs per-user (no
admin), adds a **Clawd** shortcut to the Start menu + desktop, and launches. Use the tray
menu → **Start at login** to run on boot.

- **Dev run:** `npm start` (or double-click `scripts/Launch Clawd.vbs` / `scripts/Launch Clawd.cmd`).
- **Restart the dev widget after editing `main.js`/`preload.js`/`renderer/`:** `npm run restart`.

**macOS (build on a Mac only):**
```bash
npm install
npm run dist:mac
```
Produces `Clawd-1.0.3-<arch>.dmg` (+ `.zip`, + `mac*/Clawd.app`) in `dist/`. The build is
**unsigned** (`identity: null`), so first launch: right-click → Open, or
`xattr -dr com.apple.quarantine dist/mac-arm64/Clawd.app`.

## Driving it from Claude (hooks)

Install the lifecycle hooks (safe merge, backs up existing settings):
```bash
node hooks/install-hooks.js          # install
node hooks/install-hooks.js --remove # uninstall
```
Then start a new Claude Code session. Event → state mapping:

| Hook event | → state |
|---|---|
| `SessionStart` | default |
| `UserPromptSubmit` | working (resets the turn) |
| `PreToolUse` (any tool) | working (per-tool status line) |
| `PreToolUse` (`Task`) / `SubagentStart` | complex |
| `PreToolUse` (`AskUserQuestion`) | question (real question + options) |
| `PermissionRequest` / `Notification` | question (permission prompt) |
| `PostToolUse` | clears the answered question back to working |
| `Stop` | done |

## How state & sessions work

- Each session's hooks write `~/.clawd-widget/sessions/<key>.json`, **keyed by the project
  (cwd)** — every hook payload carries `cwd`, so all events for a project land in one file
  (keying by `session_id` split a session across files, since some events omit it). Writes
  are atomic (temp + rename) so the widget never reads a half-written file.
- `main.js` watches that folder and shows the **newest pending question**; otherwise the
  most-recently-active session; otherwise idle. So one session's question is never hidden
  behind another's status, and concurrent sessions don't clobber each other.
- **Answering (Windows):** permission options are read from the terminal via UI Automation
  (`hooks/read-options.ps1`) and shown as buttons. Clicking one injects the matching digit
  into that session's console (`scripts/send-choice.ps1`, via `AttachConsole` +
  `WriteConsoleInput`) — no window is focused or stolen. A multi-question `AskUserQuestion`
  auto-submits with Enter after the last answer.

## Cross-platform

- **Windows:** full functionality (detect/list/focus sessions, option scraping, digit/Enter
  injection) via PowerShell in `scripts/*.ps1` and `hooks/*.ps1`.
- **macOS:** scaffolded in `scripts/mac/*.sh` (detect/list/focus/launch via `ps`/`lsof`/
  `osascript`). Answering **degrades to focusing the terminal** (no focus-free console
  injection equivalent yet; keystroke injection via the Accessibility API is future work).
  Untested — build/verify on a Mac.

## Limitations

- **No public "Claude state" API** — the hooks are the supported signal; missing events fall
  back to the stable ones.
- **Answer injection is Windows-only** (real); macOS focuses the terminal instead.
- **Focus is best-effort** — tweak `focusClaude()` in `main.js` (or `scripts/mac/focus-session.sh`)
  if your terminal/app differs.
- The macOS build is unsigned and untested.

## Files

```
clawd-widget/
├─ main.js                 Electron main: floating window, session aggregation/routing, tray
├─ preload.js              Secure IPC bridge to the renderer
├─ renderer/
│  ├─ index.html           The widget
│  ├─ renderer.js          State → sprite, bubbles, drag/click, mouse pass-through
│  ├─ styles.css / sprites.css / sprites.json   Layout + sprite animations/SVGs
│  └─ preview.html         Browser preview (no Electron)
├─ hooks/
│  ├─ set-state.js         Writes per-session state (called by Claude Code hooks)
│  ├─ install-hooks.js     Safe merge into ~/.claude/settings.json
│  ├─ resolve-session.ps1  Resolves a session's terminal window + console pids (Windows)
│  └─ read-options.ps1     Scrapes live permission options via UI Automation (Windows)
├─ scripts/
│  ├─ detect-claude.ps1 / list-sessions.ps1     Detect/enumerate sessions (Windows)
│  ├─ focus-session.ps1 / send-choice.ps1       Focus / inject choice (Windows)
│  ├─ launch-claude.ps1 / restart.js            Launch Claude / restart the widget
│  └─ mac/*.sh            macOS equivalents (detect/list/focus/launch)
├─ assets/                Icons
└─ Clawd Setup.exe        NSIS installer, surfaced at root after `npm run dist` (gitignored)
```

Sprite sizes: edit the `h` values in `STATES` in `renderer/renderer.js`.
```
