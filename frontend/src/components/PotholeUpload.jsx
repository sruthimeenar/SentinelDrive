import { useRef, useState } from 'react'
import { redactImageBlob, redactVideoBlob } from '../lib/redact'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/bmp,video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska'
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']

export default function PotholeUpload() {
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [gps, setGps] = useState(null)
  const [gpsSource, setGpsSource] = useState('unknown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [privacy, setPrivacy] = useState(null)

  const useGeolocation = () => {
    if (!('geolocation' in navigator)) {
      setError('Geolocation API not available — upload without a fix (EXIF will be tried).')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGpsSource('browser-geolocation')
        setError(null)
      },
      (err) => setError(`Geolocation failed (${err.code}) — upload will fall back to EXIF.`),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  const isVideo = () => {
    const name = (file.name || '').toLowerCase()
    const ext = name.split('.').pop()
    return VIDEO_EXTS.includes(ext)
  }

  const upload = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    setPrivacy(null)
    try {
      // PRIVACY LAYER: redact faces + license plates on-device BEFORE upload.
      // Fail-closed: an upload is blocked rather than sending unredacted pixels.
      const redacted = isVideo() ? await redactVideoBlob(file) : await redactImageBlob(file)
      setPrivacy(redacted.report)

      const fd = new FormData()
      fd.append('file', new File([redacted.blob], redacted.blob.type.startsWith('video') ? 'redacted.webm' : 'redacted.jpg', { type: redacted.blob.type }))
      fd.append('redaction', JSON.stringify(redacted.report))
      if (gps) {
        fd.append('lat', String(gps.lat))
        fd.append('lng', String(gps.lng))
        fd.append('gps_source', gpsSource)
      }
      const resp = await fetch('/api/detections/upload', { method: 'POST', body: fd })
      const body = await resp.json()
      if (!resp.ok) throw new Error(body.detail || `Server error ${resp.status}`)
      setResult(body)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const downloadInvoice = async (potholeId) => {
    try {
      const resp = await fetch(`/api/dispatch/${potholeId}/invoice`)
      if (!resp.ok) {
        // Auto-dispatch on demand if not already dispatched.
        const d = result?.detections?.find((d) => d.id === potholeId)
        if (d) {
          await fetch('/api/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sentinel-demo-key' },
            body: JSON.stringify({ pothole_id: d.id, ...d }),
          })
          const r2 = await fetch(`/api/dispatch/${potholeId}/invoice`)
          if (!r2.ok) throw new Error('Invoice generation failed')
          const blob = await r2.blob()
          triggerDownload(blob, `INV-${potholeId.toUpperCase()}.pdf`)
          return
        }
        throw new Error('Invoice not available')
      }
      const blob = await resp.blob()
      triggerDownload(blob, `INV-${potholeId.toUpperCase()}.pdf`)
    } catch (e) {
      setError(`Invoice error: ${e.message}`)
    }
  }

  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="upload-widget">
      <div className="upload-row">
        <input ref={fileRef} type="file" accept={ACCEPT} onChange={(e) => { setFile(e.target.files[0] || null); setResult(null) }} />
        <button className="btn" onClick={useGeolocation} disabled={!!gps}>
          {gps ? `GPS LOCKED ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'Attach GPS'}
        </button>
        <button className="btn btn-primary" onClick={upload} disabled={!file || busy}>
          {busy ? 'DETECTING…' : 'UPLOAD → DETECT'}
        </button>
      </div>
      {error && <p className="upload-error">{error}</p>}

      {result && (
        <div className="upload-result">
          {result.annotated && (
            <img className="upload-preview" src={result.annotated} alt="Annotated detection preview" />
          )}
          <div className="upload-meta">
            <span className={`pill ${result.detector_tier === 'yolo' ? 'pill-ok' : 'pill-warn'}`}>
              {result.detector_tier === 'yolo' ? 'YOLO' : 'CV'} DETECTOR
            </span>
            <span className={`pill ${result.depth_tier === 'midas' ? 'pill-ok' : 'pill-warn'}`}>
              DEPTH {result.depth_tier === 'midas' ? 'MiDaS' : 'CAMERA-MODEL'}
            </span>
            <span className="pill pill-warn">VOL EST</span>
            <span className="pill pill-ok">{result.detection_count} DISPATCHED</span>
            <span className="pill pill-ok">GPS {result.gps?.source?.toUpperCase()}</span>
            <span className={`pill ${result.privacy ? (result.privacy.regions > 0 ? 'pill-ok' : 'pill-info') : 'pill-danger'}`}>
              {result.privacy ? `PRIVACY REDACTED · ${result.privacy.faces}F ${result.privacy.plates}P` : 'PRIVACY UNKNOWN'}
            </span>
          </div>
          {result.detections.length > 0 ? (
            <table className="upload-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>CONF</th>
                  <th>VOL (m³)</th>
                  <th>COST</th>
                  <th>ACCURACY</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.detections.map((d) => (
                  <tr key={d.id}>
                    <td className="pothole-id">#{d.id}</td>
                    <td>{d.confidence.toFixed(2)}</td>
                    <td>{d.volume} <span className="est-badge">EST</span></td>
                    <td>${d.cost.toFixed(2)}</td>
                    <td>
                      {d.accuracy.mode}
                      <span className="est-sub"> · ref: {d.accuracy.reference}</span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-invoice" onClick={() => downloadInvoice(d.id)}>
                        INVOICE PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-state small">No pothole detected in this capture.</p>
          )}
        </div>
      )}
    </div>
  )
}
