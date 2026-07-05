#!/bin/sh
# macOS equivalent of scripts/launch-claude.ps1.
# Launches a Claude when none is running. Start-only: never kills or types into a session.
#   $1 = 'desktop' -> start the Claude desktop app.
#   $1 = 'cli'     -> open a new Terminal (or iTerm2) window running `claude`.
#   $2 = optional folder for the CLI terminal to start in (blank -> terminal's default).

t="$1"
workdir="$2"

if [ "$t" = "desktop" ]; then
  open -a "Claude" >/dev/null 2>&1
else
  # The widget may itself run inside a Claude Code session; if so its env carries the
  # nested-session markers (CLAUDECODE + SSE-port vars) and a launched `claude` would abort
  # with "cannot be launched inside another Claude Code session". Terminal.app / iTerm2 run
  # `do script` in THEIR OWN process env (not this script's), so we can't just unset here --
  # the strip has to live inside the command string the terminal actually runs.
  cmd='env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT claude'
  # Start in the chosen folder when one was passed and it exists (cd runs inside the terminal's
  # own shell). Escape any embedded double-quotes so the AppleScript string stays well-formed.
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    esc=$(printf '%s' "$workdir" | sed 's/"/\\"/g')
    cmd="cd \"$esc\" && $cmd"
  fi
  # Prefer Terminal.app; fall back to iTerm2; last resort just open Terminal.
  osascript -e 'tell application "Terminal"' -e "do script \"$cmd\"" -e 'activate' -e 'end tell' >/dev/null 2>&1 \
    || osascript -e 'tell application "iTerm2"' \
                 -e 'set w to (create window with default profile)' \
                 -e "tell current session of w to write text \"$cmd\"" \
                 -e 'activate' \
                 -e 'end tell' >/dev/null 2>&1 \
    || open -a "Terminal" >/dev/null 2>&1
fi
