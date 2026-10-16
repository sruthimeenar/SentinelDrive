const STAGE_COLORS = {
  APPROACHING: '#22d3ee',
  GUIDING: '#fbbf24',
  CLEARED: '#34d399',
}

export default function AmbulanceCard({ ambulance, siren = 'idle' }) {
  if (!ambulance) {
    const micState =
      siren === 'running' ? 'LISTENING' : siren === 'denied' ? 'MIC DENIED' : siren === 'unsupported' ? 'MIC UNAVAILABLE' : siren === 'idle' ? 'INITIALIZING' : 'MIC ERROR'
    return (
      <section className="card">
        <div className="card-head">
          <h2>ACTIVE CLEAR GUIDANCE</h2>
          <span className="pill pill-muted">{micState}</span>
        </div>
        <div className="empty-state">
          <span className="empty-icon">▸</span>
          <p>Live microphone detects the two-tone siren pattern (frequency/pattern matching) and arms emergency guidance.</p>
        </div>
      </section>
    )
  }

  const color = STAGE_COLORS[ambulance.stage] ?? '#22d3ee'
  const audible = ambulance.detection_source === 'audio-siren'
  const freq = ambulance.siren_freq_hz

  return (
    <section className="card">
      <div className="card-head">
        <h2>ACTIVE CLEAR GUIDANCE</h2>
        <span className="pill" style={{ borderColor: color, color }}>
          {ambulance.stage}
        </span>
      </div>

      <div className="amb-main">
        <span className="siren" style={{ color }} />
        <div>
          <p className="amb-guidance">"{ambulance.guidance}"</p>
          {ambulance.stage === 'APPROACHING' && (
            <p className="amb-sub">{audible ? 'Two-tone siren detected in live audio' : `Emergency vehicle ≈ ${ambulance.distance} m behind`}</p>
          )}
          {freq && (
            <p className="amb-sub" style={{ color: '#94a3b8', fontSize: '11px' }}>
              dominant tone {Math.round(freq)} Hz · siren match {Math.round((ambulance.siren_score ?? 0) * 100)}%
            </p>
          )}
        </div>
      </div>

      <div className="amb-footer">
        <span className="corridor">
          <span className="dot" style={{ backgroundColor: ambulance.corridor ? '#34d399' : '#64748b' }} />
          Green-wave corridor {ambulance.corridor ? 'ARMED · MQTT preemption 500m' : 'IDLE'}
        </span>
        <span className="corridor">
          {audible ? 'SOURCE: AUDIO SIREN' : `Vehicle #${ambulance.id}`}
        </span>
      </div>
    </section>
  )
}