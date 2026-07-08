#!/usr/bin/env node
'use strict'

/*
 * PROTOTYPE / EXPERIMENT -- NOT WIRED INTO THE WIDGET.
 * Standalone runner for detect-desktop-working.ps1. Mirrors the execSync+timeout
 * pattern set-state.js uses, so if the probe proves reliable it can be lifted into
 * main.js behind a feature flag. Imported by nothing.
 *
 *   node experiments/detect-desktop-working.js          -> prints working|idle|not-running|unknown
 *   node experiments/detect-desktop-working.js --dump    -> button/text inventory (calibration)
 *   node experiments/detect-desktop-working.js --json     -> { state, reason, hwnd }
 */

const path = require('path')
const { execSync } = require('child_process')

function run () {
  if (process.platform !== 'win32') return { state: 'unknown', reason: 'not-windows' }
  const dump = process.argv.includes('--dump')
  const json = process.argv.includes('--json')
  // The probe now lives in scripts/ (bundled into the real widget); this experiment runner
  // just points at it there.
  const ps = path.join(__dirname, '..', 'scripts', 'detect-desktop-working.ps1')
  const flags = (dump ? ' -Dump' : '') + (json ? ' -Json' : '')
  try {
    const out = execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps + '"' + flags,
      { timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
    if (dump) { process.stdout.write(out); return null }
    if (json) { try { return JSON.parse(out.trim()) } catch (e) { return { state: 'unknown', reason: 'bad-json', raw: out.trim() } } }
    return { state: (out.trim() || 'unknown') }
  } catch (e) {
    return { state: 'unknown', reason: 'probe-failed:' + (e && e.message ? e.message.split('\n')[0] : 'error') }
  }
}

const r = run()
if (r) console.log(typeof r === 'string' ? r : JSON.stringify(r))
