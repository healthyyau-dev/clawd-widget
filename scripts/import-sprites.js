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
  error: 12,
};

// Frame files don't all share one naming convention. The Figma round-trip frames use a
// 2-digit, 0-indexed name with a duplicate suffix ("mascot_p03 1.svg"); the error frames
// were exported 3-digit and 1-indexed with no suffix ("error_p001.svg"). Try the known
// candidate names for frame i (0-based) and use whichever exists.
function frameFile(name, i) {
  const candidates = [
    `${name}_p${String(i).padStart(2, '0')} 1.svg`,   // Figma duplicate: 0-indexed, 2-digit
    `${name}_p${String(i).padStart(2, '0')}.svg`,      // clean export: 0-indexed, 2-digit
    `${name}_p${String(i + 1).padStart(3, '0')}.svg`,  // error export: 1-indexed, 3-digit
    `${name}_p${String(i + 1).padStart(2, '0')}.svg`,  // 1-indexed, 2-digit
  ];
  for (const c of candidates) {
    const p = path.join(exportDir, c);
    if (fs.existsSync(p)) return p;
  }
  return path.join(exportDir, candidates[0]); // fall back so the read error names the expected file
}

function readFrame(name, i) {
  const svg = fs.readFileSync(frameFile(name, i), 'utf8');
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
