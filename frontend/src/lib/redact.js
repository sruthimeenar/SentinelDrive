// On-device privacy redaction. Runs BEFORE any frame leaves the browser:
// faces (MediaPipe FaceDetector) and license-plate-like regions (heuristic)
// are pixelated on a canvas, and only the redacted encoding is uploaded.
// Redaction is FAIL-CLOSED: if the face detector cannot be loaded, uploads are
// blocked rather than sending an unredacted frame.
//
// The plate matcher + pixelation helpers are pure functions over an
// ImageData-like {data, width, height} so they are unit-testable in Node
// (see frontend/tests/test_redaction.mjs).

function downsample(data, W, H, w2, h2) {
  const gray = new Float32Array(w2 * h2)
  const sat = new Float32Array(w2 * h2)
  const sx = W / w2
  const sy = H / h2
  for (let y = 0; y < h2; y++) {
    const y0 = Math.min(H - 1, Math.floor(y * sy))
    for (let x = 0; x < w2; x++) {
      const x0 = Math.min(W - 1, Math.floor(x * sx))
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < sy; j++) {
        for (let i = 0; i < sx; i++) {
          const idx = ((y0 + j) * W + (x0 + i)) * 4
          r += data[idx]
          g += data[idx + 1]
          b += data[idx + 2]
        }
      }
      const n = sx * sy
      r /= n
      g /= n
      b /= n
      gray[y * w2 + x] = 0.299 * r + 0.587 * g + 0.114 * b
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      sat[y * w2 + x] = mx === 0 ? 0 : (mx - mn) / mx
    }
  }
  return { gray, sat }
}

function sobel(gray, w2, h2) {
  const mag = new Float32Array(w2 * h2)
  for (let y = 1; y < h2 - 1; y++) {
    for (let x = 1; x < w2 - 1; x++) {
      const i = y * w2 + x
      const tl = gray[i - w2 - 1]
      const t = gray[i - w2]
      const tr = gray[i - w2 + 1]
      const l = gray[i - 1]
      const r = gray[i + 1]
      const bl = gray[i + w2 - 1]
      const b = gray[i + w2]
      const br = gray[i + w2 + 1]
      const gx = -tl - 2 * l - bl + tr + 2 * r + br
      const gy = -tl - 2 * t - tr + bl + 2 * b + br
      mag[i] = Math.abs(gx) + Math.abs(gy)
    }
  }
  return mag
}

function mergeRect(a, b) {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
    count: a.count + b.count,
    height: 0,
    width: 0,
    charWidth: Math.max(a.charWidth, b.charWidth),
  }
}

function finishRect(r) {
  r.width = r.right - r.left
  r.height = r.bottom - r.top
  return r
}

function lineOverlap(a, b) {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
}

// License-plate heuristic: a horizontal run of character-sized, low-saturation,
// high-contrast components (letters/digits) on a light plate. Returns rects in
// ORIGINAL pixel coordinates.
export function detectPlates(imageData) {
  const { data, width: W, height: H } = imageData
  if (!W || !H) return []
  const WS = 480
  const scale = Math.min(1, WS / W)
  const w2 = Math.max(16, Math.round(W * scale))
  const h2 = Math.max(16, Math.round(H * scale))
  const { gray, sat } = downsample(data, W, H, w2, h2)
  const mag = sobel(gray, w2, h2)

  let sum = 0
  for (let i = 0; i < mag.length; i++) sum += mag[i]
  const thr = Math.max(30, (sum / mag.length) * 1.4)

  const text = new Uint8Array(w2 * h2)
  for (let i = 0; i < w2 * h2; i++) {
    if (mag[i] >= thr && sat[i] < 0.45) text[i] = 1
  }

  // Character-like connected components.
  const seen = new Uint8Array(w2 * h2)
  const chars = []
  const hFracMin = 0.004
  const hFracMax = 0.1
  const wFracMin = 0.002
  const wFracMax = 0.06
  for (let i = 0; i < w2 * h2; i++) {
    if (!text[i] || seen[i]) continue
    const queue = [i]
    seen[i] = 1
    let minX = w2
    let minY = h2
    let maxX = -1
    let maxY = -1
    let cnt = 0
    while (queue.length) {
      const cur = queue.pop()
      const cx = cur % w2
      const cy = (cur / w2) | 0
      cnt++
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue
          const ni = ny * w2 + nx
          if (text[ni] && !seen[ni]) {
            seen[ni] = 1
            queue.push(ni)
          }
        }
      }
    }
    const cw = maxX - minX + 1
    const ch = maxY - minY + 1
    const density = cnt / (cw * ch || 1)
    if (density < 0.08) continue
    if (ch / h2 < hFracMin || ch / h2 > hFracMax) continue
    if (cw / w2 < wFracMin || cw / w2 > wFracMax) continue
    const aspect = cw / ch
    if (aspect < 0.3 || aspect > 2.0) continue
    chars.push({ left: minX, right: maxX, top: minY, bottom: maxY, count: 1, width: cw, height: ch, charWidth: cw })
  }

  // Group nearby characters into text lines (the plate).
  let groups = chars.slice()
  for (let iter = 0; iter < 8; iter++) {
    let merged = false
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]
        const b = groups[j]
        const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right)
        const vOverlap = lineOverlap(a, b)
        const minH = Math.min(a.height, b.height)
        const cw = Math.max(a.charWidth, b.charWidth)
        if (vOverlap > minH * 0.4 && gap <= cw * 2.5) {
          groups[i] = finishRect(mergeRect(a, b))
          groups.splice(j, 1)
          merged = true
          break
        }
      }
    }
    if (!merged) break
  }

  const sx = W / w2
  const sy = H / h2
  const workArea = w2 * h2
  const out = []
  for (const g of groups) {
    if (g.count < 3) continue
    const aspect = g.width / g.height
    if (aspect < 1.5 || aspect > 7) continue
    const area = g.width * g.height
    if (area / workArea < 0.0015 || area / workArea > 0.06) continue
    if (g.width * sx < W * 0.02) continue
    // Expand ~25% so the whole plate (frame + letters) is covered.
    const exp = { x: Math.max(0, Math.round((g.left - g.width * 0.25) * sx)), y: Math.max(0, Math.round((g.top - g.height * 0.25) * sy)), w: Math.round(g.width * 1.5 * sx), h: Math.round(g.height * 1.5 * sy) }
    exp.w = Math.min(W - exp.x, exp.w)
    exp.h = Math.min(H - exp.y, exp.h)
    if (exp.w <= 0 || exp.h <= 0) continue
    let dupe = false
    for (const o of out) {
      const ix = Math.max(0, Math.min(exp.x + exp.w, o.x + o.w) - Math.max(exp.x, o.x))
      const iy = Math.max(0, Math.min(exp.y + exp.h, o.y + o.h) - Math.max(exp.y, o.y))
      if (ix > 0 && iy > 0) {
        dupe = true
        break
      }
    }
    if (!dupe) out.push(exp)
  }
  return out
}

// Replaces each rect with mean-color blocks, run TWICE (offset 0 then
// half-block) so no character-scale cell survives regardless of grid
// alignment. Returns a NEW pixel buffer.
export function pixelateRegions(imageData, rects, block = 12) {
  const W = imageData.width
  const H = imageData.height
  const src = imageData.data
  const out = src.slice()
  const passes = [0, block >> 1]
  for (const offset of passes) {
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x))
      const y0 = Math.max(0, Math.floor(r.y))
      const x1 = Math.min(W, Math.ceil(r.x + r.w))
      const y1 = Math.min(H, Math.ceil(r.y + r.h))
      for (let by = y0 + offset; by < y1; by += block) {
        for (let bx = x0 + offset; bx < x1; bx += block) {
          let rSum = 0
          let gSum = 0
          let bSum = 0
          let n = 0
          const by1 = Math.min(y1, by + block)
          const bx1 = Math.min(x1, bx + block)
          for (let yy = by; yy < by1; yy++) {
            for (let xx = bx; xx < bx1; xx++) {
              const i = (yy * W + xx) * 4
              rSum += out[i]
              gSum += out[i + 1]
              bSum += out[i + 2]
              n++
            }
          }
          if (!n) continue
          const rr = rSum / n
          const gg = gSum / n
          const bb = bSum / n
          for (let yy = by; yy < by1; yy++) {
            for (let xx = bx; xx < bx1; xx++) {
              const i = (yy * W + xx) * 4
              out[i] = rr
              out[i + 1] = gg
              out[i + 2] = bb
            }
          }
        }
      }
    }
  }
  return out
}

// --- Browser-only: MediaPipe face detection + blob redaction ---------------

let faceDetectorPromise = null

export function getFaceDetector() {
  if (faceDetectorPromise) return faceDetectorPromise
  faceDetectorPromise = (async () => {
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const vision = await FilesetResolver.forVisionTasks('/wasm')
    try {
      return await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/face_detector.task', delegate: 'GPU' },
        runningMode: 'IMAGE',
      })
    } catch {
      return await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/face_detector.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
      })
    }
  })()
  return faceDetectorPromise
}

async function detectFaces(image) {
  const fd = await getFaceDetector()
  const res = fd.detect(image)
  return (res.detections || []).map((d) => {
    const bb = d.boundingBox
    return { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height }
  })
}

function reportOf(faces, plates, frames = null) {
  return {
    faces,
    plates,
    frames,
    regions: faces + plates,
    method: 'mediapipe-face + plate-heuristic',
    pixels: faces + plates > 0 ? 'pixelated' : 'clean',
  }
}

// Redacts an image blob (fail-closed). Returns { blob, report }.
export async function redactImageBlob(blob, { pixelBlock = 12 } = {}) {
  if (!('createImageBitmap' in window)) throw new Error('Redaction requires createImageBitmap support.')
  const bmp = await createImageBitmap(blob)
  const W = bmp.width
  const H = bmp.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const imageData = ctx.getImageData(0, 0, W, H)
  const faces = await detectFaces(bmp)
  const plates = detectPlates(imageData)
  const rects = [...faces, ...plates]
  if (rects.length) {
    const out = pixelateRegions(imageData, rects, pixelBlock)
    ctx.putImageData(new ImageData(out, W, H), 0, 0)
  }
  bmp.close()
  const outBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not re-encode redacted image'))), 'image/jpeg', 0.9)
  })
  return { blob: outBlob, report: reportOf(faces.length, plates.length) }
}

// Redacts a video clip by re-encoding every sampled frame through the same
// redaction. Returns { blob, report }.
export async function redactVideoBlob(blob, { fps = 6, maxSeconds = 20, pixelBlock = 12 } = {}) {
  if (!('MediaRecorder' in window)) throw new Error('Redaction requires MediaRecorder support.')
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.src = url
  await new Promise((res, rej) => {
    video.onloadedmetadata = res
    video.onerror = () => rej(new Error('could not decode video for redaction'))
  })
  const W = video.videoWidth
  const H = video.videoHeight
  if (!W || !H) {
    URL.revokeObjectURL(url)
    throw new Error('could not decode video for redaction')
  }
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const stream = canvas.captureStream(fps)
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm'
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  const done = new Promise((res) => {
    rec.onstop = () => res(new Blob(chunks, { type: mime }))
  })
  rec.start(500)

  const totalMs = Math.min(video.duration * 1000, maxSeconds * 1000)
  const stepMs = 1000 / fps
  let faceCount = 0
  let plateCount = 0
  let frames = 0
  for (let t = 0; t < totalMs; t += stepMs) {
    video.currentTime = Math.min(t / 1000, Math.max(0, totalMs - 1) / 1000)
    await Promise.race([
      new Promise((res) => {
        video.onseeked = res
      }),
      new Promise((res) => setTimeout(res, 500)),
    ])
    ctx.drawImage(video, 0, 0, W, H)
    const imageData = ctx.getImageData(0, 0, W, H)
    const faces = await detectFaces(canvas)
    const plates = detectPlates(imageData)
    faceCount += faces.length
    plateCount += plates.length
    const rects = [...faces, ...plates]
    if (rects.length) {
      ctx.putImageData(new ImageData(pixelateRegions(imageData, rects, pixelBlock), W, H), 0, 0)
    }
    frames++
  }
  rec.stop()
  URL.revokeObjectURL(url)
  const outBlob = await done
  return { blob: outBlob, report: reportOf(faceCount, plateCount, frames) }
}
