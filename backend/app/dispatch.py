"""Municipal B2G dispatch API + itemized PDF invoice generation.

POST /api/dispatch          (X-API-Key auth) — create a dispatch for a pothole
GET  /api/dispatches        — list all dispatches
GET  /api/dispatch/{id}/invoice — download the PDF invoice

The API key is read from SENTINEL_API_KEY (default: sentinel-demo-key).
Accepts Bearer or raw key in the Authorization header.
"""

import hashlib
import os
import time
import uuid
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

router = APIRouter(tags=["dispatch"])

API_KEY = os.getenv("SENTINEL_API_KEY", "sentinel-demo-key")

MUNICIPALITIES = [
    "Pittsburgh District 1 — Central Oakland",
    "Pittsburgh District 2 — Squirrel Hill",
    "Pittsburgh District 3 — Lawrenceville",
    "Pittsburgh District 4 — Strip District",
    "Pittsburgh District 5 — Bloomfield",
    "Pittsburgh District 6 — Shadyside",
    "Pittsburgh District 7 — East Liberty",
    "Pittsburgh District 8 — Highland Park",
]

# In-memory stores (fallback when Postgres is unavailable).
_dispatches: dict = {}
_invoice_cache: dict = {}  # pothole_id -> PDF bytes


def assign_municipality(lat, lng):
    """Deterministically assign a municipality from GPS coordinates."""
    if lat is None or lng is None:
        return MUNICIPALITIES[0]
    h = hashlib.md5(f"{lat:.3f},{lng:.3f}".encode()).hexdigest()
    return MUNICIPALITIES[int(h, 16) % len(MUNICIPALITIES)]


def _generate_invoice(pothole):
    """Build an itemized PDF invoice for one pothole detection."""
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("InvTitle", parent=styles["Title"], fontSize=18, spaceAfter=6)
    heading = ParagraphStyle("InvHead", parent=styles["Heading2"], fontSize=12, spaceBefore=12, spaceAfter=4)
    normal = ParagraphStyle("InvNorm", parent=styles["Normal"], fontSize=9, leading=12)
    small = ParagraphStyle("InvSmall", parent=normal, fontSize=7, textColor=colors.grey)

    ts = pothole.get("ts", int(time.time() * 1000))
    if ts > 1e12:
        ts = ts / 1000
    date_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
    b = pothole.get("breakdown") or {}
    acc = pothole.get("accuracy") or {}

    elements = []

    # Title
    elements.append(Paragraph("SentinelDrive — Municipal PWD Invoice", title_style))
    elements.append(Spacer(1, 8))

    # Invoice header
    header = [
        ["Invoice ID:", f"INV-{pothole['id'].upper()}", "Status:", "DISPATCHED"],
        ["Date:", date_str, "Municipality:", pothole.get("municipality", "Unknown")],
        ["Detection:", (pothole.get("detection_source") or "simulated").upper(), "GPS Source:", (pothole.get("gps_source") or "unknown").upper()],
    ]
    ht = Table(header, colWidths=[1.2 * inch, 2.2 * inch, 1.2 * inch, 2.2 * inch])
    ht.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(ht)
    elements.append(Spacer(1, 10))

    # GPS
    elements.append(Paragraph("GPS Location", heading))
    lat_val = pothole.get("lat")
    lng_val = pothole.get("lng")
    loc = [
        ["Latitude:", f"{lat_val:.6f}" if lat_val is not None else "Not available"],
        ["Longitude:", f"{lng_val:.6f}" if lng_val is not None else "Not available"],
    ]
    lt = Table(loc, colWidths=[1.2 * inch, 5.5 * inch])
    lt.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 9), ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold")]))
    elements.append(lt)
    elements.append(Spacer(1, 10))

    # Measurements
    elements.append(Paragraph("Volumetric Survey", heading))
    vol_est = "Yes (monocular)" if pothole.get("volume_estimated") else "No"
    ref = acc.get("reference", "camera-model")
    meas = [
        ["Area (A):", f"{pothole.get('area', 0):.4f} m2"],
        ["Depth (D):", f"{pothole.get('depth', 0):.4f} m"],
        ["Volume (V):", f"{pothole.get('volume', 0):.6f} m3"],
        ["Volume Estimated:", vol_est],
        ["Accuracy Reference:", ref],
    ]
    mt = Table(meas, colWidths=[1.5 * inch, 5.2 * inch])
    mt.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 9), ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold")]))
    elements.append(mt)
    elements.append(Spacer(1, 10))

    # Material
    elements.append(Paragraph("Material Specification", heading))
    elements.append(Paragraph(pothole.get("material", "PMB-25 Polymer-Modified Bitumen + elastomeric edge sealant"), normal))
    elements.append(Spacer(1, 10))

    # Cost breakdown
    elements.append(Paragraph("Itemized Cost Breakdown", heading))
    cost_rows = [
        ["Line Item", "Unit Price", "Qty / Rate", "Amount"],
        ["PMB-25 Polymer-Modified Bitumen", f"${b.get('unit_price_pmb', 185):.2f}/m3", f"{pothole.get('volume', 0):.6f} m3", f"${b.get('material', 0):.2f}"],
        ["Labour (pothole patching)", "", "1 job", f"${b.get('labor', 42):.2f}"],
        ["Elastomeric edge sealant", "", "1 application", f"${b.get('sealing', 18):.2f}"],
    ]
    total = pothole.get("cost", 0)
    cost_rows.append(["", "", "TOTAL", f"${total:.2f}"])
    ct = Table(cost_rows, colWidths=[3.0 * inch, 1.5 * inch, 1.2 * inch, 1.0 * inch])
    ct.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.92, 0.92, 0.92)),
        ("LINEABOVE", (0, 0), (-1, 0), 1, colors.black),
        ("LINEABOVE", (0, -1), (-1, -1), 1, colors.black),
        ("LINEBELOW", (0, -1), (-1, -1), 2, colors.black),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    elements.append(ct)
    elements.append(Spacer(1, 18))

    # Footer
    elements.append(Paragraph("Generated by SentinelDrive Municipal Telematics System", small))
    elements.append(Paragraph("All volumetric measurements are monocular estimates. Upgrade path: stereo vision or LiDAR.", small))

    doc.build(elements)
    buf.seek(0)
    return buf.getvalue()


def create_dispatch(pothole):
    """Create a dispatch record and generate the PDF invoice for a pothole."""
    pid = pothole["id"]
    if pid in _invoice_cache:
        # Already dispatched — return existing record.
        for d in _dispatches.values():
            if d["pothole_id"] == pid:
                return d
    did = f"DIS-{uuid.uuid4().hex[:8]}"
    municipality = pothole.get("municipality") or assign_municipality(
        pothole.get("lat"), pothole.get("lng")
    )
    dispatch = {
        "id": did,
        "pothole_id": pid,
        "status": "dispatched",
        "municipality": municipality,
        "ts": int(time.time() * 1000),
        "cost": round(pothole.get("cost", 0), 2),
        "volume": pothole.get("volume", 0),
        "lat": pothole.get("lat"),
        "lng": pothole.get("lng"),
        "invoice_url": f"/api/dispatch/{pid}/invoice",
    }
    _dispatches[did] = dispatch
    pothole_copy = {**pothole, "municipality": municipality}
    _invoice_cache[pid] = _generate_invoice(pothole_copy)
    return dispatch


def get_dispatch_by_pothole(pothole_id):
    for d in _dispatches.values():
        if d["pothole_id"] == pothole_id:
            return d
    return None


def list_dispatches():
    return sorted(_dispatches.values(), key=lambda d: d["ts"], reverse=True)


def get_invoice(pothole_id):
    return _invoice_cache.get(pothole_id)


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

class DispatchRequest(BaseModel):
    pothole_id: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    area: Optional[float] = None
    depth: Optional[float] = None
    volume: Optional[float] = None
    material: Optional[str] = None
    cost: Optional[float] = None
    breakdown: Optional[dict] = None
    detection_source: Optional[str] = None
    volume_estimated: Optional[bool] = True
    gps_source: Optional[str] = None
    accuracy: Optional[dict] = None
    bbox: Optional[dict] = None
    ts: Optional[int] = None
    status: Optional[str] = "dispatched"
    municipality: Optional[str] = None


def _check_auth(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if token != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid API key")


@router.post("/dispatch")
async def create_dispatch_endpoint(req: DispatchRequest, authorization: Optional[str] = Header(None)):
    _check_auth(authorization)
    pothole = {
        "id": req.pothole_id,
        "lat": req.lat or 0,
        "lng": req.lng or 0,
        "area": req.area or 0,
        "depth": req.depth or 0,
        "volume": req.volume or 0,
        "material": req.material or "PMB-25 Polymer-Modified Bitumen + elastomeric edge sealant",
        "cost": req.cost or 0,
        "breakdown": req.breakdown or {},
        "detection_source": req.detection_source or "simulated",
        "volume_estimated": req.volume_estimated if req.volume_estimated is not None else True,
        "gps_source": req.gps_source or "unknown",
        "accuracy": req.accuracy or {},
        "bbox": req.bbox,
        "ts": req.ts or int(time.time() * 1000),
        "status": req.status or "dispatched",
        "municipality": req.municipality,
    }
    dispatch = create_dispatch(pothole)
    return dispatch


@router.get("/dispatches")
async def list_dispatches_endpoint():
    return list_dispatches()


@router.get("/dispatch/{pothole_id}/invoice")
async def download_invoice(pothole_id: str):
    pdf = get_invoice(pothole_id)
    if pdf is None:
        # Generate on-the-fly if not cached (e.g. potholes from the simulator).
        from .pipeline import TelemetryPipeline  # local to avoid circular
        raise HTTPException(status_code=404, detail="No dispatch for this pothole. POST /api/dispatch first.")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="INV-{pothole_id.upper()}.pdf"'},
    )
