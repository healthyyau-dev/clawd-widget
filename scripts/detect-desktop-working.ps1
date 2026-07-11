param(
  [switch]$Dump,   # Diagnostic: print the Desktop window's buttons + text so the signal can be calibrated.
  [switch]$Json    # Emit a JSON object instead of a bare token.
)

# ===========================================================================
# PROTOTYPE / EXPERIMENT -- NOT WIRED INTO THE WIDGET.
# Best-effort probe of the Claude DESKTOP app's working/idle state via UI
# Automation (the same technique hooks/read-options.ps1 uses on the terminal).
#
# Claude Desktop exposes NO hooks and no status file, so the only observable
# signal is its own window. While Desktop is generating a reply the composer
# shows a "Stop" affordance; when idle it shows the Send/submit affordance.
# We read the window's UIA tree and look for that button.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File detect-desktop-working.ps1
#     -> prints ONE token: working | idle | not-running | unknown
#   ... -Dump   -> prints the button/text inventory for calibration
#   ... -Json   -> prints { "state": "...", "reason": "...", "hwnd": N, "fg": bool }
#                  (fg = the Desktop window is the OS foreground window)
#
# Read-only: never focuses, types, clicks, or changes anything. Standalone --
# touches no widget file. Windows-only.
# ===========================================================================

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinDW {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# --- Locate the Claude Desktop main window ---------------------------------
# Discriminator: a VISIBLE window whose owning process is named 'claude' with the
# Electron window class 'Chrome_WidgetWin_1'. This excludes the Claude Code CLI
# (a 'CASCADIA_HOSTING_WINDOW_CLASS' WindowsTerminal window) and our own 'Clawd'
# widget (process 'electron'/'Clawd', never 'claude').
function Find-DesktopWindow {
  $claudePids = @{}
  Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $claudePids[[uint32]$_.Id] = $true }
  if ($claudePids.Count -eq 0) { return @{ hwnd = [IntPtr]::Zero; reason = 'no-claude-process' } }

  $matches = New-Object System.Collections.ArrayList
  $cb = [WinDW+Cb]{
    param($h, $l)
    if (-not [WinDW]::IsWindowVisible($h)) { return $true }
    [uint32]$p = 0; [void][WinDW]::GetWindowThreadProcessId($h, [ref]$p)
    if (-not $script:claudePids.ContainsKey($p)) { return $true }
    if ([WinDW]::ClassOf($h) -ne 'Chrome_WidgetWin_1') { return $true }
    $title = [WinDW]::TitleOf($h)
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    [void]$script:matches.Add(@{ hwnd = $h; title = $title; pid = $p })
    return $true
  }
  $script:claudePids = $claudePids
  $script:matches = $matches
  [void][WinDW]::EnumWindows($cb, [IntPtr]::Zero)

  if ($matches.Count -eq 0) { return @{ hwnd = [IntPtr]::Zero; reason = 'no-visible-window' } }
  # Prefer a window whose title contains 'Claude' (the main window); else take the first.
  foreach ($m in $matches) { if ($m.title -match '(?i)claude') { return @{ hwnd = $m.hwnd; reason = 'ok'; title = $m.title } } }
  return @{ hwnd = $matches[0].hwnd; reason = 'ok'; title = $matches[0].title }
}

# Collect every Button element (Name / AutomationId / enabled) in the window subtree.
# Electron populates its accessibility tree LAZILY once a UIA client attaches -- until
# then only the native titlebar (Minimize/Maximize/Close) is exposed. React content
# surfaces buttons with 'base-ui-*' automationIds, so we retry until at least one such
# id appears (the real UI has rendered) rather than stopping at the shallow titlebar.
function Get-Buttons([IntPtr]$hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $out = New-Object System.Collections.ArrayList
  for ($try = 0; $try -lt 10; $try++) {
    $out.Clear()
    $rendered = $false
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $cond)
    foreach ($e in $els) {
      $aid = $e.Current.AutomationId
      $nm = ('' + $e.Current.Name)
      # "Rendered" must mean the COMPOSER / conversation region is present -- NOT merely any
      # base-ui* button. The Cowork/Code sidebar carries persistent base-ui* buttons ("More
      # options for <chat>", etc.), so the old `$aid -like 'base-ui*'` test passed on a
      # sidebar-only tree while the composer pane had not yet rendered. Classify then saw no
      # stop/queue/composer -> returned 'unknown', and the widget (main.js: unknown => keep
      # current state) stayed stuck on 'working' after a backgrounded task finished. Key
      # "rendered" on an actual composer/turn affordance so we wait for the real chat UI.
      if ($nm -match '(?i)add files, connectors|press and hold to record|^send|stop\s*(response|generating|task)|queue message|^(always allow|allow once|allow|approve|accept|run|deny|reject|decline|skip)$') { $rendered = $true }
      [void]$out.Add([pscustomobject]@{
        Name    = $nm
        AutoId  = $aid
        Enabled = $e.Current.IsEnabled
      })
    }
    if ($rendered) { break }
    Start-Sleep -Milliseconds 250
  }
  return $out
}

# Largest TextPattern block in the window (the conversation transcript), same
# "pick the richest text element" trick as read-options.ps1.
function Get-WindowText([IntPtr]$hwnd) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $el) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $els = $el.FindAll([System.Windows.Automation.TreeScope]::Subtree, $cond)
  $best = $null; $bestLen = -1
  foreach ($e in $els) {
    $p = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -eq $p) { continue }
    $t = $p.DocumentRange.GetText(4000)
    if ($t -and $t.Length -gt $bestLen) { $best = $t; $bestLen = $t.Length }
  }
  return $best
}

# Heuristic (calibrated against live Desktop captures):
#   working -> the composer shows "Stop response" while generating (a disabled
#              "Queue message" button also appears only mid-generation).
#   idle    -> composer rendered but no stop button.
#   unknown -> the composer never rendered in the UIA tree (window minimized /
#              backgrounded so Electron exposed only the titlebar). We do NOT call
#              that 'idle' -- it could actually be working behind a hidden window.
# The composer anchors ('Add files, connectors, and more', 'Press and hold to
# record') are present whenever the chat UI is rendered, so their absence marks the
# shallow/unrendered tree.
function Classify($buttons) {
  $hasStop = $false; $hasQueue = $false; $hasComposer = $false; $stopName = ''
  $hasAllow = $false; $hasDeny = $false; $permName = ''
  $hasSkip = $false
  foreach ($b in $buttons) {
    $n = ('' + $b.Name); $a = ('' + $b.AutoId)
    # Live-generation signal = the composer's "Stop response" button (also "Stop generating"/
    # "Stop task"/a lone "Stop" in some modes). Do NOT match confirmation buttons that merely
    # contain the word "stop" -- e.g. "No, stop" / "Yes, stop and revert" are yes/no dialog
    # CHOICES, not a generating indicator. The old broad \bstop\b caught "No, stop" and left the
    # widget stuck on 'working' after a Cowork task ended (composer already back).
    if ($n -match '(?i)stop\s*(response|generating|task)' -or $n -match '(?i)^\s*stop\s*$') { $hasStop = $true; $stopName = $n }
    if ($n -match '(?i)queue message') { $hasQueue = $true }
    if ($n -match '(?i)add files, connectors' -or $n -match '(?i)press and hold to record' -or $n -match '(?i)^send') { $hasComposer = $true }
    # Permission / approval gate: the composer shows an allow/deny pair while a tool
    # awaits approval. "Stop response" is ALSO present then (the run is paused, not
    # done), so this MUST be checked before 'working' or a gate reads as working.
    if ($n -match '(?i)^(always allow|allow once|allow|approve|accept|run)$') { $hasAllow = $true; if (-not $permName) { $permName = $n } }
    if ($n -match '(?i)^(deny|reject|decline|cancel)$') { $hasDeny = $true }
    # AskUserQuestion prompt: the interactive question card renders a "Skip" button beside its
    # numbered option rows. The composer alongside it shows "Queue" (and sometimes "Stop"), so
    # this MUST be checked before 'working' or the pending question reads as generation.
    if ($n -match '(?i)^skip$') { $hasSkip = $true }
  }
  # Require BOTH an allow-ish and a deny-ish button (or an explicit "Always allow") so a
  # lone generic word can't false-trigger. Highest priority: a pending decision.
  if (($hasAllow -and $hasDeny) -or ($permName -match '(?i)always allow')) {
    return @{ state = 'question'; reason = "permission:'$permName'" }
  }
  # A pending AskUserQuestion also needs the user's attention -- surface it as a question, not
  # working, even though the composer's Queue/Stop buttons are present.
  if ($hasSkip) { return @{ state = 'question'; reason = 'ask-user-question-skip' } }
  if ($hasStop) { return @{ state = 'working'; reason = "stop:'$stopName'" } }
  if ($hasQueue) { return @{ state = 'working'; reason = 'queue-message-present' } }
  if ($hasComposer) { return @{ state = 'idle'; reason = 'composer-no-stop' } }
  return @{ state = 'unknown'; reason = "tree-not-rendered(buttons=$($buttons.Count))" }
}

# --- main ------------------------------------------------------------------
$win = Find-DesktopWindow
if ($win.hwnd -eq [IntPtr]::Zero) {
  if ($Json) { Write-Output ('{{"state":"not-running","reason":"{0}","hwnd":0,"fg":false}}' -f $win.reason) }
  else { Write-Output 'not-running' }
  return
}

# Is the Desktop window the OS foreground window? Used by the widget for "dismiss-on-focus": when the
# user brings a just-finished Desktop to the front, the completion pulse should end (they've seen it).
$fg = ([WinDW]::GetForegroundWindow() -eq $win.hwnd)

$buttons = Get-Buttons $win.hwnd

if ($Dump) {
  Write-Output ("window: hwnd={0} title='{1}'" -f [int64]$win.hwnd, $win.title)
  Write-Output ("buttons ({0}):" -f $buttons.Count)
  foreach ($b in $buttons) {
    Write-Output ("  [{0}] name='{1}' autoId='{2}'" -f ($(if ($b.Enabled) { 'on ' } else { 'off' })), $b.Name, $b.AutoId)
  }
  $txt = Get-WindowText $win.hwnd
  if ($txt) {
    $tail = if ($txt.Length -gt 600) { $txt.Substring($txt.Length - 600) } else { $txt }
    Write-Output '--- text tail (last 600 chars) ---'
    Write-Output $tail
  }
  return
}

$res = Classify $buttons
if ($Json) {
  Write-Output ('{{"state":"{0}","reason":"{1}","hwnd":{2},"fg":{3}}}' -f $res.state, ($res.reason -replace '"', "'"), [int64]$win.hwnd, $fg.ToString().ToLower())
} else {
  Write-Output $res.state
}
