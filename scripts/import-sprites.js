// Reverse of export-sprites.js: fold the Figma-edited frame SVGs back into
// renderer/sprites.json + sprites.js as the flipbook <g class="pN"> structure.
// Edited frames live at sprites_export/<name>_pNN 1.svg (Figma duplicate suffix).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const exportDir = path.join(root, 'sprites_export');
const VIEWBOX = '0 0 35 34';            // all standardized to 35x34 in Figma

// Frame counts must match the existing CSS keyframes (.spr-<name> .pN).
const SPRITES = {
  bubble: 11,
  think: 12,
  working: 4,
  idea: 6,
  mascot: 22,
};

function readFrame(name, i) {
  const n = String(i).padStart(2, '0');
  const file = path.join(exportDir, `${name}_p${n} 1.svg`);
  const svg = fs.readFileSync(file, 'utf8');
  // Keep only the drawing <path> elements (own fills); drop svg/defs/clipPath/g.
  const paths = svg.match(/<path\b[^>]*\/>/g) || [];
  if (!paths.length) console.warn(`  ! ${name} p${i}: no <path> elements`);
  return paths;
}

const out = {};
for (const [name, count] of Object.entries(SPRITES)) {
  const groups = [];
  for (let i = 0; i < count; i++) {
    const paths = readFrame(name, i);
    const body = paths.map((p) => `    ${p}`).join('\n');
    groups.push(`  <g class="p${i}">\n${body}\n  </g>`);
  }
  out[name] =
    `<svg class="sprite spr-${name}" viewBox="${VIEWBOX}" shape-rendering="crispEdges" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n${groups.join('\n')}\n</svg>`;
  console.log(`${name.padEnd(8)} ${count} frames folded`);
}

fs.writeFileSync(path.join(root, 'renderer', 'sprites.json'), JSON.stringify(out));
fs.writeFileSync(path.join(root, 'renderer', 'sprites.js'), 'window.SPRITES = ' + JSON.stringify(out) + ';');
console.log('\nWrote renderer/sprites.json and renderer/sprites.js');
