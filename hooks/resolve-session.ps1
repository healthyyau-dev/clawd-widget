# Resolves the visible terminal window hosting the active Claude session and
# prints "<pid> <hwnd>". A descendant of the Claude CLI, it:
#   1. Walks up the process tree to the first ancestor that OWNS a visible
#      top-level window (via EnumWindows -- Process.MainWindowHandle is 0 for
#      console windows). explorer.exe is skipped so we never grab the desktop.
#   2. If that window is a ConPTY pseudo-console (class "PseudoConsoleWindow" or
#      an empty title) -- which happens under Windows 11's "Default Terminal =
#      Windows Terminal" handoff -- the real UI lives in a SEPARATE
#      WindowsTerminal process. We then locate the Windows Terminal window
#      (class "CASCADIA_HOSTING_WINDOW_CLASS") whose title names the Claude
#      session, because cmd's own window is hidden and unreachable by tree.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // First visible top-level window owned by `target`, or IntPtr.Zero.
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
  // Visible Windows Terminal window (CASCADIA_HOSTING_WINDOW_CLASS) whose title
  // contains the given needle (case-insensitive), or IntPtr.Zero.
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

$byId = @{}; $byName = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $byId[[int]$_.ProcessId] = [int]$_.ParentProcessId
  $byName[[int]$_.ProcessId] = ('' + $_.Name).ToLower()
}

# 1. Nearest ancestor that owns a visible window (not explorer).
$hwnd = [IntPtr]::Zero
$cur = [int]$PID; $g = 0
while ($cur -gt 0 -and $byId.ContainsKey($cur) -and $g -lt 40) {
  if ($byName[$cur] -ne 'explorer.exe') {
    $h = [Win]::ForPid([uint32]$cur)
    if ($h -ne [IntPtr]::Zero) { $hwnd = $h; break }
  }
  $cur = $byId[$cur]; $g++
}

# 1b. Ancestry owned NO visible window at all. Under the Windows 11 DefTerm handoff the session's
#     console is a ConPTY hosted by a SEPARATE conhost/WindowsTerminal process OUTSIDE our process
#     tree (ancestry is just node -> cmd -> explorer), and the pseudo-console window is invisible,
#     so step 1 finds nothing. Fall back to the Windows Terminal window whose title names the Claude
#     session. Without this the whole resolve returned nothing (hwnd stayed Zero, guarded by the
#     'if hwnd' below), so the session file never got a pid/hwnd/consolePids and clicks -- focus and
#     digit injection -- could not be routed to this session.
if ($hwnd -eq [IntPtr]::Zero) {
  $wt = [Win]::TerminalByTitle('claude')
  if ($wt -ne [IntPtr]::Zero) { $hwnd = $wt }
}

# 2. If that window is a ConPTY pseudo-console (DefTerm handoff), the real UI is
#    a Windows Terminal window in another process -- find it by the session title.
if ($hwnd -ne [IntPtr]::Zero) {
  $cls = [Win]::ClassOf($hwnd)
  $title = [Win]::TitleOf($hwnd)
  if ($cls -eq 'PseudoConsoleWindow' -or [string]::IsNullOrWhiteSpace($title)) {
    $wt = [Win]::TerminalByTitle('claude')
    if ($wt -ne [IntPtr]::Zero) { $hwnd = $wt }
  }
}

if ($hwnd -ne [IntPtr]::Zero) {
  # Console-client PIDs to inject a numbered choice into WITHOUT focusing the window.
  # The hook does NOT share the CLI's console (GetConsoleProcessList would only see the
  # hook's own transient pids), but we ARE a descendant of the long-lived `claude` (node)
  # process, which IS a client of the session console. So walk our ancestry and collect the
  # console-app processes (node = claude, plus the shell), stopping at the terminal window
  # owner. send-choice.ps1 AttachConsole()s one of these and WriteConsoleInput()s the digit.
  $winOwner = [int][Win]::PidOf($hwnd)
  $consoleNames = @('node','cmd','powershell','pwsh','bash','sh','zsh','fish','wsl','ubuntu','wslhost','claude')
  $cpids = New-Object System.Collections.ArrayList
  $c = [int]$PID; $d = 0
  while ($c -gt 0 -and $byId.ContainsKey($c) -and $d -lt 40) {
    if ($c -eq $winOwner) { break }
    $nm = ($byName[$c]) -replace '\.exe$', ''
    if ($consoleNames -contains $nm) { [void]$cpids.Add($c) }
    $c = $byId[$c]; $d++
  }
  # "<window-owner pid> <hwnd> <ancestor console-client pids,csv>"
  Write-Output ('{0} {1} {2}' -f $winOwner, [int64]$hwnd, ($cpids -join ','))
}
