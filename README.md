# Clawd

A tiny desktop helper that sits on top of your screen and shows you what Claude is doing -
thinking, working, waiting for your answer, or finished. Grab it and drag it anywhere.

> Building from source or contributing? See **[DEV.md](DEV.md)**.

## Features

- **Live status at a glance** - Clawd changes pose for each state: idle, working, a complex
  task, a pending question, or a completed task.
- **Answer questions without switching windows** *(Claude Code on Windows)* - when Claude asks
  a permission or multiple-choice question, the buttons appear on Clawd. Click one and it's
  sent straight to the right session - no window steal, no digging for the terminal.
- **Handles multiple sessions** - running Claude in several projects? Clawd shows the one that
  needs you most (a pending question first), and the tray menu lists them all.
- **Always on top & out of the way** - floats above other apps and across virtual desktops.
  Everything except Clawd and its speech bubble is click-through.
- **Click to jump back** - click Clawd to bring the active Claude window to the front.
- **Tray menu** - start at login, see active sessions, or close the widget.

## Compatibility

| Platform | Status | Notes |
|---|---|---|
| **Windows 10 / 11** | ✅ Ready | Full support. Installer provided. |
| **macOS** | 🚧 Not ready | Code is scaffolded but untested, and **no installer is built yet.** |

On Windows, Clawd works with both:

- **Claude Code (CLI)** - full support, including answering questions/permissions right from the widget.
- **Claude Desktop app** - shows working / needs-input / finished. A "Task completed!" pose stays
  up after a task so you don't miss it, and clears once you look back at Desktop. (Desktop questions
  aren't answerable from the widget - clicking just brings the Desktop window forward.)

## Install (Windows)

1. Get **`Clawd Setup.exe`**.
2. Double-click it. It installs just for your user (no admin needed) and launches automatically,
   adding a **Clawd** shortcut to your Start menu and desktop.
3. *(Optional)* Right-click Clawd in the system tray → **Start at login** to have it run on boot.

To run on boot later, or to close it, use that same tray menu.

### Using it with Claude Code (CLI)

So Clawd can see your Claude Code sessions, install the hooks once:

```bash
node hooks/install-hooks.js
```

Then open a new Claude Code session - Clawd will start reflecting it. (The Claude Desktop app
needs no setup; Clawd detects it automatically.)

To remove the hooks: `node hooks/install-hooks.js --remove`.

## Using Clawd

- **Move it:** drag Clawd anywhere on screen.
- **Bring Claude forward:** click Clawd.
- **Answer a question:** when a question bubble appears, click the option you want.
- **Menu:** right-click Clawd (or its tray icon) for sessions and settings.

## macOS

Not ready yet. There is no macOS installer, and the macOS code has not been tested. Windows is
the supported platform for now. (Developers: build notes are in **[DEV.md](DEV.md)**.)

## Uninstall

Windows: **Settings → Apps → Installed apps → Clawd → Uninstall** (or use the Start-menu
uninstaller). To also stop the Claude Code integration, run `node hooks/install-hooks.js --remove`.
