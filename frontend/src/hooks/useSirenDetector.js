import { useEffect, useRef, useState } from 'react'
import { analyzeFrame, classifySiren, SIREN_CLEAR_WINDOW_MS } from '../lib/siren'

// Analysis cadence: one FFT frame every ~120ms (4 Hz is plenty for a siren's
// slow two-tone alternation) — cheap on CPU.
const ANALYZE_INTERVAL_MS = 120
// Debounce: don't re-announce the same siren on every frame.
const MIN_REPORT_GAP_MS = 1500

export default function useSirenDetector(send, connected) {
  const [status, setStatus] = useState('idle')
  const st = useRef({
    ctx: null,
    analyser: null,
    data: null,
    history: [],
    lastActiveAt: 0,
    lastSent: 0,
    timer: 0,
  }).current

  // Live connected ref: `connected` flips after mount but the interval below
  // closes over the mount-time value (useEffect deps []), so gate on the ref.
  const connectedRef = useRef(connected)
  connectedRef.current = connected

  useEffect(() => {
    let cancelled = false

    async function setup() {
      if (!navigator.mediaDevices || !window.AudioContext) {
        if (!cancelled) setStatus('unsupported')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        source.connect(analyser)
        st.ctx = ctx
        st.analyser = analyser
        st.data = new Uint8Array(analyser.frequencyBinCount)
        setStatus('running')

        st.timer = setInterval(() => {
          if (cancelled) return
          const now = Date.now()
          analyser.getByteFrequencyData(st.data)
          const frame = analyzeFrame(st.data)
          st.history.push({ t: now, dominantHz: frame.dominantHz, narrowband: frame.narrowband, peakDb: frame.peakDb })
          st.history = st.history.filter((f) => now - f.t <= 6000)

          const res = classifySiren(st.history)
          if (res.siren) st.lastActiveAt = now

          // Report a siren only when it's (re)detected, debounced.
          const sirenJustStarted = res.siren && now - st.lastSent >= MIN_REPORT_GAP_MS
          // Clear only after a sustained quiet period following an active siren.
          const sirenEnded =
            !res.siren &&
            st.lastActiveAt > 0 &&
            now - st.lastActiveAt >= SIREN_CLEAR_WINDOW_MS &&
            now - st.lastSent >= SIREN_CLEAR_WINDOW_MS
          if (connectedRef.current && send) {
            if (sirenJustStarted) {
              st.lastSent = now
              send({
                type: 'ambulance_candidate',
                freq_hz: Math.round(frame.dominantHz),
                score: res.score,
                ts: now,
              })
            } else if (sirenEnded) {
              st.lastSent = now
              send({ type: 'ambulance_clear', ts: now })
            }
          }
        }, ANALYZE_INTERVAL_MS)
      } catch (err) {
        if (cancelled) return
        if (err && err.name === 'NotAllowedError') setStatus('denied')
        else if (err && err.name === 'NotFoundError') setStatus('unsupported')
        else setStatus('error')
      }
    }

    setup()

    return () => {
      cancelled = true
      clearInterval(st.timer)
      st.ctx?.close()
      st.ctx = null
      st.analyser = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { status }
}