// End-to-end verification of the Phase 6 privacy layer in a real browser
// (headless Edge). Proves: on-device redaction runs before upload, the bytes
// that leave the device are redacted, and the backend receives + records a
// redacted image.
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORTRAIT = readFileSync('C:\\Users\\purpl\\AppData\\Local\\Temp\\opencode\\portrait.jpg').toString('base64')

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await browser.newPage()
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 30000 })

const results = await page.evaluate(async (portraitB64) => {
  const out = {}
  const mod = await import('/src/lib/redact.js')
  const { redactImageBlob } = mod

  const decode = (blob) =>
    new Promise((res, rej) => {
      const img = new Image()
      const u = URL.createObjectURL(blob)
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        c.getContext('2d').drawImage(img, 0, 0)
        URL.revokeObjectURL(u)
        res(c.getContext('2d').getImageData(0, 0, c.width, c.height))
      }
      img.onerror = rej
      img.src = u
    })

  const changedPixels = (a, b) => {
    let n = 0
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 10) n++
    }
    return n
  }

  // --- A: real photo face redaction (MediaPipe FaceDetector) ---
  const portImg = new Image()
  portImg.src = 'data:image/jpeg;base64,' + portraitB64
  await new Promise((res, rej) => { portImg.onload = res; portImg.onerror = rej })
  const c0 = document.createElement('canvas')
  c0.width = portImg.width
  c0.height = portImg.height
  c0.getContext('2d').drawImage(portImg, 0, 0)
  const pBlob = await new Promise((r) => c0.toBlob(r, 'image/jpeg', 0.92))
  const pRed = await redactImageBlob(pBlob)
  out.faceFaces = pRed.report.faces
  const pa = await decode(pBlob)
  const pb2 = await decode(pRed.blob)
  out.faceChangedPixels = changedPixels(pa, pb2)

  // --- B: synthetic plate redaction (heuristic) ---
  const plateCanvas = document.createElement('canvas')
  plateCanvas.width = 640
  plateCanvas.height = 360
  const pctx = plateCanvas.getContext('2d')
  pctx.fillStyle = '#343434'
  pctx.fillRect(0, 0, 640, 360)
  pctx.fillStyle = '#e0b296'
  pctx.beginPath()
  pctx.ellipse(125, 180, 70, 85, 0, 0, Math.PI * 2)
  pctx.fill()
  pctx.fillStyle = '#c8c8c8'
  pctx.fillRect(320, 180, 214, 60)
  pctx.fillStyle = '#282828'
  for (const cx of [340, 366, 392, 418, 444, 470, 496]) pctx.fillRect(cx, 190, 14, 30)
  const plateBlob = await new Promise((r) => plateCanvas.toBlob(r, 'image/png'))
  const plateRed = await redactImageBlob(plateBlob)
  out.platePlates = plateRed.report.plates
  const pb = await decode(plateRed.blob)
  let dark = 0
  let n = 0
  for (let y = 190; y < 220; y++) {
    for (let x = 340; x < 510; x++) {
      const i = (y * 640 + x) * 4
      const v = 0.299 * pb.data[i] + 0.587 * pb.data[i + 1] + 0.114 * pb.data[i + 2]
      if (v < 100) dark++
      n++
    }
  }
  out.plateDarkFraction = dark / n

  // --- C: full pipeline with redaction (pothole + plate) ---
  const pc = document.createElement('canvas')
  pc.width = 1280
  pc.height = 720
  const g = pc.getContext('2d')
  for (let y = 0; y < 720; y++) {
    const v = Math.round(115 - (y / 720) * 22)
    g.fillStyle = `rgb(${v},${v},${v})`
    g.fillRect(0, y, 1280, 1)
  }
  g.fillStyle = 'rgb(135,135,135)'
  g.fillRect(0, 0, 1280, 252)
  g.fillStyle = 'rgb(235,235,235)'
  g.fillRect(537, 259, 20, 461)
  g.fillStyle = 'rgb(34,34,34)'
  g.beginPath()
  g.ellipse(704, 576, 57, 43, 0, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#c8c8c8'
  g.fillRect(60, 120, 214, 60)
  g.fillStyle = '#282828'
  for (const cx of [80, 106, 132, 158, 184, 210, 236]) g.fillRect(cx, 130, 14, 30)
  const shotBlob = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.95))
  const shotRed = await redactImageBlob(shotBlob)
  out.shotPlates = shotRed.report.plates

  const fd = new FormData()
  fd.append('file', new File([shotRed.blob], 'dashcam.jpg', { type: shotRed.blob.type }))
  fd.append('redaction', JSON.stringify(shotRed.report))
  const resp = await fetch('/api/detections/upload', { method: 'POST', body: fd })
  out.uploadStatus = resp.status
  const body = await resp.json()
  out.detectionCount = body.detection_count
  out.privacyEchoed = !!body.privacy && body.privacy.plates === shotRed.report.plates
  if (body.annotated) {
    const img = new Image()
    img.src = body.annotated
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const id = ctx.getImageData(0, 0, c.width, c.height)
    let d2 = 0
    let n2 = 0
    for (let y = 120; y < 180; y++) {
      for (let x = 60; x < 274; x++) {
        const i = (y * c.width + x) * 4
        const v = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2]
        if (v < 100) d2++
        n2++
      }
    }
    out.annotatedPlateDarkFraction = d2 / n2
  }
  return out
}, PORTRAIT)

await browser.close()

// Assertions
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name} ${detail}`)
  }
}

check('A: MediaPipe detects the face in a real photo', results.faceFaces >= 1, `faces=${results.faceFaces}`)
check('A: face pixels were changed by redaction', results.faceChangedPixels > 0, `changed=${results.faceChangedPixels}`)
check('B: plate heuristic finds the synthetic plate', results.platePlates >= 1, `plates=${results.platePlates}`)
check('B: plate characters destroyed in the redacted blob', results.plateDarkFraction < 0.01, `dark=${results.plateDarkFraction}`)
check('C: pothole+plate frame redacted on-device', results.shotPlates >= 1, `plates=${results.shotPlates}`)
check('C: upload succeeds', results.uploadStatus === 200, `status=${results.uploadStatus}`)
check('C: pothole still detected after redaction', results.detectionCount >= 1, `count=${results.detectionCount}`)
check('C: backend echoes the privacy report', results.privacyEchoed === true)
check('C: plate is ALREADY BLURRED in the backend preview (no unblurred frame sent)', results.annotatedPlateDarkFraction !== undefined && results.annotatedPlateDarkFraction < 0.01, `dark=${results.annotatedPlateDarkFraction}`)

console.log('\nresults:', JSON.stringify(results, null, 2))
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nPRIVACY LAYER E2E PASS')
