'use strict'

// Map the Desktop probe state -> a reused sprite. working = the busy 'mascot'
// crab; idle = the calm 'bubble' crab; not-running/unknown = dimmed 'bubble'.
const SPRITE_FOR = { question: 'think', working: 'mascot', done: 'idea', idle: 'bubble', unknown: 'bubble', 'not-running': 'bubble' }
const SPRITES = window.SPRITES || {}

const host = document.getElementById('sprite-host')
const stateEl = document.getElementById('state')
const reasonEl = document.getElementById('reason')

let curKey = null
function setSprite (key, dim) {
  if (key !== curKey) { host.innerHTML = SPRITES[key] || ''; curKey = key }
  host.classList.toggle('dim', !!dim)
}

function render (d) {
  const st = (d && d.state) || 'unknown'
  const key = SPRITE_FOR[st] || 'bubble'
  setSprite(key, st === 'unknown' || st === 'not-running')
  stateEl.textContent = st
  stateEl.className = st
  reasonEl.textContent = (d && d.reason) ? d.reason : ''
}

if (window.probeAPI) {
  window.probeAPI.onProbe(render)
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.probeAPI.ctxMenu() })
}
