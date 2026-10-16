import { useState } from 'react'
import PotholeUpload from './PotholeUpload'

function toTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function downloadInvoice(potholeId) {
  fetch(`/api/dispatch/${potholeId}/invoice`)
    .then((r) => {
      if (!r.ok) throw new Error('not found')
      return r.blob()
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `INV-${potholeId.toUpperCase()}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    })
    .catch(() => {})
}

function MunicipalitySummary({ potholes }) {
  const groups = {}
  for (const p of potholes) {
    const m = p.municipality || 'Unknown'
    if (!groups[m]) groups[m] = { count: 0, totalCost: 0, totalVol: 0 }
    groups[m].count++
    groups[m].totalCost += p.cost
    groups[m].totalVol += p.volume
  }
  const entries = Object.entries(groups).sort((a, b) => b[1].totalCost - a[1].totalCost)
  if (entries.length === 0) return null
  return (
    <div className="muni-summary">
      <h3 className="dl-label">PER-MUNICIPALITY DISPATCH STATUS</h3>
      <table className="muni-table">
        <thead>
          <tr>
            <th>Municipality</th>
            <th>Potholes</th>
            <th>Total Volume</th>
            <th>Total Cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, s]) => (
            <tr key={name}>
              <td className="muni-name">{name}</td>
              <td>{s.count}</td>
              <td>{s.totalVol.toFixed(4)} m³</td>
              <td>${s.totalCost.toFixed(2)}</td>
              <td><span className="pill pill-ok">DISPATCHED</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PotholeRow({ pothole, open, onToggle }) {
  const b = pothole.breakdown || {}
  const detected = pothole.detection_source === 'simulated' ? false : true
  return (
    <div className={`pothole-row ${open ? 'open' : ''}`}>
      <button className="pothole-main" onClick={onToggle}>
        <span className="pothole-id">#{pothole.id}</span>
        {detected && <span className="badge badge-cam">CAMERA</span>}
        {pothole.volume_estimated && <span className="badge badge-est">EST</span>}
        <span className="pothole-gps">{pothole.lat != null && pothole.lng != null ? `${pothole.lat.toFixed(4)}, ${pothole.lng.toFixed(4)}` : 'NO GPS FIX'}</span>
        <span className="pothole-vol">V = {pothole.volume} m³</span>
        <span className="pothole-cost">${pothole.cost.toFixed(2)}</span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="pothole-detail">
          <div className="pothole-grid">
            <div>
              <p className="dl-label">Survey</p>
              <p>A = {pothole.area} m² · D = {pothole.depth} m</p>
            </div>
            <div>
              <p className="dl-label">Material spec</p>
              <p>{pothole.material}</p>
            </div>
            <div>
              <p className="dl-label">Itemized cost (V × PMB + labor + seal)</p>
              <p>Mat ${(b.material || 0).toFixed(2)} · Labor ${(b.labor || 0).toFixed(2)} · Seal ${(b.sealing || 0).toFixed(2)}</p>
            </div>
            <div>
              <p className="dl-label">Municipality</p>
              <p>{pothole.municipality || 'Unknown'}</p>
            </div>
            <div>
              <p className="dl-label">Status</p>
              <p className="dispatch-tag">{pothole.status.toUpperCase()} → PWD</p>
            </div>
          </div>
          <div className="pothole-actions">
            <button className="btn btn-sm btn-invoice" onClick={(e) => { e.stopPropagation(); downloadInvoice(pothole.id) }}>
              DOWNLOAD INVOICE PDF
            </button>
          </div>
          {detected && (
            <div className="pothole-detail-labels">
              <span className="est-sub">DETECTED {pothole.detection_source.toUpperCase()} · conf {(pothole.confidence || 0).toFixed(2)}</span>
              <span className="est-sub">VOL ESTIMATED ({pothole.accuracy?.reference || 'camera-model'})</span>
              <span className="est-sub">GPS {pothole.gps_source?.toUpperCase()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PotholePortal({ potholes }) {
  const [openId, setOpenId] = useState(null)
  const totalCost = potholes.reduce((s, p) => s + p.cost, 0)

  return (
    <section className="card span-2">
      <div className="card-head">
        <h2>MUNICIPAL PWD · DISPATCH PORTAL</h2>
        <span className="pill pill-ok">B2G API · {potholes.length} DISPATCHED · ${totalCost.toFixed(2)}</span>
      </div>

      <PotholeUpload />

      {potholes.length > 0 && <MunicipalitySummary potholes={potholes} />}

      {potholes.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">◎</span>
          <p>Awaiting volumetric CV detections from your camera uploads. No synthetic backfill — potholes appear only when you upload a road image.</p>
        </div>
      ) : (
        <div className="pothole-list">
          <div className="pothole-head">
            <span>ID</span>
            <span />
            <span />
            <span>GPS COORDINATES</span>
            <span>VOLUME</span>
            <span>EST. COST</span>
            <span />
          </div>
          {potholes.map((p) => (
            <PotholeRow
              key={p.id}
              pothole={p}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
