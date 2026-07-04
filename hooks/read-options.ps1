param([int64]$Hwnd = 0)

# Reads the LIVE permission-menu options from the terminal hosting the active Claude
# session and prints one option per line as "<number><TAB><label>" (in CLI order).
#
# Why scrape: Claude Code's hooks never include the permission choices (Yes / No /
# "don't ask again") -- the payload only has tool_name + tool_input. The choice list is
# interactive terminal UI, and its length VARIES (2 vs 3), so the widget must read the
# real list to show clickable options whose numbers match what the CLI expects.
#
# How: resolve the owning terminal window (same ancestor-walk as resolve-session.ps1,
# incl. the Windows 11 DefTerm ConPTY->WindowsTerminal handoff), then read the window
# text via UI Automation (the documented way to read Windows Terminal / conhost output)
# and parse the numbered lines after "Do you want to proceed?". A short retry loop covers
# the race where the hook fires a beat before the prompt is painted. Read-only: never
# types, focuses, or changes anything.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinRO {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static IntPtr ForPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr TerminalByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    string n = needle.ToLowerInvariant();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        if (t.ToString().ToLowerInvariant().Contains(n)) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Resolve-Hwnd {
  $byId = @{}; $byName = @{}
  Get-CimInstance Win32_Process | ForEach-Object {
    $byId[[int]$_.ProcessId] = [int]$_.ParentProcessId
    $byName[[int]$_.ProcessId] = ('' + $_.Name).ToLower()
  }
  $hwnd = [IntPtr]::Zero
  $cur = [int]$PID; $g = 0
  while ($cur -gt 0 -and $byId.ContainsKey($cur) -and $g -lt 40) {
    if ($byName[$cur] -ne 'explorer.exe') {
      $h = [WinRO]::ForPid([uint32]$cur)
      if ($h -ne [IntPtr]::Zero) { $hwnd = $h; break }
    }
    $cur = $byId[$cur]; $g++
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    $cls = [WinRO]::ClassOf($hwnd); $title = [WinRO]::TitleOf($hwnd)
    if ($cls -eq 'PseudoConsoleWindow' -or [string]::IsNullOrWhiteSpace($title)) {
      $wt = [WinRO]::TerminalByTitle('claude')
      if ($wt -ne [IntPtr]::Zero) { $hwnd = $wt }
    }
  }
  return $hwnd
}

function Read-WindowText([IntPtr]$hwnd) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $el) { return $null }
  # A Windows Terminal window has SEVERAL TextPattern elements (tab-title TextBlock, the
  # terminal content TermControl, ...). The first in tree order is the tiny tab title, so
  # pick the element with the MOST text -- that's the terminal buffer (TermControl / the
  # conhost console text). FindFirst would wrongly grab the 13-char tab title.
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $els = $el.FindAll([System.Windows.Automation.TreeScope]::Subtree, $cond)
  $best = $null; $bestLen = -1
  foreach ($e in $els) {
    $p = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -eq $p) { continue }
    $t = $p.DocumentRange.GetText(-1)
    if ($t -and $t.Length -gt $bestLen) { $best = $t; $bestLen = $t.Length }
  }
  return $best
}

function Parse-Options([string]$text) {
  $out = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrEmpty($text)) { return $out }
  $lines = $text -split "`r?`n"
  # Anchor on the prompt header. It is NOT always "Do you want to proceed?" -- Write says
  # "Do you want to create <file>?", Edit "Do you want to make this edit to <file>?", etc.
  # Match any "Do you want to ... ?" line (and keep 'proceed?' as a fallback). Scan from the
  # bottom so the most recent prompt wins over any earlier one in the scrollback.
  $idx = -1
  for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match 'Do you want to' -or $lines[$i] -match 'proceed\?') { $idx = $i; break } }
  if ($idx -lt 0) { return $out }
  for ($j = $idx + 1; $j -lt $lines.Count; $j++) {
    $ln = $lines[$j]
    if ($ln -match '(?:^|\s)(\d)\.\s+(\S.*?)\s*$') {
      [void]$out.Add(@([int]$matches[1], ($matches[2]).Trim()))
    } elseif ([string]::IsNullOrWhiteSpace($ln)) {
      if ($out.Count -gt 0) { break }
    } elseif ($ln -match 'Esc to cancel|Tab to') {
      break
    } elseif ($out.Count -gt 0) {
      # wrapped continuation of the previous option
      $out[$out.Count - 1][1] = (($out[$out.Count - 1][1]) + ' ' + $ln.Trim()).Trim()
    }
  }
  return $out
}

$h = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { Resolve-Hwnd }
if ($h -eq [IntPtr]::Zero) { return }

$opts = New-Object System.Collections.ArrayList
for ($try = 0; $try -lt 4; $try++) {
  $t = Read-WindowText $h
  $opts = Parse-Options $t
  if ($opts.Count -gt 0) { break }
  Start-Sleep -Milliseconds 150
}
foreach ($o in $opts) { Write-Output ("{0}`t{1}" -f $o[0], $o[1]) }
