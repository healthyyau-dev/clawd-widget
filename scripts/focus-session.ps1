# Brings the active Claude *Code CLI* session's terminal to the foreground.
# CLI-ONLY: this script must NEVER target, raise, or launch the Claude desktop
# app -- doing so caused the two to "clash" when both were running. It is also
# strictly raise-only: it only shows/activates an existing terminal window and
# never kills or terminates any process or window.
# Run by the widget's main process on click. Windows blocks a background process
# from calling SetForegroundWindow directly, so we use the AttachThreadInput
# trick to borrow the current foreground thread's input state.
# Writes a line to focus.log each run so the switch can be diagnosed.
#
# Optional first arg $SendKey: a single digit (1-9). When provided AND the resolved
# CLI window is successfully brought to the foreground, that digit is typed into it
# so a widget option-click can select the matching numbered choice in the Claude Code
# prompt. SAFETY: the digit is sent ONLY when our target window is actually the
# foreground window (never types into another window), and ONLY when an arg is passed
# -- sprite / "Open Claude" clicks pass NO arg, so they stay pure raise-only. No Enter
# is sent (number-only), so a stray digit can never submit a shell command.
# Optional -TargetPid focuses a SPECIFIC session by pid (tray "Active sessions" click),
# bypassing session.json. Still raise-only; no keystrokes are sent for pid-targeted focus.
param([string]$SendKey = '', [int]$TargetPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\.clawd-widget"
$log = Join-Path $dir 'focus.log'
function Log ($m) { try { Add-Content -Path $log -Value ((Get-Date -Format o) + '  ' + $m) } catch {} }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static string ClassOf(IntPtr h) { var s = new System.Text.StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new System.Text.StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  public static IntPtr RootOwner(IntPtr h) { return GetAncestor(h, 3); } // GA_ROOTOWNER
  // The (any-visibility) ConPTY PseudoConsoleWindow owned by `target`, or IntPtr.Zero. Its
  // RootOwner is the exact Windows Terminal window hosting that session -- the only reliable
  // node->window link when WT runs several windows in ONE process (same pid + same title).
  public static IntPtr PseudoForPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) {
        var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64);
        if (c.ToString() == "PseudoConsoleWindow") { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
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
  // First minimized (iconic) top-level window owned by `target`, or IntPtr.Zero.
  // Distinguishes a really-minimized terminal from WT's stale hidden ghost
  // windows (those are neither visible nor iconic); Force() will SW_RESTORE it.
  public static IntPtr IconicForPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsIconic(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // Visible Windows Terminal window (CASCADIA_HOSTING_WINDOW_CLASS) whose title
  // contains the needle (case-insensitive), or IntPtr.Zero. Re-resolves the live
  // session window when the stored hwnd has gone stale.
  public static IntPtr TerminalByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    string n = needle.ToLowerInvariant();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new System.Text.StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") {
        var t = new System.Text.StringBuilder(512); GetWindowText(h, t, 512);
        if (t.ToString().ToLowerInvariant().Contains(n)) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Force(IntPtr h) {
    bool wasIconic = IsIconic(h);
    // SW_RESTORE (9) un-minimizes AND activates.
    if (wasIconic) ShowWindow(h, 9);
    // Case 2: already the foreground window (and not minimized) -> nothing to bring forward.
    // Running the AttachThreadInput/SetForegroundWindow steal on an already-active Windows
    // Terminal is exactly what makes it transiently clear WS_VISIBLE, i.e. the "close and
    // reopen flash". So short-circuit: no steal, no ShowWindow churn, no flash.
    if (!wasIconic && GetForegroundWindow() == h) return "already-fg iconic=False sfw=True ok=True reshown=False";
    if (!wasIconic) ShowWindow(h, 5);   // SW_SHOW: reveal a hidden/ghost window at current state
    IntPtr fg = GetForegroundWindow();
    uint pidOut;
    uint fgT = GetWindowThreadProcessId(fg, out pidOut);
    uint myT = GetCurrentThreadId();
    bool attached = (fgT != myT) && AttachThreadInput(myT, fgT, true);
    BringWindowToTop(h);
    bool sfw = SetForegroundWindow(h);
    if (attached) AttachThreadInput(myT, fgT, false);
    // If the foreground lock still won that race, restoring again then retrying
    // SetForegroundWindow after the un-minimize has settled usually wins.
    if (GetForegroundWindow() != h) {
      if (IsIconic(h)) ShowWindow(h, 9);
      if (attached) AttachThreadInput(myT, fgT, true);
      BringWindowToTop(h);
      sfw = SetForegroundWindow(h);
      if (attached) AttachThreadInput(myT, fgT, false);
    }
    // conhost/terminal windows can get HIDDEN (WS_VISIBLE cleared, NOT minimized) tens of ms
    // AFTER a forced-foreground activation, leaving the CLI running with an unreachable
    // window. Re-assert visibility, but do it FAST: the old guard slept 80ms BEFORE its first
    // re-show and looped 640ms, so the window stayed blinked-out long enough to SEE (the
    // flash). Now we react before sleeping, on a 5ms cadence, and stop once it has stayed
    // visible for a few checks -- so any hidden gap is sub-perceptual. SHOW-ONLY: never
    // hides/minimizes/kills.
    bool reshown = false;
    int stable = 0;
    for (int i = 0; i < 40; i++) {
      if (!IsWindowVisible(h)) { ShowWindow(h, 5); reshown = true; stable = 0; }
      else if (++stable >= 3) break;
      System.Threading.Thread.Sleep(5);
    }
    bool ok = GetForegroundWindow() == h;
    return "iconic=" + wasIconic + " sfw=" + sfw + " ok=" + ok + " reshown=" + reshown;
  }
  // True only when h is currently THE foreground window -- gate for keystroke sending.
  public static bool IsFg(IntPtr h) { return GetForegroundWindow() == h; }
  // Type a single digit (1-9) into whatever is foreground, via the digit-row VK
  // (0x31..0x39). Caller MUST verify IsFg(target) first. down + up, no modifiers.
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  public static void Digit(int n) {
    if (n < 1 || n > 9) return;
    byte vk = (byte)(0x30 + n);
    keybd_event(vk, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(20);
    keybd_event(vk, 0, 2, IntPtr.Zero); // KEYEVENTF_KEYUP
  }
}
"@

function WinFromPid ($startPid) {
  if ($startPid -le 0) { return [IntPtr]::Zero }
  $byId = @{}; $byName = @{}
  Get-CimInstance Win32_Process | ForEach-Object {
    $byId[[int]$_.ProcessId] = [int]$_.ParentProcessId
    $byName[[int]$_.ProcessId] = ('' + $_.Name).ToLower()
  }
  $cur = [int]$startPid; $g = 0
  while ($cur -gt 0 -and $byId.ContainsKey($cur) -and $g -lt 40) {
    # Use a visible OWNED window (EnumWindows) rather than MainWindowHandle,
    # which is 0 for console windows; skip explorer.exe so we never grab the desktop.
    if ($byName[$cur] -ne 'explorer.exe') {
      $h = [Fg]::ForPid([uint32]$cur)
      if ($h -ne [IntPtr]::Zero) { return $h }
    }
    $cur = $byId[$cur]; $g++
  }
  return [IntPtr]::Zero
}

# Resolve the EXACT terminal window for a specific session pid (tray "Active sessions" click).
# Walks the process ancestry and, at each level:
#   - if that process owns a ConPTY PseudoConsoleWindow (Windows Terminal), returns the pseudo's
#     ROOT OWNER = the precise WT window hosting this session. This is the only link that works
#     when WT runs multiple SEPARATE windows in one process (identical pid + title otherwise).
#   - else if it owns an ordinary window (legacy conhost terminal), returns that (visible or
#     minimized). Skips explorer so we never grab the desktop.
function ResolveTargetWindow ($startPid) {
  if ($startPid -le 0) { return [IntPtr]::Zero }
  $byId = @{}; $byName = @{}
  Get-CimInstance Win32_Process | ForEach-Object {
    $byId[[int]$_.ProcessId] = [int]$_.ParentProcessId
    $byName[[int]$_.ProcessId] = ('' + $_.Name).ToLower()
  }
  $cur = [int]$startPid; $g = 0
  while ($cur -gt 0 -and $byId.ContainsKey($cur) -and $g -lt 40) {
    if ($byName[$cur] -ne 'explorer.exe') {
      $ps = [Fg]::PseudoForPid([uint32]$cur)
      if ($ps -ne [IntPtr]::Zero) {
        $ro = [Fg]::RootOwner($ps)
        if ($ro -ne [IntPtr]::Zero -and $ro -ne $ps) { return $ro }
      }
      $h = [Fg]::ForPid([uint32]$cur)
      if ($h -ne [IntPtr]::Zero) { return $h }
      $h = [Fg]::IconicForPid([uint32]$cur)
      if ($h -ne [IntPtr]::Zero) { return $h }
    }
    $cur = $byId[$cur]; $g++
  }
  return [IntPtr]::Zero
}

$target = [IntPtr]::Zero
if ($TargetPid -gt 0) {
  # Resolve THIS session's EXACT terminal window (see ResolveTargetWindow): via the ConPTY
  # PseudoConsoleWindow's root owner for Windows Terminal (distinguishes separate WT windows
  # that share a pid + title), or an ordinary owned window for legacy conhost. Force() then
  # SW_RESTOREs it if minimized. TerminalByTitle is only a last-resort fallback.
  $target = ResolveTargetWindow $TargetPid
  if ($target -eq [IntPtr]::Zero) { $target = [Fg]::TerminalByTitle('claude') }
  Log ("targetPid={0} -> target={1}" -f $TargetPid, $target)
} else {
$sf = Join-Path $dir 'session.json'
if (Test-Path $sf) {
  $s = Get-Content $sf -Raw | ConvertFrom-Json
  # Prefer the stored hwnd when it's still a real, visible window: resolve-session
  # records the actual console/terminal window. Re-walking by pid is the fallback.
  if ($s.hwnd) {
    $h = [IntPtr][int64]$s.hwnd
    if ([Fg]::IsWindow($h) -and [Fg]::IsWindowVisible($h)) { $target = $h }
  }
  # The stored hwnd often goes stale: Windows Terminal leaves hidden "Claude Code"
  # ghost windows behind, so re-resolve the LIVE window before giving up.
  # b) a visible window owned by the session pid (walk ancestors, skip explorer)
  if ($target -eq [IntPtr]::Zero) { $target = WinFromPid ([int]$s.pid) }
  # c) the currently visible Windows Terminal window whose title names the session
  if ($target -eq [IntPtr]::Zero) { $target = [Fg]::TerminalByTitle('claude') }
  # d) a minimized window owned by the session pid -- Force() will SW_RESTORE it,
  #    so a minimized terminal no longer mis-falls-back to the Claude desktop app
  if ($target -eq [IntPtr]::Zero -and $s.pid) { $target = [Fg]::IconicForPid([uint32]$s.pid) }
  Log ("session pid={0} hwnd={1} -> target={2}" -f $s.pid, $s.hwnd, $target)
} else {
  Log "no session.json"
}
}
# CLI-ONLY: intentionally NO Claude-desktop fallback and NO app launch. If no
# CLI terminal can be resolved, do nothing rather than grabbing/starting the
# desktop app (that fallback was what made the widget clash with desktop Claude).
if ($target -ne [IntPtr]::Zero) {
  $st = [Fg]::Force($target)
  Log "forced foreground hwnd=$target $st"
  # Option-click forwarding: type the chosen number INTO the session, but only if our
  # target actually became the foreground window (so the digit can never land in
  # another app). Number-only, no Enter. Sprite/"Open Claude" clicks pass no $SendKey.
  if ($SendKey -match '^[1-9]$') {
    if ([Fg]::IsFg($target)) {
      [Fg]::Digit([int]$SendKey)
      Log "sent choice key=$SendKey to hwnd=$target"
    } else {
      Log "choice key=$SendKey NOT sent (target not foreground; refusing to type into another window)"
    }
  }
} else {
  Log "no CLI terminal resolved; doing nothing (desktop app intentionally not targeted)"
  if ($SendKey -match '^[1-9]$') { Log "choice key=$SendKey NOT sent (no CLI terminal resolved)" }
}
