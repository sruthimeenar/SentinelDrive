import { useCallback, useEffect, useRef, useState } from 'react'

// English number-word mapping for parsing spoken answers ("seven" -> 7).
const WORD_TO_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
}

// Extracts the last number-like value from a speech transcript. Handles digit
// strings, number words, tens+unit compounds ("forty two" -> 42), and a
// leading "minus/negative" prefix ("minus three" -> -3). Taking the LAST value
// is the right heuristic here: the driver answers after the question, so
// "What is 12 minus 5?" + "seven" -> [12, 5, 7] -> 7.
export function parseSpokenNumber(text) {
  if (!text) return null
  const tokens = text.toLowerCase().replace(/[.,?!;]/g, ' ').split(/\s+/).filter(Boolean)
  const values = []
  let pendingNeg = false
  let pendingTens = null
  const push = (n) => {
    values.push(pendingNeg ? -n : n)
    pendingNeg = false
  }
  for (const t of tokens) {
    if (t === 'minus' || t === 'negative') {
      // Only a leading minus negates (a true "minus three" answer); mid-phrase
      // "X minus Y" is a subtraction expression, not a negative value.
      if (values.length === 0 && pendingTens === null) pendingNeg = true
      continue
    }
    let n = null
    if (/^-?\d+$/.test(t)) n = parseInt(t, 10)
    else if (Object.prototype.hasOwnProperty.call(WORD_TO_NUM, t)) n = WORD_TO_NUM[t]
    if (n === null) continue
    if (n >= 20 && n <= 90 && n % 10 === 0) {
      if (pendingTens !== null) push(pendingTens)
      pendingTens = n
    } else if (pendingTens !== null && n >= 1 && n <= 9) {
      push(pendingTens + n)
      pendingTens = null
    } else {
      if (pendingTens !== null) {
        push(pendingTens)
        pendingTens = null
      }
      push(n)
    }
  }
  if (pendingTens !== null) push(pendingTens)
  return values.length ? values[values.length - 1] : null
}

// Challenge behaviour:
//  - The question is spoken once; answer capture is armed only after the TTS
//    finishes (or 3s), so the echoed question is never mistaken for an answer.
//  - Every parsed number is sent to the backend as {type: "talkback_answer"};
//    the BACKEND verifies it. Correct -> talkback_done(correct). Wrong ->
//    talkback_retry -> we pulse once, re-speak the question, and re-arm.
//  - No answer within the window -> backend escalates phase to "beeping" ->
//    we loop a loud alternating 2000/4000 Hz alarm until talkback_done.
export default function useVoiceTalkBack({ talkback, onAnswer, beeping, retryCount }) {
  const [transcript, setTranscript] = useState('')
  const [heard, setHeard] = useState(null)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [supported] = useState(() => {
    if (typeof window === 'undefined') return false
    const rec = window.SpeechRecognition || window.webkitSpeechRecognition
    return Boolean(rec && 'speechSynthesis' in window)
  })

  const SpeechRec = typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined

  const talkbackRef = useRef(talkback)
  const spokenIdRef = useRef(null)
  const answeredIdRef = useRef(null)
  const answersActiveRef = useRef(false)
  const lastSentRef = useRef(null)
  const armTimerRef = useRef(0)
  const recRef = useRef(null)
  const audioCtxRef = useRef(null)
  const beeperTimerRef = useRef(0)
  const mediaRecRef = useRef(null)
  const micStreamRef = useRef(null)
  const audioChunksRef = useRef([])

  // --- Web Audio helpers ----------------------------------------------------
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      audioCtxRef.current = new Ctx()
      audioCtxRef.current.resume?.()
    }
    return audioCtxRef.current
  }, [])

  const tone = useCallback((ctx, t, freq, dur, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(vol, t)
    gain.gain.setValueAtTime(0.0001, t + dur)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }, [])

  const startBeeper = useCallback(() => {
    if (beeperTimerRef.current) return
    const ctx = getAudioCtx()
    if (!ctx) return
    const cycle = () => {
      const t0 = ctx.currentTime
      tone(ctx, t0, 2000, 0.18, 0.5)
      tone(ctx, t0 + 0.22, 4000, 0.18, 0.5)
    }
    cycle()
    beeperTimerRef.current = setInterval(cycle, 640)
  }, [getAudioCtx, tone])

  const stopBeeper = useCallback(() => {
    clearInterval(beeperTimerRef.current)
    beeperTimerRef.current = 0
  }, [])

  const playRetryPulse = useCallback(() => {
    const ctx = getAudioCtx()
    if (!ctx) return
    tone(ctx, ctx.currentTime, 1000, 0.25, 0.4)
  }, [getAudioCtx, tone])

  // --- Speech helpers -------------------------------------------------------
  const speak = useCallback((text, onend) => {
    if (!('speechSynthesis' in window)) {
      onend?.()
      return
    }
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1
    u.pitch = 1
    u.onstart = () => setSpeaking(true)
    const finish = () => {
      setSpeaking(false)
      onend?.()
    }
    u.onend = finish
    u.onerror = finish
    window.speechSynthesis.speak(u)
  }, [])

  // --- Audio capture (best-effort): records the driver's spoken answer so it
  // can be stored with the talk-back event for review. Bounded to a few
  // seconds; returns a base64 data URL or null when the mic is unavailable.
  const startAudioRecording = useCallback(() => {
    if (mediaRecRef.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        micStreamRef.current = stream
        const rec = new MediaRecorder(stream)
        audioChunksRef.current = []
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) audioChunksRef.current.push(e.data)
        }
        rec.start()
        mediaRecRef.current = rec
        // Bound the capture so a stuck session can't record forever.
        setTimeout(() => {
          if (mediaRecRef.current) stopAudioRecording()
        }, 8000)
      })
      .catch(() => { /* mic denied — transcript still works */ })
  }, [])

  const stopAudioRecording = useCallback(() => {
    const rec = mediaRecRef.current
    mediaRecRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    if (!rec) return null
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' })
        audioChunksRef.current = []
        if (blob.size > 300 * 1024) return resolve(null) // cap stored audio
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      }
      try {
        rec.stop()
      } catch {
        resolve(null)
      }
    })
  }, [])

  // Arms answer capture once the question has finished being spoken, so the
  // TTS echo cannot be parsed as the driver's answer.
  const armAnswers = useCallback((id) => {
    const tb = talkbackRef.current
    if (!tb || tb.id !== id || tb.answered) return
    answersActiveRef.current = true
    startAudioRecording()
  }, [startAudioRecording])

  const stopRecognition = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    if (rec) {
      try { rec.stop() } catch { /* ignore */ }
    }
    setListening(false)
  }, [])

  const startRecognition = useCallback(() => {
    if (!SpeechRec || recRef.current) return
    const rec = new SpeechRec()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    rec.onresult = (e) => {
      let t = ''
      for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript
      t = t.trim()
      setTranscript(t)

      const tb = talkbackRef.current
      if (!tb || tb.answered || !answersActiveRef.current) return

      const parsed = parseSpokenNumber(t)
      if (parsed === null) return
      if (lastSentRef.current === parsed) return
      lastSentRef.current = parsed
      setHeard(parsed)
      const audioP = stopAudioRecording()
      const sendAnswer = (audio) => {
        onAnswer({ id: tb.id, answer: parsed, transcript: t, audio, transcription: 'speech' })
      }
      if (audioP) audioP.then(sendAnswer)
      else sendAnswer(null)
    }

    rec.onerror = () => { /* transient errors; keep session alive */ }

    rec.onend = () => {
      if (recRef.current !== rec) return
      setListening(false)
      const tb = talkbackRef.current
      if (!tb || tb.answered) return
      // Session died without resolving (e.g. browser hiccup); restart it
      // while the challenge is still active.
      setTimeout(() => {
        if (recRef.current === null && talkbackRef.current && !talkbackRef.current.answered) {
          startRecognition()
        }
      }, 400)
    }

    try {
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch {
      recRef.current = null
      setListening(false)
    }
  }, [SpeechRec, onAnswer])

  // Speak the challenge question when a new challenge arrives.
  useEffect(() => {
    talkbackRef.current = talkback

    if (!talkback || !talkback.id) {
      stopRecognition()
      return
    }
    if (talkback.answered) {
      stopRecognition()
      stopAudioRecording()
      if (talkback.correct && answeredIdRef.current !== talkback.id) {
        answeredIdRef.current = talkback.id
        speak('Congratulations!')
      }
      return
    }
    if (spokenIdRef.current === talkback.id) return

    spokenIdRef.current = talkback.id
    answersActiveRef.current = false
    lastSentRef.current = null
    setTranscript('')
    setHeard(null)
    speak(talkback.question, () => armAnswers(talkback.id))
    clearTimeout(armTimerRef.current)
    armTimerRef.current = setTimeout(() => armAnswers(talkback.id), 3000)
    startRecognition()
  }, [talkback, speak, armAnswers, startRecognition, stopRecognition])

  // Wrong answer -> backend emitted talkback_retry: pulse once, re-prompt.
  useEffect(() => {
    if (retryCount === 0) return
    const tb = talkbackRef.current
    if (!tb || !tb.id || tb.answered) return
    playRetryPulse()
    answersActiveRef.current = false
    lastSentRef.current = null
    stopAudioRecording()
    setTranscript('')
    setHeard(null)
    speak(tb.question, () => armAnswers(tb.id))
    clearTimeout(armTimerRef.current)
    armTimerRef.current = setTimeout(() => armAnswers(tb.id), 3000)
  }, [retryCount, playRetryPulse, speak, armAnswers, stopAudioRecording])

  // No answer -> beeping phase: loud alternating alarm until talkback_done.
  useEffect(() => {
    if (beeping) startBeeper()
    else stopBeeper()
  }, [beeping, startBeeper, stopBeeper])

  useEffect(() => () => {
    try { recRef.current?.stop() } catch { /* ignore */ }
    stopAudioRecording()
    clearTimeout(armTimerRef.current)
    clearInterval(beeperTimerRef.current)
    try { audioCtxRef.current?.close() } catch { /* ignore */ }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [stopAudioRecording])

  // Manual fallback for browsers without SpeechRecognition: type the answer.
  const submitTextAnswer = useCallback((text) => {
    const tb = talkbackRef.current
    if (!tb || tb.answered || !answersActiveRef.current) return
    const parsed = parseSpokenNumber(text)
    if (parsed === null) return
    if (lastSentRef.current === parsed) return
    lastSentRef.current = parsed
    setHeard(parsed)
    setTranscript(text.trim())
    onAnswer({ id: tb.id, answer: parsed, transcript: text.trim(), audio: null, transcription: 'manual' })
  }, [onAnswer])

  return { transcript, heard, listening, speaking, supported, submitTextAnswer }
}
