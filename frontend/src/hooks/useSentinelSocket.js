import { useCallback, useEffect, useRef, useState } from 'react'

function toTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function useSentinelSocket() {
  const [connected, setConnected] = useState(false)
  const [fatigueHistory, setFatigueHistory] = useState([])
  const [latestFatigue, setLatestFatigue] = useState(null)
  const [fatigueSource, setFatigueSource] = useState('simulated')
  const [talkback, setTalkback] = useState(null)
  const [beeping, setBeeping] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [crashes, setCrashes] = useState([])
  const [ambulance, setAmbulance] = useState(null)
  const [potholes, setPotholes] = useState([])
  const [feed, setFeed] = useState([])
  const wsRef = useRef(null)
  const sendRef = useRef(null)

  const send = useCallback((obj) => {
    sendRef.current?.(obj)
  }, [])

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      sendRef.current = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
      }
      // Rehydrate persisted history from PostGIS-backed endpoints so
      // dispatched potholes/crashes survive a backend restart.
      fetch('/api/potholes')
        .then((r) => r.json())
        .then((rows) => {
          if (Array.isArray(rows) && rows.length) setPotholes(rows)
        })
        .catch(() => {})
      fetch('/api/crashes')
        .then((r) => r.json())
        .then((rows) => {
          if (Array.isArray(rows) && rows.length) setCrashes(rows)
        })
        .catch(() => {})
    }
    ws.onclose = () => {
      setConnected(false)
      sendRef.current = null
    }
    ws.onerror = () => setConnected(false)

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      setFeed((f) => [...f.slice(-14), { label: toTime(msg.ts), type: msg.type, ...msg }])

      switch (msg.type) {
        case 'fatigue':
          setLatestFatigue({
            score: msg.score,
            perclos: msg.perclos,
            tier: msg.tier,
            source: msg.source === 'camera' ? 'camera' : 'simulated',
            face: !!msg.face,
            nod: msg.nod ?? null,
          })
          setFatigueSource(msg.source === 'camera' ? 'camera' : 'simulated')
          setFatigueHistory((h) => [...h.slice(-120), { label: toTime(msg.ts), score: msg.score, perclos: msg.perclos }])
          break
        case 'talkback':
          setBeeping(msg.phase === 'beeping')
          setTalkback(msg)
          break
        case 'talkback_retry':
          setRetryCount((c) => c + 1)
          break
        case 'talkback_done':
          setBeeping(false)
          setTalkback((t) => (t && t.id === msg.id ? { ...t, answered: true, outcome: msg.outcome, correct: msg.correct, transcript: msg.transcript, parsedAnswer: msg.parsedAnswer } : t))
          break
        case 'crash':
          setCrashes((c) => [msg, ...c].slice(0, 20))
          break
        case 'ambulance':
          setAmbulance(msg)
          break
        case 'pothole':
          setPotholes((p) => [msg, ...p].slice(0, 30))
          break
        default:
          break
      }
    }

    return () => ws.close()
  }, [])

  return { connected, send, fatigueHistory, latestFatigue, fatigueSource, talkback, beeping, retryCount, crashes, ambulance, potholes, feed }
}
