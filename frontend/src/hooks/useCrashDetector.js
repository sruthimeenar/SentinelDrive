import { useCallback, useEffect, useRef, useState } from 'react'

// DeviceMotion accelerometer crash detection. Reports a `crash_candidate`
// (real g-force spike + GPS + fatigue context) to the backend, which runs the
// multimodal verification. Thresholds here only decide when to *report*; the
// backend decides verify vs suppress.
const G_REPORT_THRESHOLD = 2.5 // report once the rolling peak crosses this
const PEAK_WINDOW_MS = 600 // peak decays if no new sample strengthens it
const DEBOUNCE_MS = 8000 // min gap between candidate reports
const LAST_G_UI_MS = 500 // throttle UI updates so React isn't flooded at 60 Hz
const GPS_SPEED_PRIOR_MS = 2000 // GPS reading at least this old = "speed before"

export default function useCrashDetector(send, connected, getFatigue) {
  const [supported, setSupported] = useState(false)
  const [armed, setArmed] = useState(false)
  const [triggerCount, setTriggerCount] = useState(0)
  const [lastG, setLastG] = useState(null)

  const getFatigueRef = useRef(getFatigue)
  getFatigueRef.current = getFatigue

  const st = useRef({
    peak: 0,
    peakAt: 0,
    lastSend: 0,
    lastGShown: 0,
    gps: null,
    gpsPrior: null,
    priorAt: 0,
    listener: null,
    watchId: null,
  }).current

  const report = useCallback(
    (peak) => {
      const now = Date.now()
      if (now - st.lastSend < DEBOUNCE_MS) return
      st.lastSend = now
      const fatigue = typeof getFatigueRef.current === 'function' ? getFatigueRef.current() : null
      let gps = null
      if (st.gps) {
        const prior = st.gpsPrior
        gps = {
          lat: st.gps.lat,
          lng: st.gps.lng,
          speed_kmh: st.gps.speed_kmh,
          speed_prior_kmh: prior ? prior.speed_kmh : null,
        }
      }
      if (connected && send) {
        send({ type: 'crash_candidate', gForce: peak, ts: now, gps, fatigue })
      }
      setTriggerCount((c) => c + 1)
    },
    [send, connected, st],
  )

  const onMotion = useCallback(
    (e) => {
      const a = e.accelerationIncludingGravity
      if (!a) return
      const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0) / 9.81
      const now = Date.now()
      if (now - st.lastGShown >= LAST_G_UI_MS) {
        st.lastGShown = now
        setLastG(mag)
      }
      if (now - st.peakAt > PEAK_WINDOW_MS) st.peak = 0
      st.peak = Math.max(st.peak, mag)
      st.peakAt = now
      if (st.peak >= G_REPORT_THRESHOLD) report(st.peak)
    },
    [report, st],
  )

  useEffect(() => {
    if (!('DeviceMotionEvent' in window)) return
    const arm = () => {
      window.addEventListener('devicemotion', onMotion)
      st.listener = onMotion
      setSupported(true)
      setArmed(true)
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then((s) => {
        if (s === 'granted') arm()
      })
    } else {
      arm()
    }

    if ('geolocation' in navigator) {
      st.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const now = Date.now()
          const sp = pos.coords.speed != null ? pos.coords.speed * 3.6 : null
          if (st.gps && now - st.priorAt >= GPS_SPEED_PRIOR_MS) st.gpsPrior = st.gps
          st.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, speed_kmh: sp }
          st.priorAt = now
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 1000 },
      )
    }

    return () => {
      if (st.listener) window.removeEventListener('devicemotion', st.listener)
      if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId)
    }
  }, [onMotion, st])

  return { supported, armed, triggerCount, lastG }
}
