const TIER_COLORS = {
  safe: '#34d399',
  moderate: '#fbbf24',
  critical: '#f87171',
}

export default function Header({ connected, tier }) {
  const tierColor = TIER_COLORS[tier] ?? '#34d399'

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" />
        <div>
          <h1>SENTINELDRIVE</h1>
          <p>Next-Gen AI &amp; Telematics Ecosystem — Road Safety · Collision Mitigation · Municipal Dispatch</p>
        </div>
      </div>
      <div className="pills">
        <span className={`pill ${connected ? 'pill-ok' : 'pill-bad'}`}>
          <span className="dot" /> {connected ? 'LIVE' : 'OFFLINE'}
        </span>
        <span className="pill" style={{ borderColor: tierColor, color: tierColor }}>
          DRIVER TIER · {tier ? tier.toUpperCase() : '—'}
        </span>
        <span className="pill pill-muted">EDGE CV</span>
        <span className="pill pill-muted">KAFKA</span>
        <span className="pill pill-muted">PWD PORTAL</span>
      </div>
    </header>
  )
}
