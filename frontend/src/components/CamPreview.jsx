const CAM_STATUS_LABEL = {
  idle: 'IDLE',
  requesting: 'REQUESTING…',
  loading: 'LOADING MODEL…',
  running: 'LIVE',
  'no-face': 'NO FACE',
  denied: 'PERMISSION DENIED',
  unsupported: 'NO CAMERA',
  error: 'ERROR',
}

// DEBUG FLAG: set to false (or remove) once fatigue live-debugging is
// confirmed working.
const SHOW_DEBUG_OVERLAY = true

function DebugOverlay({ d }) {
  if (!d) return null
  const rows = [
    ['EAR L / R', `${d.earL} / ${d.earR}`],
    ['EAR avg', d.earAvg],
    ['closed?', String(d.closed)],
    ['PERCLOS', `${d.perclos} (${d.closedFrames}/${d.totalFrames})`],
    ['closure streak', `${d.closedStreakMs} ms`],
    ['pitch', `${d.pitchDeg}°`],
    ['head ratio', d.headDroopRatio],
    ['droopActive', String(d.droopActive)],
    ['droop sustained', `${d.droopSustainedMs} ms`],
    ['eyeScore / nodScore', `${d.eyeScore} / ${d.nodScore}`],
    ['score (sent)', `${d.score} · ${d.tier}`],
  ]
  return (
    <div className="fatigue-debug">
      <div className="fatigue-debug-title">FATIGUE DEBUG · live</div>
      {rows.map(([k, v]) => (
        <div className="fatigue-debug-row" key={k}>
          <span className="fatigue-debug-key">{k}</span>
          <span className="fatigue-debug-val">{v}</span>
        </div>
      ))}
    </div>
  )
}

export default function CamPreview({ stream, status, debug }) {
  const label = CAM_STATUS_LABEL[status] ?? status
  return (
    <aside className="cam-preview">
      <div className="cam-preview-head">
        <span className={`dot ${stream ? 'on' : 'off'}`} />
        <span>SENTINEL CAM</span>
        <span className="cam-preview-status">{label}</span>
      </div>
      {stream ? (
        <video
          className="cam-preview-video"
          autoPlay
          muted
          playsInline
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream
          }}
        />
      ) : (
        <div className="cam-preview-empty">no feed</div>
      )}
      {SHOW_DEBUG_OVERLAY && <DebugOverlay d={debug} />}
    </aside>
  )
}