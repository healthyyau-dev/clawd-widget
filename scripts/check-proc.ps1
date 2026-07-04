Get-CimInstance Win32_Process -Filter "name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*clawd-widget*' } |
  ForEach-Object { "pid=$($_.ProcessId)  $($_.CommandLine)" }
