#!/bin/sh
# macOS equivalent of scripts/focus-session.ps1 (raise-only).
# Brings the terminal app hosting the Claude Code CLI session to the front. It never types,
# minimizes, closes, or kills anything -- it only ACTIVATES a terminal application.
# Optional $1 = a specific CLI pid (from the tray "Active sessions" click); with none it uses
# the first running Claude Code CLI session.
#
# NOTE: macOS cannot raise a specific TAB/window without Accessibility scripting that varies per
# terminal; this v1 activates the hosting terminal APP (Terminal/iTerm2/WezTerm/Warp/...). Good
# enough for a single session; per-tab targeting is a future enhancement.

target="$1"

claude_pid="$target"
if [ -z "$claude_pid" ]; then
  claude_pid=$(ps -Axo pid=,command= 2>/dev/null \
    | grep -Ei 'claude-code|@anthropic-ai/claude-code|/claude/cli\.js' \
    | grep -vi 'clawd-widget' | grep -vi 'electron' | grep -v 'grep' \
    | awk '{print $1}' | head -1)
fi

# Walk up the process tree from the CLI process to find the hosting terminal application.
app=""
pid="$claude_pid"
i=0
while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$i" -lt 30 ]; do
  name=$(ps -o comm= -p "$pid" 2>/dev/null | sed 's#.*/##')
  case "$name" in
    Terminal)              app="Terminal"; break;;
    iTerm2|iTerm)          app="iTerm2"; break;;
    wezterm-gui|WezTerm)   app="WezTerm"; break;;
    Warp|stable)           app="Warp"; break;;
    alacritty|Alacritty)   app="Alacritty"; break;;
    Hyper)                 app="Hyper"; break;;
    kitty)                 app="kitty"; break;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  i=$((i + 1))
done

if [ -n "$app" ]; then
  osascript -e "tell application \"$app\" to activate" >/dev/null 2>&1
else
  # Fallback: raise the most common terminals if the host couldn't be resolved.
  osascript -e 'tell application "Terminal" to activate' >/dev/null 2>&1 \
    || osascript -e 'tell application "iTerm2" to activate' >/dev/null 2>&1
fi
