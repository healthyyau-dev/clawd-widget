# Launches a Claude when none is running, at the user's choice from the widget bubble.
#   launch-claude.ps1 cli      -> open a fresh terminal running `claude` (Claude Code CLI)
#   launch-claude.ps1 desktop  -> start the Claude desktop app
# This only STARTS a program; it never focuses-by-stealing, types, or kills anything.
# Writes a line to launch.log each run so launches can be diagnosed.
param([string]$Target = 'cli', [string]$WorkDir = '')
$ErrorActionPreference = 'SilentlyContinue'
# A valid, existing folder to start the CLI terminal in. Blank/missing -> use the terminal's
# own default directory (previous behaviour). Only honoured for the CLI target.
$startDir = ''
if ($WorkDir -and (Test-Path -LiteralPath $WorkDir -PathType Container)) { $startDir = $WorkDir }
$dir = "$env:USERPROFILE\.clawd-widget"
$log = Join-Path $dir 'launch.log'
function Log ($m) { try { Add-Content -Path $log -Value ((Get-Date -Format o) + '  ' + $m) } catch {} }

if ($Target -eq 'desktop') {
  # Find the Claude desktop executable in the usual per-user install location, then start
  # it. The Anthropic installer puts Claude.exe under %LOCALAPPDATA%\AnthropicClaude
  # (often in an app-<version> subfolder), so search there. Fall back to the claude://
  # protocol handler and let Windows resolve the app if the exe isn't found.
  $exe = $null
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'AnthropicClaude'),
    (Join-Path $env:LOCALAPPDATA 'Programs\claude'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Claude')
  )
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $hit = Get-ChildItem -Path $r -Filter 'Claude.exe' -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
      if ($hit) { $exe = $hit; break }
    }
  }
  if ($exe) { Start-Process -FilePath $exe; Log "launched desktop: $exe" }
  else { Start-Process 'claude://'; Log 'launched desktop via claude:// protocol (exe not found)' }
} else {
  # CLI: open a brand-new terminal window running `claude`. Prefer Windows Terminal;
  # fall back to a classic console. `cmd /k` keeps the window open after claude exits.
  #
  # The widget process may itself be running inside a Claude Code session, so its env
  # carries CLAUDECODE (and the SSE-port vars). Those are inherited all the way down to
  # the launched `claude`, which then aborts with "cannot be launched inside another
  # Claude Code session". Strip them here BEFORE Start-Process so the new terminal gets
  # a clean, non-nested environment (Start-Process inherits the current process env).
  foreach ($v in 'CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SSE_PORT') {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
  }
  $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($wt) {
    # Windows Terminal takes the starting folder via `new-tab -d <dir>` (before the commandline).
    #
    # Invoke wt.exe with the call operator `&` and pass each token as a separate argument.
    # PowerShell 5.1 automatically wraps any native-command argument that contains a space
    # (e.g. the title "Claude Code" or a start dir with spaces) in quotes that survive into
    # wt.exe. Both Start-Process forms fail here: the array form drops the quotes and the
    # single-string form has its quotes stripped, so wt reads `--title Claude`, then treats
    # `Code` as the command -> "command not found: Code".
    if ($startDir) {
      & wt.exe new-tab --title 'Claude Code' -d $startDir cmd /k claude
      Log "launched cli via Windows Terminal in $startDir"
    } else {
      & wt.exe new-tab --title 'Claude Code' cmd /k claude
      Log 'launched cli via Windows Terminal'
    }
  } else {
    # Classic console: Start-Process sets the new window's working directory via -WorkingDirectory.
    if ($startDir) {
      Start-Process 'cmd.exe' -ArgumentList @('/k', 'claude') -WorkingDirectory $startDir
      Log "launched cli via cmd in $startDir"
    } else {
      Start-Process 'cmd.exe' -ArgumentList @('/k', 'claude')
      Log 'launched cli via cmd'
    }
  }
}
