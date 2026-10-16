const TYPE_COLORS = {
  fatigue: '#22d3ee',
  talkback: '#f87171',
  talkback_done: '#34d399',
  crash: '#fb923c',
  ambulance: '#fbbf24',
  pothole: '#a78bfa',
}

export default function TelemetryFeed({ feed, connected }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>TELEMETRY FEED · KAFKA/WSS</h2>
        <span className={`pill ${connected ? 'pill-ok' : 'pill-bad'}`}>
          {connected ? 'STREAMING' : 'DISCONNECTED'}
        </span>
      </div>

      {feed.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">⇄</span>
          <p>Waiting for telemetry…</p>
        </div>
      ) : (
        <div className="feed-list">
          {feed.map((m, i) => (
            <div key={i} className="feed-item">
              <span className="feed-time">{m.label}</span>
              <span className="feed-type" style={{ color: TYPE_COLORS[m.type] ?? '#94a3b8' }}>
                {m.type}
              </span>
              <code className="feed-json">{JSON.stringify(pick(m))}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function pick(m) {
  switch (m.type) {
    case 'fatigue':
      return { score: m.score, perclos: m.perclos, tier: m.tier, source: m.source, nod: m.nod?.droopActive ?? false }
    case 'talkback':
      return { question: m.question, elapsed: m.elapsed }
    case 'talkback_done':
      return { outcome: m.outcome }
    case 'crash':
      return { id: m.id, verified: m.verified, g: m.gForce, db: m.db, source: m.detection_source }
    case 'ambulance':
      return { id: m.id, stage: m.stage, source: m.detection_source ?? m.source, hz: m.siren_freq_hz }
    case 'pothole':
      return { id: m.id, volume: m.volume, cost: m.cost, source: m.detection_source }
    default:
      return {}
  }
}
