#!/usr/bin/env node
// Rasterize assets/clawd.svg into square, non-stretched icons.
// The SVG is pixel-art: strictly axis-aligned <path d="Mx0 y0 Hx1 Vy1 Hx0 Z"/> rects
// with solid fills. We fit the whole viewBox into a square canvas with a UNIFORM
// scale and transparent letterbox padding, so the art is never distorted.
// Outputs: assets/clawd.png (256) and assets/clawd.ico (16/32/48/64/128/256, PNG-in-ICO).

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SVG = path.join(__dirname, '..', 'assets', 'clawd.svg')
const OUT_PNG = path.join(__dirname, '..', 'assets', 'clawd.png')
const OUT_ICO = path.join(__dirname, '..', 'assets', 'clawd.ico')

function parseSvg (src) {
  const vb = /viewBox\s*=\s*"([\d.\s-]+)"/.exec(src)
  let vw, vh
  if (vb) { const p = vb[1].trim().split(/\s+/).map(Number); vw = p[2]; vh = p[3] }
  else {
    vw = Number((/width\s*=\s*"([\d.]+)"/.exec(src) || [])[1])
    vh = Number((/height\s*=\s*"([\d.]+)"/.exec(src) || [])[1])
  }
  const rects = []
  const re = /<path\s+d="M\s*([\d.-]+)\s+([\d.-]+)\s*H\s*([\d.-]+)\s*V\s*([\d.-]+)\s*H\s*([\d.-]+)\s*V?\s*[\d.-]*\s*Z?"\s*fill="([^"]+)"/g
  let m
  while ((m = re.exec(src))) {
    const x0 = +m[1], y0 = +m[2], x1 = +m[3], y1 = +m[4]
    const x = Math.min(x0, x1), y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0)
    rects.push({ x, y, w, h, fill: hexToRgb(m[6]) })
  }
  return { vw, vh, rects }
}

function hexToRgb (hex) {
  hex = hex.trim().replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

// Render into a size×size RGBA buffer with uniform scale + centering (no stretch).
// Supersample SS× then box-downscale for clean edges at small sizes.
function render (svg, size, SS = 4) {
  const hi = size * SS
  const scale = hi / Math.max(svg.vw, svg.vh)          // uniform: fit longer side
  const offX = (hi - svg.vw * scale) / 2
  const offY = (hi - svg.vh * scale) / 2
  const big = new Uint8ClampedArray(hi * hi * 4)
  for (const r of svg.rects) {
    const px0 = Math.round(offX + r.x * scale)
    const py0 = Math.round(offY + r.y * scale)
    const px1 = Math.round(offX + (r.x + r.w) * scale)
    const py1 = Math.round(offY + (r.y + r.h) * scale)
    for (let py = py0; py < py1; py++) {
      if (py < 0 || py >= hi) continue
      for (let px = px0; px < px1; px++) {
        if (px < 0 || px >= hi) continue
        const i = (py * hi + px) * 4
        big[i] = r.fill[0]; big[i + 1] = r.fill[1]; big[i + 2] = r.fill[2]; big[i + 3] = 255
      }
    }
  }
  // box downscale SS×SS -> 1
  const out = new Uint8ClampedArray(size * size * 4)
  const n = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * hi + (x * SS + sx)) * 4
          const a = big[i + 3]
          R += big[i] * a; G += big[i + 1] * a; B += big[i + 2] * a; A += a
        }
      }
      const o = (y * size + x) * 4
      if (A > 0) { out[o] = R / A; out[o + 1] = G / A; out[o + 2] = B / A }
      out[o + 3] = A / n
    }
  }
  return out
}

// Minimal PNG encoder (RGBA, no filter) using zlib.
function encodePNG (rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.slice(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v })
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32 (buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// ICO container embedding PNG blobs (Vista+ supports PNG-in-ICO).
function encodeICO (entries) { // entries: [{size, png}]
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  const blobs = []
  entries.forEach((e, i) => {
    const b = i * 16
    dir[b] = e.size >= 256 ? 0 : e.size       // 0 => 256
    dir[b + 1] = e.size >= 256 ? 0 : e.size
    dir[b + 2] = 0; dir[b + 3] = 0
    dir.writeUInt16LE(1, b + 4)               // color planes
    dir.writeUInt16LE(32, b + 6)              // bpp
    dir.writeUInt32LE(e.png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += e.png.length
    blobs.push(e.png)
  })
  return Buffer.concat([head, dir, ...blobs])
}

function main () {
  const svg = parseSvg(fs.readFileSync(SVG, 'utf8'))
  if (!svg.rects.length) { console.error('No rects parsed from SVG'); process.exit(1) }
  console.log(`viewBox ${svg.vw}x${svg.vh}, ${svg.rects.length} rects`)

  const pngMain = encodePNG(render(svg, 256), 256, 256)
  fs.writeFileSync(OUT_PNG, pngMain)
  console.log(`wrote ${OUT_PNG} (256x256, ${pngMain.length} bytes)`)

  const sizes = [16, 32, 48, 64, 128, 256]
  const entries = sizes.map(s => ({ size: s, png: s === 256 ? pngMain : encodePNG(render(svg, s), s, s) }))
  const ico = encodeICO(entries)
  fs.writeFileSync(OUT_ICO, ico)
  console.log(`wrote ${OUT_ICO} (${sizes.join('/')}, ${ico.length} bytes)`)
}

main()
