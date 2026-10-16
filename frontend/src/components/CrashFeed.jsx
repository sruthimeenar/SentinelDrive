function toTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function Sensor({ label, s }) {
  return (
    <div className={`verif-signal ${s.agree ? 'agree' : ''}`}>
      <span className="verif-label">{label}</span>
      <span className="verif-source">{s.source.toUpperCase()}</span>
      <span className="verif-value">
        {label === 'G-FORCE' && `${s.value} g`}
        {label === 'GPS' && `Δ${s.speed_delta_kmh} km/h`}
        {label === 'CAMERA' && s.fatigue_score != null ? `score ${s.fatigue_score}` : '—'}
      </span>
      <span className="verif-mark">{s.agree ? '✓ AGREE' : '✗'}</span>
    </div>
  )
}

function CrashItem({ c }) {
  const device = c.detection_source === 'device'
  return (
    <div className={`crash-item ${c.verified ? 'crash-verified' : 'crash-suppressed'}`}>
      <div className="crash-top">
        <span className={`pill ${c.verified ? 'pill-crit' : 'pill-ok'}`}>
          {c.verified ? 'VERIFIED · DISPATCH' : 'SUPPRESSED · NO DISPATCH'}
        </span>
        {device ? (
          <span className="badge badge-cam">DEVICE</span>
        ) : (
          <span className="badge badge-sim">SIMULATED</span>
        )}
        <span className="crash-time">{toTime(c.ts)}</span>
      </div>
      <div className="crash-sensors">
        <span>G-force <b>{c.gForce} g</b></span>
        <span>Acoustic <b>{c.db != null ? `${c.db} dB` : '—'}</b></span>
        <span>Frame crunch <b>{c.frameCrunch ? 'MATCH' : 'NO MATCH'}</b></span>
      </div>
      {c.verification && (
        <div className="verif-block">
          <p className="dl-label">MULTIMODAL VERIFICATION · {c.verification.mode.toUpperCase()}</p>
          <div className="verif-grid">
            <Sensor label="G-FORCE" s={c.verification.sensors.gForce} />
            <Sensor label="GPS" s={c.verification.sensors.gps} />
            <Sensor label="CAMERA" s={c.verification.sensors.camera} />
          </div>
          <p className="verif-rule">{c.verification.rule}</p>
          <p className="est-sub">Upgrade path: {c.verification.upgrade_path}</p>
        </div>
      )}
      {c.guidance && <p className="crash-guidance">Voice: "{c.guidance}"</p>}
      {!c.verified && !device && (
        <p className="crash-suppressed-note">Simulated single-sensor signals disagreed — emergency dispatch not fired.</p>
      )}
      {!c.verified && device && (
        <p className="crash-suppressed-note">Device impact spike lacked corroborating GPS or camera evidence — emergency dispatch not fired.</p>
      )}
    </div>
  )
}

export default function CrashFeed({ crashes, detector }) {
  const detectorState = detector?.armed
    ? 'DEVICE MOTION ARMED'
    : detector?.supported
      ? 'REQUIRES PERMISSION'
      : 'DEVICE MOTION UNAVAILABLE'
  const pillCls = detector?.armed ? 'pill-ok' : 'pill-muted'

  return (
    <section className="card span-2">
      <div className="card-head">
        <h2>MULTIMODAL CRASH ENGINE</h2>
        <div className="pills">
          <span className={`pill ${pillCls}`}>{detectorState}</span>
          {detector?.triggerCount > 0 && <span className="pill pill-muted">{detector.triggerCount} CANDIDATES</span>}
        </div>
      </div>

      {crashes.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">▲</span>
          <p>
            {detector?.armed
              ? 'DeviceMotion armed — real impacts above ~2.5 g report to the backend for multimodal verification. No simulated crash data is generated.'
              : 'Crash candidates come only from your device accelerometer. G-force spikes, GPS speed-drop, and camera distraction evidence must agree before dispatch.'}
          </p>
        </div>
      ) : (
        <div className="crash-list">
          {crashes.map((c) => (
            <CrashItem key={c.id} c={c} />
          ))}
        </div>
      )}
    </section>
  )
}
