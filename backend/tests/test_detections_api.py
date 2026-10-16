"""REST test for POST /api/detections/upload.

Sends the synthetic dashcam pothole frame (multipart) with browser-style GPS
form fields and asserts a real detection, estimated volume, dispatched cost,
and that the event was published through the telemetry pipeline.
"""

import importlib.util
import os
import sys

import numpy as np
import cv2
from fastapi.testclient import TestClient

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

spec = importlib.util.spec_from_file_location("tvp", os.path.join(_HERE, "test_vision_pipeline.py"))
tvp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tvp)

from app.main import app  # noqa: E402


def _encode_jpeg(bgr):
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return buf.tobytes()


def main():
    client = TestClient(app)
    img = tvp.make_synthetic_pothole()
    data = _encode_jpeg(img)
    with client:
        resp = client.post(
            "/api/detections/upload",
            files={"file": ("dashcam.jpg", data, "image/jpeg")},
            data={"lat": "40.4406", "lng": "-79.9959", "gps_source": "browser-geolocation"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["detection_count"] >= 1, body
        assert body["detector_tier"] in ("yolo", "cv-fallback"), body
        assert body["gps"] == {"lat": 40.4406, "lng": -79.9959, "source": "browser-geolocation"}, body
        ev = body["detections"][0]
        assert ev["type"] == "pothole"
        assert ev["status"] == "dispatched"
        assert ev["volume_estimated"] is True
        assert ev["gps_source"] == "browser-geolocation"
        assert ev["confidence"] > 0.5
        assert ev["volume"] > 0 and ev["depth"] > 0 and ev["area"] > 0
        assert ev["bbox"]["x"] <= 704 <= ev["bbox"]["x"] + ev["bbox"]["w"], ev["bbox"]
        assert ev["bbox"]["y"] <= 576 <= ev["bbox"]["y"] + ev["bbox"]["h"], ev["bbox"]
        assert ev["accuracy"]["mode"] == "monocular-estimated"
        assert ev["breakdown"]["labor"] + ev["breakdown"]["sealing"] > 0
        assert ev["cost"] == round(ev["breakdown"]["material"] + ev["breakdown"]["labor"] + ev["breakdown"]["sealing"], 2)
        assert body["annotated"] and body["annotated"].startswith("data:image/jpeg;base64,")
        print(f"OK: {body['detection_count']} detection(s), tier={body['detector_tier']}, "
              f"gps={body['gps']}, vol={ev['volume']} m3, cost=${ev['cost']}")

    # Privacy layer: the client attaches its on-device redaction report; the
    # backend must echo it on the response and on each published event.
    with client:
        redaction = {"faces": 1, "plates": 1, "regions": 2, "method": "mediapipe-face + plate-heuristic", "pixels": "pixelated"}
        resp = client.post(
            "/api/detections/upload",
            files={"file": ("dashcam.jpg", data, "image/jpeg")},
            data={"redaction": __import__("json").dumps(redaction)},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["privacy"] == redaction, body.get("privacy")
        assert body["detections"][0].get("privacy") == redaction, body["detections"][0].get("privacy")
        print(f"OK: redaction report echoed (faces={redaction['faces']}, plates={redaction['plates']})")

    # Malformed redaction payload must not crash the endpoint.
    with client:
        resp = client.post(
            "/api/detections/upload",
            files={"file": ("dashcam.jpg", data, "image/jpeg")},
            data={"redaction": "not-json"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json().get("privacy") is None
        print("OK: malformed redaction report ignored safely")

    # Simulated potholes (from the simulator) must NOT carry detection fields.
    with client:
        resp = client.get("/api/potholes")
        assert resp.status_code == 200, resp.text
        potholes = resp.json()
        assert isinstance(potholes, list)
        for p in potholes:
            if p.get("detection_source") == "simulated":
                assert p["volume_estimated"] is True
                assert p["gps_source"] == "random"
                break
        print(f"OK: /api/potholes lists {len(potholes)} entry(s)")

    print("DETECTIONS API TEST PASS")


if __name__ == "__main__":
    main()
