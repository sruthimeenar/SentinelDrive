import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

const TIER_COLORS = {
  safe: '#34d399',
  moderate: '#fbbf24',
  critical: '#f87171',
}

const TIER_LABEL = {
  safe: 'SAFE',
  moderate: 'MODERATE',
  critical: 'CRITICAL',
}

const CAM_LABEL = {
  idle: 'CAMERA IDLE',
  requesting: 'REQUESTING CAMERA…',
  loading: 'LOADING MODEL…',
  running: 'CAMERA LIVE',
  'no-face': 'NO FACE DETECTED',
  denied: 'CAMERA PERMISSION DENIED',
  unsupported: 'NO CAMERA FOUND',
  error: 'CAMERA ERROR',
}

export default function FatiguePanel({ history, latest, source, cam }) {
  const tier = latest?.tier ?? 'safe'
  const color = TIER_COLORS[tier]
  const score = latest?.score ?? 0
  const perclos = latest?.perclos ?? 0
  const realInput = source === 'camera'
  const nod = latest?.nod

  return (
    <section className="card span-2">
      <div className="card-head">
        <h2>EDGE CV · DRIVER FATIGUE</h2>
        <span className="tier-badge" style={{ backgroundColor: color }}>
          {TIER_LABEL[tier]}
        </span>
      </div>

      <div className="source-strip">
        <span className={`source-tag ${realInput ? 'source-real' : 'source-fallback'}`}>
          {realInput
            ? latest?.face === false
              ? 'CAMERA LIVE · NO FACE IN FRAME'
              : 'REAL PERCLOS + HEAD POSE · BROWSER CAMERA'
            : 'SIMULATED — CAMERA INACTIVE'}
        </span>
        <span className="source-tag cam-tag">{CAM_LABEL[cam] ?? cam}</span>
      </div>

      <div className="fatigue-metrics">
        <div className="metric">
          <span className="metric-label">FATIGUE SCORE</span>
          <span className="metric-value" style={{ color }}>
            {score.toFixed(1)}
          </span>
          <span className="metric-sub">/ 10 · PERCI-OS</span>
        </div>
        <div className="metric">
          <span className="metric-label">PERCLOS</span>
          <span className="metric-value">{perclos.toFixed(2)}</span>
          <span className="metric-sub">eye-closure ratio · 60s</span>
        </div>
        <div className="metric">
          <span className="metric-label">HEAD DROOP</span>
          <span className={`metric-value ${nod?.droopActive ? 'droop-active' : ''}`}>
            {nod?.droopActive ? `${(nod.droopSustainedMs / 1000).toFixed(1)}s` : nod ? '—' : '—'}
          </span>
          <span className="metric-sub">
            {nod ? `pitch ${nod.pitchDeg?.toFixed(1) ?? '—'}° · ratio ${nod.droopRatio?.toFixed(3) ?? '—'}` : 'camera off — n/a'}
          </span>
        </div>
      </div>

      <div className="chart">
        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={history} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
            <XAxis dataKey="label" stroke="#64748b" fontSize={10} minTickGap={40} />
            <YAxis yAxisId="score" domain={[0, 10]} stroke="#64748b" fontSize={10} />
            <YAxis yAxisId="perclos" orientation="right" domain={[0, 1]} stroke="#64748b" fontSize={10} />
            <Tooltip contentStyle={{ background: '#0b0f17', border: '1px solid #1f2937', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line yAxisId="score" type="monotone" dataKey="score" stroke="#22d3ee" dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line yAxisId="perclos" type="monotone" dataKey="perclos" stroke="#a78bfa" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="tier-scale">
        {[
          ['safe', '0 — 4.9', 'HUD + soft tones'],
          ['moderate', '5 — 7.9', 'visual alerts'],
          ['critical', '8+', 'talk-back'],
        ].map(([t, range, desc]) => (
          <div key={t} className={`tier-scale-item ${t === tier ? 'active' : ''}`}>
            <span className="bar" style={{ backgroundColor: TIER_COLORS[t] }} />
            <span className="tier-name">{t}</span>
            <span className="tier-range">{range}</span>
            <span className="tier-desc">{desc}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
