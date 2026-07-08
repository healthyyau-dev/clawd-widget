# Raises a specific window to the foreground by HWND. RAISE-ONLY: it only shows/activates
# an existing window and never types, kills, or terminates anything.
#
# Used by the widget to bring the Claude DESKTOP window forward on a click, when the widget
# is currently reflecting Desktop's state (the probe, detect-desktop-working.ps1, hands us the
# window's hwnd). This is deliberately generic and hwnd-targeted so it stays separate from the
# CLI-only focus-session.ps1 (which must never target the desktop app).
#
# Windows blocks a background process from calling SetForegroundWindow directly, so we borrow
# the current foreground thread's input state via AttachThreadInput (same trick as focus-session).
param([long]$Hwnd = 0)
$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\.clawd-widget"
$log = Join-Path $dir 'focus.log'
function Log ($m) { try { Add-Content -Path $log -Value ((Get-Date -Format o) + '  ' + $m) } catch {} }

if ($Hwnd -le 0) { Log 'focus-window: no hwnd'; return }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FgW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  public static string Force(IntPtr h) {
    if (!IsWindow(h)) return "not-a-window";
    bool wasIconic = IsIconic(h);
    if (wasIconic) ShowWindow(h, 9);                 // SW_RESTORE: un-minimize AND activate
    if (!wasIconic && GetForegroundWindow() == h) return "already-fg";  // no steal -> no flash
    IntPtr fg = GetForegroundWindow();
    uint pidOut;
    uint fgT = GetWindowThreadProcessId(fg, out pidOut);
    uint myT = GetCurrentThreadId();
    bool attached = (fgT != myT) && AttachThreadInput(myT, fgT, true);
    BringWindowToTop(h);
    bool sfw = SetForegroundWindow(h);
    if (attached) AttachThreadInput(myT, fgT, false);
    bool ok = GetForegroundWindow() == h;
    return "iconic=" + wasIconic + " sfw=" + sfw + " ok=" + ok;
  }
}
"@

$h = [IntPtr][int64]$Hwnd
$st = [FgW]::Force($h)
Log ("focus-window hwnd={0} {1}" -f $Hwnd, $st)
