import { useRef } from 'react'

export default function TalkBackCard({ talkback, transcript, heard, listening, speaking, voiceSupported, onManualAnswer }) {
  const inputRef = useRef(null)

  if (!talkback) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>COGNITIVE TALK-BACK</h2>
          <span className="pill pill-muted">STANDBY</span>
        </div>
        <div className="empty-state">
          <span className="empty-icon">▮</span>
          <p>Monitoring… interactive vocal challenge arms when fatigue score ≥ 8.</p>
        </div>
      </section>
    )
  }

  const pct = Math.min(100, (talkback.elapsed / talkback.max_ticks) * 100)
  const beeping = talkback.phase === 'beeping'

  const manualSend = () => {
    const el = inputRef.current
    if (!el || !el.value.trim()) return
    onManualAnswer(el.value)
    el.value = ''
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>COGNITIVE TALK-BACK</h2>
        <span className="pill pill-crit">ACTIVE</span>
      </div>

      {talkback.answered ? (
        <div className="talkback-result">
          <div className="spinner" />
          <p className="tb-question">{talkback.question}</p>
          {talkback.correct ? (
            <p className="tb-status ok">Correct — spoken answer verified. Congratulations!</p>
          ) : talkback.outcome === 'no_answer' ? (
            <p className="tb-status warn">No correct answer received — alarm sounded until alert. Driver re-engaged.</p>
          ) : (
            <p className="tb-status ok">Response captured — prefrontal cortex activation confirmed.</p>
          )}
          {talkback.transcript && <p className="tb-transcript">You said: “{talkback.transcript}”{talkback.parsedAnswer != null ? ` → ${talkback.parsedAnswer}` : ''}</p>}
        </div>
      ) : beeping ? (
        <div className="talkback-result">
          <span className="siren tb-siren" />
          <p className="tb-question">{talkback.question}</p>
          <p className="tb-alert-text">NO ANSWER RECEIVED — LOUD ALARM ACTIVE</p>
          <p className="tb-note">Alternating 2000–4000 Hz alarm continues until fatigue score drops below 5.</p>
          {transcript && <p className="tb-transcript">Heard: “{transcript}”</p>}
        </div>
      ) : (
        <div className="talkback-result">
          <div className="pulse-bars">
            <span />
            <span />
            <span />
          </div>
          <p className="tb-question">{talkback.question}</p>
          {speaking && <p className="tb-voice speaking">SPEAKING QUESTION ALOUD…</p>}
          <p className="tb-sub">Requires 5s verbal STT response</p>
          <div className="tb-timer">
            <div className="tb-timer-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="tb-status">{talkback.elapsed}s / {talkback.max_ticks}s</p>

          {voiceSupported ? (
            <p className="tb-voice">
              <span className={`listen-dot ${listening ? 'live' : ''}`} />
              {listening ? 'LISTENING FOR YOUR ANSWER…' : 'MIC STARTING…'}
            </p>
          ) : (
            <div className="tb-manual">
              <p className="tb-note">Speech recognition unsupported — type your answer:</p>
              <div className="tb-manual-row">
                <input ref={inputRef} placeholder="e.g. seven or 7" onKeyDown={(e) => { if (e.key === 'Enter') manualSend() }} />
                <button className="btn" onClick={manualSend}>Send</button>
              </div>
            </div>
          )}
          {transcript && <p className="tb-transcript">Heard: “{transcript}”</p>}
          {heard !== null && <p className="tb-heard">Parsed answer: {heard}</p>}
          <p className="tb-note">Wrong answer re-prompts; no answer triggers a pulsed 2000–4000 Hz alarm until alert again.</p>
        </div>
      )}
    </section>
  )
}
