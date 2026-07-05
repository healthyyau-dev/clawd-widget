#!/bin/sh
# macOS equivalent of scripts/detect-claude.ps1.
# READ-ONLY: enumerates processes only -- never starts, focuses, or kills anything.
# Prints a single line: "desktop=<0|1> cli=<0|1>".
#   desktop : the Claude desktop app (Claude.app) has a live process.
#   cli     : a Claude Code CLI session is running (node executing the claude package entry
#             point). Match the ENTRY POINT specifically -- not any 'claude' substring -- and
#             exclude this widget's own electron.

desktop=0
if pgrep -x Claude >/dev/null 2>&1; then desktop=1; fi

cli=0
if ps -Axo command 2>/dev/null \
  | grep -Ei 'claude-code|@anthropic-ai/claude-code|/\.bin/claude|/claude/cli\.js' \
  | grep -vi 'clawd-widget' | grep -vi 'electron' | grep -v 'grep' >/dev/null 2>&1; then
  cli=1
fi

echo "desktop=$desktop cli=$cli"
