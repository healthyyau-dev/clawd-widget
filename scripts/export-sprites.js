// Export each sprite's animation frames as standalone SVG files for editing in
// Figma (and back). Frames are the <g class="pN"> groups inside each sprite.
// Output: sprites_export/<sprite>/<sprite>_pNN.svg  (one clean SVG per frame)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sprites = require(path.join(root, 'renderer', 'sprites.json'));
const outRoot = path.join(root, 'sprites_export');

fs.mkdirSync(outRoot, { recursive: true });
const summary = [];

for (const [name, svg] of Object.entries(sprites)) {
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 16 16';
  const dir = path.join(outRoot, name);
  fs.mkdirSync(dir, { recursive: true });

  // Pull each frame group: <g class="pN"> ... </g>
  const groups = [...svg.matchAll(/<g class="(p\d+)">([\s\S]*?)<\/g>/g)];
  groups.forEach((m) => {
    const id = m[1];                       // p0, p1, ...
    const n = id.slice(1).padStart(2, '0');
    const inner = m[2].trim();
    const frameSvg =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" shape-rendering="crispEdges">
${inner}
</svg>
`;
    fs.writeFileSync(path.join(dir, `${name}_p${n}.svg`), frameSvg);
  });

  summary.push({ name, viewBox: vb, frames: groups.length });
}

console.log('Exported to', outRoot);
console.table(summary);
