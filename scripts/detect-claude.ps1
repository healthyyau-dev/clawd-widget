# Detects whether a Claude is currently running, for the widget's "launch Claude" prompt.
# READ-ONLY: enumerates processes only -- never starts, focuses, or kills anything.
# Prints a single line: "desktop=<0|1> cli=<0|1>".
#   desktop : the Claude desktop app (Claude.exe) has a live process.
#   cli     : a Claude Code CLI session is running (node.exe whose command line
#             references the claude CLI; the widget's own electron is excluded).
$ErrorActionPreference = 'SilentlyContinue'

$desktop = 0
if (Get-Process -Name 'Claude' -ErrorAction SilentlyContinue) { $desktop = 1 }

$cli = 0
# The Windows Claude Code CLI runs as node.exe executing the claude package
# (e.g. ...\@anthropic-ai\claude-code\cli.js or the ...\node_modules\.bin\claude shim).
# Match the Claude Code ENTRY POINT specifically -- NOT any command line that merely
# contains the substring 'claude'. A bare '*claude*' match falsely counts unrelated node
# processes whose path happens to include "claude", e.g. a Vite dev server living under a
# folder named "...\Work\Claude\..." -- that kept cli=1 forever, so closing the real CLI
# terminal never surfaced the launch prompt. Still exclude this widget (clawd-widget).
$nodes = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $nodes) {
  $cl = ('' + $p.CommandLine).ToLower()
  $isCli = ($cl -like '*claude-code*') -or ($cl -like '*\.bin\claude*') -or ($cl -like '*\claude\cli.js*')
  if ($isCli -and $cl -notlike '*clawd-widget*') { $cli = 1; break }
}

"desktop=$desktop cli=$cli"
