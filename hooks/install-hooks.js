#!/usr/bin/env node
'use strict'

/*
 * Safely merges the Clawd widget hooks into ~/.claude/settings.json.
 * - Fills in the absolute path to set-state.js automatically.
 * - Backs up your existing settings.json before writing.
 * - Adds only the Clawd hook commands; your other hooks are preserved.
 *
 *   node install-hooks.js            # install
 *   node install-hooks.js --remove   # remove Clawd hooks again
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const HERE = __dirname
const SET_STATE = path.join(HERE, 'set-state.js')
// Forward slashes: Node accepts them on Windows, and unlike backslashes they
// survive both cmd.exe and the POSIX shell Claude Code may use (backslashes get
// stripped/escaped, which produced the "Cannot find module" path mangling).
const SET_STATE_POSIX = SET_STATE.replace(/\\/g, '/')
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const TAG = 'set-state.js' // commands referencing our script are "ours"
const remove = process.argv.includes('--remove')

function cmd (suffix) { return `node "${SET_STATE_POSIX}" ${suffix}` }

const OURS = {
  SessionStart: [{ hooks: [{ type: 'command', command: cmd('default --launch-widget') }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('working --reset') }] }],
  PreToolUse: [
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: cmd('question') }] },
    { matcher: 'Task', hooks: [{ type: 'command', command: cmd('complex') }] },
    { matcher: '*', hooks: [{ type: 'command', command: cmd('working') }] }
  ],
  SubagentStart: [{ hooks: [{ type: 'command', command: cmd('complex') }] }],
  Notification: [{ hooks: [{ type: 'command', command: cmd('question') }] }],
  Stop: [{ hooks: [{ type: 'command', command: cmd('done') }] }]
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })

let settings = {}
if (fs.existsSync(SETTINGS)) {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch (e) {
    console.error('Could not parse existing settings.json — aborting to avoid damage.')
    process.exit(1)
  }
  fs.copyFileSync(SETTINGS, SETTINGS + '.clawd-backup')
  console.log('Backed up existing settings to', SETTINGS + '.clawd-backup')
}

settings.hooks = settings.hooks || {}

// Strip any previously-installed Clawd entries first (clean re-install / remove).
function stripOurs (arr) {
  return (arr || []).filter((entry) => {
    const cmds = (entry.hooks || []).map((h) => h.command || '')
    return !cmds.some((c) => c.includes(TAG))
  })
}

for (const event of Object.keys(OURS)) {
  settings.hooks[event] = stripOurs(settings.hooks[event])
}

if (!remove) {
  for (const [event, entries] of Object.entries(OURS)) {
    settings.hooks[event] = (settings.hooks[event] || []).concat(entries)
  }
}

// Clean up empty arrays.
for (const event of Object.keys(settings.hooks)) {
  if (Array.isArray(settings.hooks[event]) && settings.hooks[event].length === 0) {
    delete settings.hooks[event]
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
console.log(remove ? 'Removed Clawd hooks from' : 'Installed Clawd hooks into', SETTINGS)
console.log('Restart / start a new Claude Code session for hooks to take effect.')
