import { useCallback } from 'react'
import useSentinelSocket from './hooks/useSentinelSocket'
import useFatigueDetector from './hooks/useFatigueDetector'
import useSirenDetector from './hooks/useSirenDetector'
import useVoiceTalkBack from './hooks/useVoiceTalkBack'
import useCrashDetector from './hooks/useCrashDetector'
import useSpokenGuidance from './hooks/useSpokenGuidance'
import Header from './components/Header'
import FatiguePanel from './components/FatiguePanel'
import TalkBackCard from './components/TalkBackCard'
import AmbulanceCard from './components/AmbulanceCard'
import CrashFeed from './components/CrashFeed'
import PotholePortal from './components/PotholePortal'
import TelemetryFeed from './components/TelemetryFeed'
import CamPreview from './components/CamPreview'

export default function App() {
  const socket = useSentinelSocket()
  const cam = useFatigueDetector(socket.send, socket.connected)
  const siren = useSirenDetector(socket.send, socket.connected)

  const handleTalkBackAnswer = useCallback((payload) => {
    socket.send({ type: 'talkback_answer', ...payload })
  }, [socket.send])

  const voice = useVoiceTalkBack({
    talkback: socket.talkback,
    onAnswer: handleTalkBackAnswer,
    beeping: socket.beeping,
    retryCount: socket.retryCount,
  })

  useSpokenGuidance(socket.ambulance)

  const crash = useCrashDetector(socket.send, socket.connected, () => ({
    score: socket.latestFatigue?.score ?? null,
    tier: socket.latestFatigue?.tier ?? null,
    source: socket.fatigueSource,
  }))

  return (
    <div className="app">
      <Header connected={socket.connected} tier={socket.latestFatigue?.tier} />
      <main className="grid">
        <FatiguePanel
          history={socket.fatigueHistory}
          latest={socket.latestFatigue}
          source={socket.fatigueSource}
          cam={cam.status}
        />
        <TalkBackCard
          talkback={socket.talkback}
          transcript={voice.transcript}
          heard={voice.heard}
          listening={voice.listening}
          speaking={voice.speaking}
          voiceSupported={voice.supported}
          onManualAnswer={voice.submitTextAnswer}
        />
        <AmbulanceCard ambulance={socket.ambulance} siren={siren.status} />
        <CrashFeed crashes={socket.crashes} detector={crash} />
        <PotholePortal potholes={socket.potholes} />
        <TelemetryFeed feed={socket.feed} connected={socket.connected} />
      </main>
      <CamPreview stream={cam.stream} status={cam.status} debug={cam.debug} />
    </div>
  )
}
