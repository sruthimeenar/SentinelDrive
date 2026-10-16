"""Pothole detection upload endpoint.

POST /api/detections/upload  (multipart/form-data)
  file        image (jpg/png/webp/...) or dashcam clip (mp4/mov/avi/...)
  lat, lng    optional GPS from the browser Geolocation API
  gps_source  "browser-geolocation" | "manual" | "unknown"

Runs the detection + monocular-depth pipeline (YOLO/MiDaS when installed,
OpenCV/camera-model fallback otherwise), annotates the best frame, dispatches
each detection as a `pothole` telemetry event (so it lands in the PWD portal
and PostGIS through the existing pipeline), and returns the survey payloads.
"""

import asyncio
import base64
import json
import os
import time
import uuid
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, UploadFile

from .gps import gps_from_exif
from .vision.depth import DepthEngine
from .vision.detector import PotholeDetector
from .vision.geometry import MATERIAL_SPEC, compute_measurements, pothole_cost
from .dispatch import create_dispatch, assign_municipality

router = APIRouter(prefix="/api/detections", tags=["detections"])

VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "m4v"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "bmp"}

_detector = PotholeDetector()
_depth = DepthEngine()
_publisher = None


def set_publisher(fn):
    global _publisher
    _publisher = fn


def _ts():
    return int(time.time() * 1000)


def _build_detection(bgr, det, depth_map, lat, lng, gps_source):
    m = compute_measurements(bgr, det["bbox"], depth_map)
    bd = pothole_cost(m["volume"])
    return {
        "type": "pothole",
        "id": uuid.uuid4().hex[:10],
        "lat": lat,
        "lng": lng,
        "area": m["area"],
        "depth": m["depth"],
        "volume": m["volume"],
        "material": MATERIAL_SPEC,
        "cost": round(bd["material"] + bd["labor"] + bd["sealing"], 2),
        "breakdown": bd,
        "status": "dispatched",
        "ts": _ts(),
        "detection_source": det["detection_source"],
        "confidence": det["confidence"],
        "volume_estimated": m["volume_estimated"],
        "gps_source": gps_source,
        "bbox": m["bbox"],
        "accuracy": m["accuracy"],
    }


def _annotate(bgr, detections):
    out = bgr.copy()
    for d in detections:
        x, y, w, h = d["bbox"]["x"], d["bbox"]["y"], d["bbox"]["w"], d["bbox"]["h"]
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 255, 220), 3)
        label = f"{d.get('detection_source', '?')} {d['confidence']:.2f}  V={d.get('volume', 0):.3f} m3"
        cv2.putText(out, label, (x, max(20, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 220), 2)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def _process_image(data, lat, lng, gps_source):
    buf = np.frombuffer(data, np.uint8)
    bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("could not decode image")
    depth_map = _depth.estimate(bgr) if _depth.tier != "camera-model" else None
    dets = _detector.detect(bgr)
    out = []
    for det in dets:
        ev = _build_detection(bgr, det, depth_map, lat, lng, gps_source)
        det = {**det, "volume": ev["volume"]}
        out.append(ev)
    annotated = _annotate(bgr, out) if out else None
    return {
        "detector_tier": _detector.tier,
        "depth_tier": _depth.tier,
        "detections": out,
        "annotated": annotated,
    }


def _process_video(data, lat, lng, gps_source):
    import tempfile

    ext = ".mp4"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        step = max(1, int(round(fps * 1.5)))
        frames = []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0 and len(frames) < 8:
                frames.append((idx, frame))
            idx += 1
        cap.release()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    if not frames:
        return {"detector_tier": _detector.tier, "depth_tier": _depth.tier, "detections": [], "annotated": None, "frames_sampled": 0}

    out = []
    best = None
    for fidx, frame in frames:
        dets = _detector.detect(frame)
        if not dets:
            continue
        det = max(dets, key=lambda d: d["confidence"])
        ev = _build_detection(frame, det, None, lat, lng, gps_source)
        ev["frame_index"] = fidx
        out.append(ev)
        if best is None or det["confidence"] > best[0]:
            best = (det["confidence"], frame, [{"bbox": ev["bbox"], "confidence": ev["confidence"], "detection_source": ev["detection_source"], "volume": ev["volume"]}])
    return {
        "detector_tier": _detector.tier,
        "depth_tier": _depth.tier,
        "detections": out,
        "annotated": _annotate(best[1], best[2]) if best else None,
        "frames_sampled": len(frames),
    }


def _parse_redaction(raw: Optional[str]) -> Optional[dict]:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


@router.post("/upload")
async def upload_detection(
    file: UploadFile = File(...),
    lat: float = Form(None),
    lng: float = Form(None),
    gps_source: str = Form("unknown"),
    redaction: str = Form(None),
):
    data = await file.read()
    if not data:
        raise ValueError("empty upload")
    filename = (file.filename or "").lower()
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""

    if lat is None or lng is None:
        exif = gps_from_exif(data)
        if exif:
            lat, lng = exif["lat"], exif["lng"]
            gps_source = "image-exif"
        else:
            gps_source = gps_source or "unknown"

    loop = asyncio.get_running_loop()
    if ext in VIDEO_EXTS:
        result = await loop.run_in_executor(None, _process_video, data, lat, lng, gps_source)
    else:
        result = await loop.run_in_executor(None, _process_image, data, lat, lng, gps_source)

    dispatches = []
    for ev in result["detections"]:
        privacy = _parse_redaction(redaction)
        if privacy:
            ev["privacy"] = privacy
        ev["municipality"] = assign_municipality(ev.get("lat"), ev.get("lng"))
        dispatch = create_dispatch(ev)
        dispatches.append(dispatch)
        if _publisher is not None:
            await _publisher(ev)

    result["job"] = uuid.uuid4().hex[:8]
    result["gps"] = {"lat": lat, "lng": lng, "source": gps_source}
    result["detection_count"] = len(result["detections"])
    result["privacy"] = _parse_redaction(redaction)
    result["dispatches"] = dispatches
    return result
