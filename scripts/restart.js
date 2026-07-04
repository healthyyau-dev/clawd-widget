#!/usr/bin/env node
'use strict'

// Restart ONLY this widget. It must never terminate the Claude desktop app or a
// Claude CLI session, even if they have this folder open. So we match the EXACT
// path of this project's own Electron binary in the command line, not a loose
// project-name substring (Claude helper processes can contain that path).

const { spawn, spawnSync } = require('child_process')
const path = require('path')
const root = path.join(__dirname, '..')

let electronBin = null
try { electronBin = require('electron') } catch (e) { electronBin = null }

function killWidget () {
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'taskkill /F /IM ClawdWidget.exe >nul 2>&1'], { stdio: 'ignore' })
    if (!electronBin) return
    const binEsc = electronBin.replace(/'/g, "''")
    const ps =
      "Get-CimInstance Win32_Process -Filter \"name='electron.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + binEsc + "') } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  } else {
    if (!electronBin) return
    const safe = electronBin.replace(/(["$`\\])/g, '\\$1')
    spawnSync('sh', ['-c', 'pkill -f "' + safe + '" || true'], { stdio: 'ignore' })
  }
}

killWidget()

setTimeout(() => {
  if (!electronBin) { console.error('electron not installed - run "npm install" first'); process.exit(1) }
  spawn(electronBin, ['.'], { cwd: root, stdio: 'inherit', detached: true }).unref()
}, 600)
