import { useEffect, useRef } from 'react'

// Speaks ambulance "move aside" guidance aloud via SpeechSynthesis whenever a
// new emergency-vehicle event (or a new guidance text) arrives. Same
// SpeechSynthesis path used by the cognitive talk-back, applied to guidance.
export default function useSpokenGuidance(ambulance) {
  const spokenKeyRef = useRef('')

  useEffect(() => {
    if (!ambulance || !ambulance.id || !ambulance.guidance) return
    const key = `${ambulance.id}:${ambulance.guidance}`
    if (spokenKeyRef.current === key) return
    spokenKeyRef.current = key
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(`Attention. ${ambulance.guidance}`)
    u.rate = 1
    u.pitch = 1
    window.speechSynthesis.speak(u)
  }, [ambulance])
}
