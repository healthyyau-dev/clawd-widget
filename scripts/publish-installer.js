'use strict'
// Post-build step: the root `Clawd.exe` is the single source of truth for the installer.
// electron-builder always writes to dist/ (build.directories.output), so after a build we MOVE the
// freshly built installer up to the repo root (overwriting the previous one) and clean up the dist
// copy + its blockmap, so there's never a stale/confusing second installer in dist/.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')
const NAME = 'Clawd.exe'

const src = path.join(dist, NAME)
const dest = path.join(root, NAME)

if (!fs.existsSync(src)) {
  console.error('publish-installer: built installer not found at ' + src)
  process.exit(1)
}

// Move installer to root (rename works within the same volume; fall back to copy+unlink).
try {
  fs.rmSync(dest, { force: true })
  fs.renameSync(src, dest)
} catch (e) {
  fs.copyFileSync(src, dest)
  fs.rmSync(src, { force: true })
}

// Remove the now-orphaned blockmap in dist so nothing points at the moved file.
try { fs.rmSync(src + '.blockmap', { force: true }) } catch (e) {}

// House rule: the root `Clawd.exe` is the ONLY .exe that should exist at any time. electron-builder
// leaves the intermediate unpacked app at dist/win-unpacked/ (which contains Clawd.exe + elevate.exe) plus
// assorted yml/blockmap artifacts. Those are pure build scratch -- the dev widget runs from source and the
// installed app lives in %LOCALAPPDATA% -- so wipe the whole dist/ folder once the installer is safely in
// root. Nothing downstream depends on dist/ persisting; the next build regenerates it.
try { fs.rmSync(dist, { recursive: true, force: true }) } catch (e) {}

const kb = Math.round(fs.statSync(dest).size / 1024)
console.log('publish-installer: updated root "' + NAME + '" (' + kb + ' KB); removed dist/ scratch')
