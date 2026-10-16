// Node unit tests for the on-device redaction helpers in src/lib/redact.js.
// Run: node frontend/tests/test_redaction.mjs
import { detectPlates, pixelateRegions } from '../src/lib/redact.js'

const W = 640
const H = 360

// Deterministic RNG so the test is stable.
let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

function makeImageData() {
  const data = new Uint8ClampedArray(W * H * 4)
  // Asphalt-ish background with mild noise (low gradient, so not text-like).
  for (let i = 0; i < W * H; i++) {
    const v = 52 + Math.round((rnd() - 0.5) * 6)
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  const fill = (x, y, w, h, r, g, b) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * W + xx) * 4
        data[i] = r
        data[i + 1] = g
        data[i + 2] = b
        data[i + 3] = 255
      }
    }
  }
  const ellipse = (cx, cy, rx, ry, r, g, b) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) {
          const i = (y * W + x) * 4
          data[i] = r
          data[i + 1] = g
          data[i + 2] = b
        }
      }
    }
  }
  // SMOOTH skin-toned face (no edges -> plate heuristic must NOT flag it).
  ellipse(125, 180, 70, 85, 224, 178, 150)
  // License plate: light rectangle with 7 dark characters.
  fill(320, 180, 214, 60, 200, 200, 200)
  const chars = [340, 366, 392, 418, 444, 470, 496]
  for (const cx of chars) fill(cx, 190, 14, 30, 40, 40, 40)
  return { data, width: W, height: H }
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.log(`FAIL ${name} ${detail}`)
  }
}

function intersect(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ix * iy
}

const imageData = makeImageData()
const plates = detectPlates(imageData)

const truePlate = { x: 320, y: 180, w: 214, h: 60 }
const faceZone = { x: 55, y: 95, w: 140, h: 170 }

check('finds >= 1 plate-like region', plates.length >= 1, JSON.stringify(plates))

let best = null
for (const p of plates) {
  const ov = intersect(p, truePlate) / (truePlate.w * truePlate.h)
  if (!best || ov > best.ov) best = { p, ov }
}
check('detected region covers the plate', !!best && best.ov > 0.5, best ? `overlap=${best.ov.toFixed(2)}` : 'none')

const falsePos = plates.some((p) => intersect(p, faceZone) > 0)
check('face zone is not flagged by the plate heuristic', !falsePos)

// Pixelation must destroy the characters: the dark (luminance < 100) char
// pixels must be gone after redaction, regardless of grid alignment.
function darkFraction(buf, rect) {
  let dark = 0
  const n = rect.w * rect.h
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * W + x) * 4
      if (0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2] < 100) dark++
    }
  }
  return dark / n
}

const charZone = { x: 340, y: 190, w: 170, h: 30 }
const before = darkFraction(imageData.data, charZone)
const out = pixelateRegions(imageData, plates, 12)
const after = darkFraction(out, charZone)
check('characters present before redaction', before > 0.3, `dark fraction ${before.toFixed(2)}`)
check('characters destroyed after redaction', after < 0.01, `dark fraction ${after.toFixed(3)}`)

// A region with NO text-like content must be left untouched.
const cleanZone = { x: 560, y: 60, w: 60, h: 40 }
const unchanged = out.slice(0, 0).length >= 0 // no-op; check bytes directly below
let changed = false
for (let y = cleanZone.y; y < cleanZone.y + cleanZone.h; y++) {
  for (let x = cleanZone.x; x < cleanZone.x + cleanZone.w; x++) {
    const i = (y * W + x) * 4
    if (out[i] !== imageData.data[i] || out[i + 1] !== imageData.data[i + 1] || out[i + 2] !== imageData.data[i + 2]) changed = true
  }
}
check('clean regions are untouched', !changed)

if (failures) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nAll redaction unit tests passed.')
