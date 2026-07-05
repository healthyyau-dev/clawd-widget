#!/bin/sh
# macOS equivalent of scripts/list-sessions.ps1.
# READ-ONLY: enumerates processes and reads each session's working directory -- never starts,
# focuses, or kills anything. Prints a JSON array of { pid, title }, one per running Claude Code
# CLI session, where title = the project FOLDER name (leaf of the process's working directory),
# falling back to "Claude session <pid>".

out=""

# PIDs of node processes running the Claude Code CLI entry point (exclude this widget/electron).
pids=$(ps -Axo pid=,command= 2>/dev/null \
  | grep -Ei 'claude-code|@anthropic-ai/claude-code|/\.bin/claude|/claude/cli\.js' \
  | grep -vi 'clawd-widget' | grep -vi 'electron' | grep -v 'grep' \
  | awk '{print $1}')

for pid in $pids; do
  # The process's current working directory (macOS: read via lsof's "cwd" descriptor).
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  if [ -n "$cwd" ]; then
    title=$(basename "$cwd")
  else
    title="Claude session $pid"
  fi
  # Minimal JSON escaping for the title (backslash and double-quote).
  esc=$(printf '%s' "$title" | sed 's/\\/\\\\/g; s/"/\\"/g')
  item="{\"pid\":$pid,\"title\":\"$esc\"}"
  if [ -z "$out" ]; then out="$item"; else out="$out,$item"; fi
done

printf '[%s]' "$out"
