// Pure siren-detection signal processing. Runs in the browser on the live
// microphone via Web Audio AnalyserNode frequency data, and is unit-tested in
// Node. NO browser APIs here.
//
// Strategy: a siren is a loud, NARROWBAND tonal pattern whose dominant
// frequency is heavily MODULATED (the classic two-tone/wail alternates between
// two distinct frequency bands over a ~0.5-3 s period). Background road noise
// is broadband (no dominant peak) and music is broadband + sustained, so the
// two features — a dominant narrowband peak AND periodic frequency jumps —
// separate a siren from ordinary noise. This is a heuristic classifier, not a
// learned model; false positives are possible (see README caveats).

// AnalyserNode FFT config used by the hook.
export const SAMPLE_RATE = 48000
export const FFT_SIZE = 2048
export const BIN_HZ = SAMPLE_RATE / FFT_SIZE // 23.4 Hz per bin

// Siren classification constants.
export const SIREN_BAND_LO_HZ = 400 // below this: road rumble / engine
export const SIREN_BAND_HI_HZ = 1800 // above this: hiss / wind / music treble
export const PEAK_DB_THRESHOLD = -55 // dominant peak must be loud (raw byte >= ~64)
export const NARROWBAND_GAP_DB = 18 // peak must tower over the band average
export const MIN_FREQ_JUMP_HZ = 250 // dominant freq must swing at least this much
export const MIN_TONE_SWITCHES = 3 // ...and do so repeatedly (two-tone/wail)
export const SIREN_ACTIVE_WINDOW_MS = 2200 // sustained tone before declaring a siren
export const SIREN_CLEAR_WINDOW_MS = 2500 // quiet this long -> siren gone
// The tone pattern must span at least this much wall-clock time to count as
// sustained (prevents a 3-frame blip from arming a siren).
export const SIREN_MIN_SPAN_MS = 1400

// Convert a byte (0-255) from getByteFrequencyData into dB.
export function byteToDb(byte) {
  // AnalyserNode default: 0 -> -100 dB, 255 -> -30 dB.
  return -100 + (byte / 255) * 70
}

// Compute the dominant-frequency + narrowband features of one spectrum frame.
// freqData: Uint8Array from getByteFrequencyData. Returns:
//   { db, dominantHz, peakDb, bandAvgDb, narrowband }
// where narrowband = the peak towers >= NARROWBAND_GAP_DB over the siren-band
// average (true tonal peak vs broadband noise).
export function analyzeFrame(freqData, { bandLo = SIREN_BAND_LO_HZ, bandHi = SIREN_BAND_HI_HZ, sampleRate = SAMPLE_RATE, fftSize = FFT_SIZE } = {}) {
  const binHz = sampleRate / fftSize
  let lo = Math.max(0, Math.floor(bandLo / binHz))
  const hi = Math.min(freqData.length - 1, Math.floor(bandHi / binHz))
  if (hi <= lo) return { db: byteToDb(freqData[lo] || 0), dominantHz: 0, peakDb: -100, bandAvgDb: -100, narrowband: false }

  let peak = -Infinity
  let peakBin = -1
  let sum = 0
  for (let b = lo; b <= hi; b++) {
    const v = freqData[b]
    sum += v
    if (v > peak) {
      peak = v
      peakBin = b
    }
  }
  const bandAvg = sum / (hi - lo + 1)
  const peakDb = byteToDb(peak)
  const bandAvgDb = byteToDb(bandAvg)
  const narrowband = peak - bandAvg >= NARROWBAND_GAP_DB && peakDb >= PEAK_DB_THRESHOLD
  return {
    db: peakDb,
    dominantHz: peakBin >= 0 ? peakBin * binHz : 0,
    peakDb,
    bandAvgDb,
    narrowband,
  }
}

// Classify a rolling window of frames (from analyzeFrame) as siren or not.
// history: array of { t, dominantHz, narrowband, peakDb }. Returns
//   { siren, score (0-1), freqJumps }
export function classifySiren(history, { jumpHz = MIN_FREQ_JUMP_HZ, minSwitches = MIN_TONE_SWITCHES } = {}) {
  const now = history.length ? history[history.length - 1].t : 0
  const win = history.filter((f) => now - f.t <= SIREN_ACTIVE_WINDOW_MS)
  if (win.length < 4) return { siren: false, score: 0, freqJumps: 0 }

  // Sustained wall-clock span is required: a 400 ms blip is not a siren.
  const spanMs = win[win.length - 1].t - win[0].t
  if (spanMs < SIREN_MIN_SPAN_MS) return { siren: false, score: 0, freqJumps: 0 }

  const narrowCount = win.filter((f) => f.narrowband).length
  const loud = win.every((f) => f.peakDb >= PEAK_DB_THRESHOLD) || narrowCount / win.length >= 0.7
  if (!loud) return { siren: false, score: 0, freqJumps: 0 }

  // Count "tone switches": transitions where the dominant freq jumps by >= jumpHz
  // between consecutive frames (the two-tone alternation / wail sweep).
  let freqJumps = 0
  let prev = null
  for (const f of win) {
    if (prev !== null && f.dominantHz > 0 && Math.abs(f.dominantHz - prev) >= jumpHz) freqJumps++
    prev = f.dominantHz
  }

  const siren = freqJumps >= minSwitches
  const score = siren ? Math.min(1, 0.4 + 0.3 * (freqJumps / (minSwitches + 2))) : 0
  return { siren, score: Math.round(score * 100) / 100, freqJumps }
}