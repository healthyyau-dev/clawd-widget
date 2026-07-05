# Lists the active Claude Code CLI sessions for the widget's tray "Active sessions" menu.
# READ-ONLY: enumerates processes and reads each session's working directory -- never
# starts, focuses, or kills anything.
# Prints a JSON array of { pid, title }, one per running Claude Code CLI session:
#   pid   : the node.exe process id of the session (what focus-session.ps1 -TargetPid takes).
#   title : the session's PROJECT FOLDER name (leaf of its working directory, e.g.
#           "clawd-widget"), so sessions are identifiable; falls back to "Claude session <pid>".
#
# The folder name comes from the process's own working directory, read from its PEB
# (NtQueryInformationProcess + ReadProcessMemory) -- the terminal WINDOW TITLE is useless
# here (Claude sets every tab to "Claude Code"). The Add-Type below is small and compiles in
# well under a second; the caller (main.js listSessions) allows 8s, so a cold compile is fine.
#
# NOTE: Windows PowerShell 5.1 emits a bare object (no []) for a single session; the caller
# tolerates object-or-array and an empty string.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Peb {
  [StructLayout(LayoutKind.Sequential)] public struct PBI {
    public IntPtr R; public IntPtr Peb; public IntPtr a; public IntPtr b; public IntPtr c; public IntPtr d;
  }
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr baseAddr, byte[] buf, int size, out int read);
  // Current working directory of `pid` (same-user process), or null. x64 offsets:
  // PEB->ProcessParameters @0x20; RTL_USER_PROCESS_PARAMETERS->CurrentDirectory.DosPath @0x38.
  public static string Cwd(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      PBI pbi = new PBI(); int rl;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl) != 0) return null;
      byte[] p = new byte[IntPtr.Size]; int rd;
      if (!ReadProcessMemory(h, (IntPtr)((long)pbi.Peb + 0x20), p, p.Length, out rd)) return null;
      long pp = (IntPtr.Size == 8) ? BitConverter.ToInt64(p, 0) : BitConverter.ToInt32(p, 0);
      byte[] us = new byte[16]; // UNICODE_STRING: Length(u16) MaxLength(u16) _ Buffer(ptr@+8)
      if (!ReadProcessMemory(h, (IntPtr)(pp + 0x38), us, us.Length, out rd)) return null;
      ushort len = BitConverter.ToUInt16(us, 0);
      long buf = BitConverter.ToInt64(us, 8);
      if (len == 0 || buf == 0) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)buf, s, len, out rd)) return null;
      return Encoding.Unicode.GetString(s, 0, rd);
    } finally { CloseHandle(h); }
  }
}
"@

# Match the Claude Code ENTRY POINT specifically (same rule as detect-claude.ps1) and
# exclude this widget's own electron. A bare '*claude*' would catch unrelated node procs.
$sessions = @()
$nodes = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $nodes) {
  $cl = ('' + $p.CommandLine).ToLower()
  $isCli = ($cl -like '*claude-code*') -or ($cl -like '*\.bin\claude*') -or ($cl -like '*\claude\cli.js*')
  # Exclude the widget's own electron, and npm helper processes (e.g. the periodic
  # `npm view @anthropic-ai/claude-code@latest` update check) -- those run from the home
  # folder and would otherwise show up as a phantom session named after it (e.g. "zippe").
  if (-not $isCli -or $cl -like '*clawd-widget*' -or $cl -like '*npm-cli.js*') { continue }
  $spid = [int]$p.ProcessId

  $title = $null
  $cwd = [Peb]::Cwd($spid)
  if ($cwd) {
    $cwd = $cwd.TrimEnd('\')
    if ($cwd) { $leaf = Split-Path $cwd -Leaf; if ($leaf) { $title = $leaf } else { $title = $cwd } }
  }
  if (-not $title) { $title = "Claude session $spid" }

  $sessions += [pscustomobject]@{ pid = $spid; title = $title }
}

$json = $sessions | ConvertTo-Json -Compress
if (-not $json) { $json = '[]' }
$json
