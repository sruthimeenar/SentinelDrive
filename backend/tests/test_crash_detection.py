"""Phase 4 tests: real device crash_candidate ingestion + multimodal verification.

The browser's accelerometer sends a `crash_candidate`; the simulator verifies it
against GPS speed-drop and camera distraction evidence and emits a `crash`
event tagged `detection_source: "device"` with an explicit verification block.
The simulator NEVER fabricates crashes — test E asserts none appear across
thousands of ticks.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from app.simulator import SentinelSimulator  # noqa: E402


def test_device_verified_with_gps_and_camera():
    s = SentinelSimulator()
    ev = s.ingest({
        "type": "crash_candidate",
        "gForce": 9.2,
        "ts": 1755000000000,
        "gps": {"lat": 40.44, "lng": -79.99, "speed_kmh": 12.0, "speed_prior_kmh": 58.0},
        "fatigue": {"score": 7.2, "tier": "critical", "source": "camera"},
    })
    assert ev is not None and ev["type"] == "crash"
    assert ev["detection_source"] == "device"
    assert ev["verified"] is True
    assert ev["gForce"] == 9.2
    assert ev["db"] is None
    assert ev["frameCrunch"] is True  # camera was active at impact
    assert ev["guidance"] is not None
    v = ev["verification"]
    assert v["mode"] == "device-multimodal"
    assert v["sensors"]["gForce"]["source"] == "device"
    assert v["sensors"]["gps"]["speed_delta_kmh"] == 46.0
    assert v["sensors"]["gps"]["source"] == "device"
    assert v["sensors"]["camera"]["source"] == "camera"
    assert all(v["sensors"][k]["agree"] for k in ("gForce", "gps", "camera"))
    assert s.crash_events[0]["id"] == ev["id"]
    print("A OK: strong impact + GPS + camera -> VERIFIED device crash with full verification block")


def test_device_suppressed_without_corroboration():
    s = SentinelSimulator()
    ev = s.ingest({
        "type": "crash_candidate",
        "gForce": 3.1,
        "ts": 1755000000000,
        "gps": None,
        "fatigue": {"score": 2.0, "tier": "safe", "source": "simulated"},
    })
    assert ev["verified"] is False
    assert ev["guidance"] is None
    v = ev["verification"]
    assert v["sensors"]["gps"]["source"] == "not-captured"
    assert v["sensors"]["camera"]["source"] == "simulated"
    assert not v["sensors"]["gForce"]["agree"]
    print("B OK: low impact + no corroboration -> SUPPRESSED, sources labeled")


def test_device_decisive_impact_verified_alone():
    s = SentinelSimulator()
    ev = s.ingest({
        "type": "crash_candidate",
        "gForce": 9.0,
        "ts": 1755000000000,
        "gps": None,
        "fatigue": None,
    })
    assert ev["verified"] is True
    assert ev["verification"]["sensors"]["gps"]["source"] == "not-captured"
    assert ev["verification"]["sensors"]["camera"]["source"] == "not-captured"
    print("C OK: decisive >=8 g impact -> VERIFIED on its own (honest about missing sensors)")


def test_gps_threshold_boundary():
    s = SentinelSimulator()
    # 19 km/h drop < 20 threshold -> no gps corroboration, gForce below decisive
    ev = s.ingest({
        "type": "crash_candidate",
        "gForce": 5.0,
        "ts": 1755000000000,
        "gps": {"lat": 40.44, "lng": -79.99, "speed_kmh": 39.0, "speed_prior_kmh": 58.0},
        "fatigue": None,
    })
    assert ev["verified"] is False
    assert ev["verification"]["sensors"]["gps"]["speed_delta_kmh"] == 19.0
    assert ev["verification"]["sensors"]["gps"]["agree"] is False
    print("D OK: 19 km/h drop below threshold -> not corroborated, still honest in the block")


def test_no_simulated_crash_generated():
    s = SentinelSimulator()
    for _ in range(4000):
        for m in s.tick():
            assert m["type"] != "crash", "simulator must never fabricate a crash"
    assert len(s.crash_events) == 0
    print("E OK: no fake crashes across 4000 ticks — crashes come only from device crash_candidate ingestion")


def test_unknown_type_ignored():
    s = SentinelSimulator()
    assert s.ingest({"type": "nonsense", "x": 1}) is None
    print("F OK: unknown message types still ignored")


if __name__ == "__main__":
    test_device_verified_with_gps_and_camera()
    test_device_suppressed_without_corroboration()
    test_device_decisive_impact_verified_alone()
    test_gps_threshold_boundary()
    test_no_simulated_crash_generated()
    test_unknown_type_ignored()
    print("\nALL CRASH DETECTION TESTS PASS")
