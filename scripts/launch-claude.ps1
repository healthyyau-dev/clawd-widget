# Launches a Claude when none is running, at the user's choice from the widget bubble.
#   launch-claude.ps1 cli      -> open a fresh terminal running `claude` (Claude Code CLI)
#   launch-claude.ps1 desktop  -> start the Claude desktop app
# This only STARTS a program; it never focuses-by-stealing, types, or kills anything.
# Writes a line to launch.log each run so launches can be diagnosed.
param([string]$Target = 'cli')
$ErrorActionPreference = 'SilentlyContinue'
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
  $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($wt) {
    Start-Process 'wt.exe' -ArgumentList 'new-tab --title "Claude Code" cmd /k claude'
    Log 'launched cli via Windows Terminal'
  } else {
    Start-Process 'cmd.exe' -ArgumentList @('/k', 'claude')
    Log 'launched cli via cmd'
  }
}
