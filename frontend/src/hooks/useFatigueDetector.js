import { useEffect, useRef, useState } from 'react'
import {
  EYES,
  EAR_CLOSED_THRESHOLD,
  PERCLOS_WINDOW_MS,
  eyeEAR,
  headDroopRatio,
  pitchDegFromMatrix,
  combineFatigue,
  isDrooping,
} from '../lib/fatigue'

// How often the detected PERCLOS/score is pushed up to the backend.
const SEND_INTERVAL_MS = 1000

// If no face has been seen for this long, stop sending camera telemetry — the
// backend then flips the source to the labeled "simulated" walk. We still keep
// the camera stream OPEN so a face re-entering the frame resumes real data
// instantly.
const MAX_NO_FACE_MS = 3500

// Face geometry requires outputFacialTransformationMatrixes: true; gives the
// 4x4 rotation matrix for head-pose pitch corroboration. (Note the exact API
// name — the option is outputFacialTransformationMatrixes and the result field
// is facialTransformationMatrixes[].data in @mediapipe/tasks-vision.)
const MODEL_OPTIONS = {
  baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
  runningMode: 'VIDEO',
  numFaces: 1,
  outputFacialTransformationMatrixes: true,
}

export default function useFatigueDetector(send, connected) {
  const [status, setStatus] = useState('idle')
  const [stream, setStream] = useState(null)
  // Live debug snapshot shown in the camera preview overlay + console. Null
  // until the first analysis tick completes.
  const [debug, setDebug] = useState(null)
  const st = useRef({
    landmarker: null,
    video: null,
    stream: null,
    samples: [],
    lastEar: { l: 0, r: 0 },
    lastFaceAt: 0,
    closedSince: 0, // when a continuous eye-closure streak started (0 = eyes open)
    droopSince: 0, // when a continuous head-droop streak started (0 = head upright)
    lastSend: 0,
    raf: 0,
    timer: 0,
  }).current

  // LIVE CONNECTED REF: `connected` is state that flips as the WS opens AFTER
  // this effect mounts, but the setInterval below closes over the mount-time
  // value (useEffect deps []). Using a ref keeps the send gate truthful without
  // restarting the whole camera/model pipeline.
  const connectedRef = useRef(connected)
  connectedRef.current = connected

  useEffect(() => {
    let cancelled = false
    setStatus('requesting')

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        st.stream = stream
        setStream(stream)

        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        video.playsInline = true
        await video.play()
        st.video = video
        setStatus('loading')

        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks('/wasm')
        let landmarker
        try {
          landmarker = await FaceLandmarker.createFromOptions(vision, MODEL_OPTIONS)
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(vision, {
            ...MODEL_OPTIONS,
            baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
          })
        }
        if (cancelled) {
          landmarker.close()
          return
        }
        st.landmarker = landmarker
        setStatus('running')

        const detect = () => {
          if (cancelled) return
          st.raf = requestAnimationFrame(detect)
          if (!st.landmarker || st.video.readyState < 2 || st.video.videoWidth === 0) return
          const res = st.landmarker.detectForVideo(st.video, performance.now())
          if (res.faceLandmarks && res.faceLandmarks.length > 0) {
            const lm = res.faceLandmarks[0]
            const earL = eyeEAR(lm, EYES.left)
            const earR = eyeEAR(lm, EYES.right)
            const ear = (earL + earR) / 2
            st.lastEar = { l: earL, r: earR }
            const closed = ear < EAR_CLOSED_THRESHOLD
            // Head-pose pitch from the face-geometry rotation matrix. The API
            // exposes it as facialTransformationMatrixes[].data (a Matrix[]).
            let pitchDeg = 0
            if (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length) {
              pitchDeg = pitchDegFromMatrix(res.facialTransformationMatrixes[0].data)
            }
            const droop = isDrooping(lm, pitchDeg)
            const now = Date.now()
            st.samples.push({ t: now, closed, droop, droopRatio: headDroopRatio(lm), pitchDeg, earL, earR })
            st.lastFaceAt = now
            // Maintain continuous streak timers for sustained signals.
            if (closed && st.closedSince === 0) st.closedSince = now
            if (!closed) st.closedSince = 0
            if (droop && st.droopSince === 0) st.droopSince = now
            if (!droop) st.droopSince = 0
          }
        }
        st.raf = requestAnimationFrame(detect)

        st.timer = setInterval(() => {
          if (cancelled) return
          const now = Date.now()
          st.samples = st.samples.filter((s) => now - s.t <= PERCLOS_WINDOW_MS)
          if (now - st.lastFaceAt > MAX_NO_FACE_MS) {
            // No face in frame: keep the camera stream live but stop reporting
            // (backend flips to the labeled simulated walk after its TTL).
            setStatus('no-face')
            return
          }
          if (st.samples.length === 0) {
            setStatus('running')
            return
          }
          const closed = st.samples.filter((s) => s.closed).length
          const perclos = closed / st.samples.length
          const latest = st.samples[st.samples.length - 1]
          const closedStreakMs = st.closedSince ? now - st.closedSince : 0
          const droopSustainedMs = st.droopSince ? now - st.droopSince : 0
          const fatigue = combineFatigue({
            perclos,
            closedStreakMs,
            droopActive: latest.droop,
            droopSustainedMs,
          })
          setStatus('running')
          const nod = {
            pitchDeg: Math.round(latest.pitchDeg * 10) / 10,
            droopRatio: Math.round(latest.droopRatio * 1000) / 1000,
            droopActive: latest.droop,
            droopSustainedMs,
          }

          // DEBUG OVERLAY / CONSOLE: live values every analysis tick so we can
          // see exactly where the signal chain is breaking. Remove or gate
          // behind a flag once confirmed working.
          const snapshot = {
            earL: Math.round(st.lastEar.l * 1000) / 1000,
            earR: Math.round(st.lastEar.r * 1000) / 1000,
            earAvg: Math.round(((st.lastEar.l + st.lastEar.r) / 2) * 1000) / 1000,
            closed,
            perclos: Math.round(perclos * 1000) / 1000,
            closedFrames: closed,
            totalFrames: st.samples.length,
            closedStreakMs,
            pitchDeg: Math.round(latest.pitchDeg * 10) / 10,
            headDroopRatio: Math.round(latest.droopRatio * 1000) / 1000,
            droopActive: latest.droop,
            droopSustainedMs,
            eyeScore: fatigue.eyeScore,
            closureBonus: fatigue.closureBonus,
            nodScore: fatigue.nodScore,
            score: fatigue.score,
            tier: fatigue.tier,
          }
          console.log('[fatigue-debug]', JSON.stringify(snapshot))
          setDebug(snapshot)

          // Send only when the WS is actually open (live ref, not mount-time
          // value). `send` itself is a safe no-op while disconnected.
          if (connectedRef.current && send) {
            send({
              type: 'fatigue',
              score: fatigue.score,
              perclos: Math.round(perclos * 1000) / 1000,
              tier: fatigue.tier,
              source: 'camera',
              face: true,
              nod,
              ts: now,
            })
          }
          st.lastSend = now
        }, SEND_INTERVAL_MS)
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
      cancelAnimationFrame(st.raf)
      st.landmarker?.close()
      st.stream?.getTracks().forEach((t) => t.stop())
      st.video?.remove()
      st.landmarker = null
      st.video = null
      st.stream = null
      setStream(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { status, stream, debug }
}