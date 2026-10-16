"""Tests for the B2G dispatch API: auth, dispatch creation, PDF invoice download.

Run: python backend/tests/test_dispatch.py
"""
import json
import os
import sys

from fastapi.testclient import TestClient

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from app.main import app  # noqa: E402
from app.dispatch import _dispatches, _invoice_cache  # noqa: E402


def main():
    client = TestClient(app)

    # Clear any dispatches created during startup (sim tick).
    _dispatches.clear()
    _invoice_cache.clear()

    # --- 1: POST without auth -> 401 ---
    r = client.post("/api/dispatch", json={"pothole_id": "noauth-1"})
    assert r.status_code == 401, r.text
    print("OK: 401 without auth")

    # --- 2: POST with wrong key -> 403 ---
    r = client.post(
        "/api/dispatch",
        json={"pothole_id": "badkey-1"},
        headers={"Authorization": "Bearer wrong-key"},
    )
    assert r.status_code == 403, r.text
    print("OK: 403 with wrong key")

    # --- 3: POST with valid key -> 200, dispatch record + invoice ---
    r = client.post(
        "/api/dispatch",
        json={
            "pothole_id": "det-001",
            "lat": 40.4406,
            "lng": -79.9959,
            "area": 0.123,
            "depth": 0.08,
            "volume": 0.00984,
            "cost": 69.82,
            "breakdown": {"material": 9.82, "labor": 42.0, "sealing": 18.0, "unit_price_pmb": 185},
            "detection_source": "camera",
            "municipality": "Pittsburgh District 3",
        },
        headers={"Authorization": "Bearer sentinel-demo-key"},
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["pothole_id"] == "det-001"
    assert d["status"] == "dispatched"
    assert d["municipality"] == "Pittsburgh District 3"
    assert d["invoice_url"] == "/api/dispatch/det-001/invoice"
    print(f"OK: dispatch created id={d['id']}")

    # --- 4: Download PDF invoice for det-001 ---
    r = client.get("/api/dispatch/det-001/invoice")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert len(r.content) > 1000, f"PDF too small: {len(r.content)} bytes"
    assert r.content[:5] == b"%PDF-"
    print(f"OK: PDF invoice {len(r.content)} bytes for det-001")

    # --- 5: Idempotent: same pothole_id returns existing dispatch ---
    r2 = client.post(
        "/api/dispatch",
        json={"pothole_id": "det-001", "lat": 40.44, "lng": -79.99},
        headers={"Authorization": "Bearer sentinel-demo-key"},
    )
    assert r2.status_code == 200
    assert r2.json()["id"] == d["id"], "should return existing dispatch"
    print("OK: idempotent dispatch")

    # --- 6: Second pothole dispatched ---
    r = client.post(
        "/api/dispatch",
        json={"pothole_id": "det-002", "lat": 40.45, "lng": -80.0, "volume": 0.02, "cost": 75.70},
        headers={"Authorization": "Bearer sentinel-demo-key"},
    )
    assert r.status_code == 200

    # --- 7: GET /api/dispatches lists both ---
    r = client.get("/api/dispatches")
    assert r.status_code == 200
    dispatches = r.json()
    assert len(dispatches) >= 2, f"expected >= 2 dispatches, got {len(dispatches)}"
    ids = [dd["pothole_id"] for dd in dispatches]
    assert "det-001" in ids and "det-002" in ids
    print(f"OK: /api/dispatches lists {len(dispatches)} dispatch(es)")

    # --- 8: Invoice for nonexistent pothole -> 404 ---
    r = client.get("/api/dispatch/nope-999/invoice")
    assert r.status_code == 404, r.text
    print("OK: 404 for nonexistent invoice")

    # --- 9: Municipality auto-assignment ---
    r = client.post(
        "/api/dispatch",
        json={"pothole_id": "auto-1", "lat": 40.441, "lng": -79.996},
        headers={"Authorization": "Bearer sentinel-demo-key"},
    )
    assert r.status_code == 200
    assert "Pittsburgh" in r.json()["municipality"]
    print(f"OK: auto-municipality = {r.json()['municipality']}")

    # --- 10: PDF is valid and has reasonable size (content is compressed) ---
    r = client.get("/api/dispatch/auto-1/invoice")
    assert r.status_code == 200
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 1000
    print(f"OK: auto-dispatch invoice PDF {len(r.content)} bytes")

    print("\nDISPATCH API TEST PASS")


if __name__ == "__main__":
    main()
