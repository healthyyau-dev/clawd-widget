# Inject a numbered choice (1-9) into the active Claude Code CLI session WITHOUT
# bringing its window to the foreground / switching windows.
#
# How: the session's console-client PIDs were captured at hook time (session.json
# .consolePids, from resolve-session.ps1's GetConsoleProcessList). We FreeConsole our
# own process, AttachConsole() one of those PIDs to borrow the session's console, then
# WriteConsoleInput() the digit as a key-down/up pair. Because WriteConsoleInput targets
# a specific console input buffer, the digit can ONLY land in that session -- it can never
# leak into another app's window the way a global keystroke would. NO Enter is ever sent
# (number-only), so it can never submit a shell command. Raise-/kill-free: no window is
# shown, activated, minimized, closed, or terminated.
param([int]$Digit = 0, [switch]$Enter)
$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\.clawd-widget"
$log = Join-Path $dir 'focus.log'
function Log ($m) { try { Add-Content -Path $log -Value ((Get-Date -Format o) + '  [send-choice] ' + $m) } catch {} }

# Two modes: inject a DIGIT (1-9) to pick a numbered option, or inject ENTER (-Enter) to submit
# a multi-question AskUserQuestion after its last answer. Enter is used ONLY for that submit step
# (never after a shell command), so it can't run anything.
if ($Enter) { $vk = [uint16]0x0D; $ch = [char]13 }
elseif ($Digit -ge 1 -and $Digit -le 9) { $vk = [uint16](0x30 + $Digit); $ch = [char]([int][char]'0' + $Digit) }
else { Log "bad digit=$Digit"; return }

$sf = Join-Path $dir 'session.json'
if (-not (Test-Path $sf)) { Log 'no session.json'; return }
$s = Get-Content $sf -Raw | ConvertFrom-Json
$pids = @($s.consolePids) | Where-Object { ($_ -as [int]) -gt 0 }
if (-not $pids -or $pids.Count -eq 0) { Log 'no consolePids cached'; return }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ConInject {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(
    [MarshalAs(UnmanagedType.LPWStr)] string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteConsoleInput(
    IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);

  [StructLayout(LayoutKind.Sequential)]
  public struct KEY_EVENT_RECORD {
    public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }

  // Attach to `pid`'s console and write the key (given its virtual-key code + char) as a
  // down+up pair. Used for a digit (option pick) or Enter (multi-question submit).
  public static string Inject(uint pid, ushort vk, char ch) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach-fail:" + Marshal.GetLastWin32Error();
    IntPtr h = CreateFileW("CONIN$", 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); FreeConsole(); return "conin-fail:" + e; }
    var down = new KEY_EVENT_RECORD {
      bKeyDown = 1, wRepeatCount = 1, wVirtualKeyCode = vk,
      wVirtualScanCode = 0, UnicodeChar = ch, dwControlKeyState = 0
    };
    var up = down; up.bKeyDown = 0;
    var recs = new INPUT_RECORD[2];
    recs[0].EventType = 1; recs[0].KeyEvent = down;   // KEY_EVENT = 1
    recs[1].EventType = 1; recs[1].KeyEvent = up;
    uint written;
    bool ok = WriteConsoleInput(h, recs, 2u, out written);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(h);
    FreeConsole();
    return "ok=" + ok + " written=" + written + " err=" + err;
  }
}
"@

# Shell/runtime names we'll attach to. Guards against the rare case where a captured PID
# died and got reused by an unrelated process (a lone digit, no Enter, is harmless anyway).
$allow = 'node','claude','cmd','powershell','pwsh','bash','sh','zsh','fish',
         'wsl','wslhost','ubuntu'
$what = if ($Enter) { 'ENTER' } else { "digit=$Digit" }
$done = $false
foreach ($p in $pids) {
  $proc = Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $name = ($proc.ProcessName).ToLowerInvariant()
  if ($allow -notcontains $name) { Log "skip pid=$p name=$name (not allowlisted)"; continue }
  $r = [ConInject]::Inject([uint32]$p, $vk, $ch)
  Log "inject $what pid=$p name=$name -> $r"
  if ($r -like 'ok=True*' -and $r -notlike '*written=0*') { $done = $true; break }
}

# Self-heal a STALE cache. session.json's consolePids are only re-resolved on a
# question/done hook, so right after a NEW session starts (or when the CLI's node pid
# rotated) the cached pids belong to a dead/previous session -> "no attachable console
# client" and the click appears to do nothing. Re-find the LIVE Claude Code CLI process
# (node.exe running the claude package, excluding this widget) and inject into its console.
# Only when EXACTLY ONE such session is running, so a digit can never land in the wrong
# session. Same safe mechanism as above: digit only, no Enter, nothing focused or killed.
if (-not $done) {
  # Match the CLI ENTRY POINT (claude-code's cli.js), not just 'claude' anywhere -- the
  # latter also catches transient `npm view @anthropic-ai/claude-code@latest` update checks
  # the CLI spawns, which would make a lone session look ambiguous.
  $live = @()
  Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cl = ('' + $_.CommandLine).ToLower()
    if ($cl -like '*claude-code*cli.js*' -and $cl -notlike '*clawd-widget*') { $live += [int]$_.ProcessId }
  }
  $live = @($live | Where-Object { $_ -gt 0 -and ($pids -notcontains $_) } | Select-Object -Unique)
  if ($live.Count -eq 1) {
    $p = $live[0]
    $r = [ConInject]::Inject([uint32]$p, $vk, $ch)
    Log "inject(live) $what pid=$p name=node -> $r"
    if ($r -like 'ok=True*' -and $r -notlike '*written=0*') { $done = $true }
  } elseif ($live.Count -gt 1) {
    Log "live fallback skipped: $($live.Count) claude sessions (ambiguous target)"
  }
}
if (-not $done) { Log "$what not injected (no attachable console client)" }
