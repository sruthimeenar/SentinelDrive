// Node unit tests for the siren-detection signal library.
// Run: node frontend/tests/test_siren.mjs
import { analyzeFrame, classifySiren, byteToDb, SIREN_BAND_LO_HZ, SIREN_BAND_HI_HZ, SIREN_ACTIVE_WINDOW_MS } from '../src/lib/siren.js'

const failures = []
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name} ${detail}`)
  }
}

const N = 2048
const BIN_HZ = 48000 / 2048 // 23.4375

// Build a synthetic AnalyserNode frame (Uint8Array) with a narrowband peak at
// `hz` plus low broadband noise, OR flat broadband noise only (no peak).
function frame(hz, { peakAmp = 230, noiseAmp = 40 } = {}) {
  const d = new Uint8Array(N)
  for (let b = 0; b < N; b++) {
    const noise = Math.floor(noiseAmp * Math.sin(b * 12.9898))
    let v = 10 + (Math.abs(noise) % 30)
    if (hz > 0) {
      const bin = Math.round(hz / BIN_HZ)
      if (b === bin) v = peakAmp
      else if (Math.abs(b - bin) === 1) v = Math.floor(peakAmp * 0.35)
    }
    d[b] = Math.max(0, Math.min(255, v))
  }
  return d
}

// --- analyzeFrame: narrowband peak detection ---
const sirenFrame = analyzeFrame(frame(1100, { peakAmp: 235, noiseAmp: 30 }))
check('dominant frequency lands on the injected 1100 Hz tone', Math.abs(sirenFrame.dominantHz - 1100) < BIN_HZ * 2, `hz=${sirenFrame.dominantHz}`)
check('strong tonal peak is classified narrowband', sirenFrame.narrowband === true, `db=${sirenFrame.peakDb.toFixed(1)} avg=${sirenFrame.bandAvgDb.toFixed(1)}`)
check('siren-band peak is loud', sirenFrame.peakDb >= -55, `db=${sirenFrame.peakDb.toFixed(1)}`)

const noiseFrame = analyzeFrame(frame(0, { noiseAmp: 60 }))
check('broadband noise has NO dominant narrowband peak', noiseFrame.narrowband === false, `db=${noiseFrame.peakDb.toFixed(1)}`)

const outOfBand = analyzeFrame(frame(80, { peakAmp: 235 }))
check('engine rumble below the siren band is ignored', outOfBand.narrowband === false, `hz=${outOfBand.dominantHz}`)

check('byteToDb maps 255 -> -30', Math.abs(byteToDb(255) + 30) < 1)
check('byteToDb maps 0 -> -100', Math.abs(byteToDb(0) + 100) < 1)

// --- classifySiren: alternating two-tone = siren ---
const t0 = 1_000_000
const mk = (i, hz, narrow = true) => ({
  t: t0 + i * 100,
  dominantHz: hz,
  narrowband: narrow,
  peakDb: narrow ? -40 : -60,
})
// Simulate a two-tone siren alternating 700 <-> 1200 Hz every 400 ms over ~2.4s.
const twoTone = []
for (let i = 0; i < 24; i++) {
  const hz = i % 2 === 0 ? 700 : 1200
  twoTone.push(mk(i, hz))
}
const siren = classifySiren(twoTone)
check('two-tone alternation is classified as a siren', siren.siren === true, JSON.stringify(siren))
check('siren score is high', siren.score >= 0.4, `score=${siren.score}`)

// --- classifySiren: steady tone (e.g. a horn) is NOT a siren ---
const steady = []
for (let i = 0; i < 24; i++) steady.push(mk(i, 1100))
const horn = classifySiren(steady)
check('a steady narrowband tone is NOT a siren (no freq alternation)', horn.siren === false, JSON.stringify(horn))

// --- classifySiren: broadband traffic noise is NOT a siren ---
const noisy = []
for (let i = 0; i < 24; i++) noisy.push(mk(i, 300 + (i % 3) * 150, false))
const traffic = classifySiren(noisy)
check('broadband traffic noise is NOT a siren', traffic.siren === false, JSON.stringify(traffic))

// --- classifySiren: brief burst under the sustained window is not armed ---
const brief = []
for (let i = 0; i < 5; i++) brief.push(mk(i, i % 2 === 0 ? 700 : 1200))
const short = classifySiren(brief)
check('a <1s burst does NOT arm a siren', short.siren === false, JSON.stringify(short))

// --- classifySiren respects the time window: stale frames older than the
// active window must be discarded. A gap in the middle followed by only a
// short tail (< min span) must NOT arm ---
const burstA = twoTone.map((f) => ({ ...f, t: f.t }))
const burstB = twoTone.slice(0, 5).map((f) => ({ ...f, t: f.t + 9000 }))
const withGap = [...burstA, ...burstB]
const gap = classifySiren(withGap)
check('frames before a 9s gap are stale; short tail does not arm', gap.siren === false, JSON.stringify(gap))

// --- a genuinely slow wail (switch period > active window) must clear:
// within the 2.2s window there aren't enough tone switches to arm ---
const slowWailFrames = []
for (let i = 0; i < 24; i++) slowWailFrames.push(mk(i * 800, i % 2 === 0 ? 700 : 1200)) // switch every 1.6s
const slowWail = classifySiren(slowWailFrames)
check('a slow wail with too few switches per window clears', slowWail.siren === false, JSON.stringify(slowWail))

console.log('\nsiren lib results:', JSON.stringify({ siren, horn, traffic, short }, null, 2))
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nSIREN LIB TESTS PASS')