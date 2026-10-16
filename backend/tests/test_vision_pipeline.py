import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import numpy as np

from app.vision.detector import PotholeDetector
from app.vision.geometry import compute_measurements, pothole_cost


def make_synthetic_pothole(w=1280, h=720):
    """Dashcam-style frame: asphalt gradient, a painted lane line, and one
    dark elliptical pothole beside it below the horizon."""
    bgr = np.zeros((h, w, 3), np.uint8)
    for y in range(h):
        v = int(115 - (y / h) * 22)  # slightly darker asphalt in the foreground
        bgr[y, :] = (v, v, v)
    # Horizon-ish transition band (light grey) so it reads as road-in-distance
    cv2.rectangle(bgr, (0, 0), (w, int(h * 0.35)), (135, 135, 135), -1)
    # Painted lane line running vertically beside the pothole (calibration
    # reference: 0.125 m wide, ~20 px at this distance).
    cv2.rectangle(bgr, (int(w * 0.42), int(h * 0.36)), (int(w * 0.42) + 20, h - 1), (235, 235, 235), -1)
    # The pothole: dark, low-saturation ellipse
    cx, cy = int(w * 0.55), int(h * 0.80)
    axes = (int(w * 0.045), int(h * 0.06))
    cv2.ellipse(bgr, (cx, cy), axes, 0, 0, 360, (34, 34, 34), -1)
    # Slight texture so it resembles asphalt
    noise = np.random.default_rng(7).normal(0, 3, (h, w, 1)).astype(np.int16)
    bgr = np.clip(bgr.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return bgr


def main():
    img = make_synthetic_pothole()
    det = PotholeDetector()
    print(f"detector tier: {det.tier}")
    dets = det.detect(img)
    assert dets, "fallback detector found nothing on the synthetic pothole"
    x, y, w, h = dets[0]["bbox"].values()
    cx, cy = int(img.shape[1] * 0.55), int(img.shape[0] * 0.80)
    assert x <= cx <= x + w and y <= cy <= y + h, f"bbox {dets[0]['bbox']} misses pothole center {(cx, cy)}"
    print(f"OK: detected {len(dets)} pothole(s), best bbox {dets[0]['bbox']} conf {dets[0]['confidence']} source {dets[0]['detection_source']}")

    m = compute_measurements(img, dets[0]["bbox"])
    assert m["volume_estimated"] is True
    assert m["volume"] > 0 and m["depth"] > 0 and m["area"] > 0
    assert m["accuracy"]["mode"] == "monocular-estimated"
    assert m["accuracy"]["reference"] == "painted-lane-line", m["accuracy"]
    print(f"OK: measurements -> area {m['area']} m2, depth {m['depth']} m, volume {m['volume']} m3 (reference: {m['accuracy']['reference']})")

    bd = pothole_cost(m["volume"])
    assert bd["material"] == round(m["volume"] * bd["unit_price_pmb"], 2)
    cost = round(bd["material"] + bd["labor"] + bd["sealing"], 2)
    print(f"OK: cost formula -> ${cost} (material ${bd['material']} + labor ${bd['labor']} + sealing ${bd['sealing']})")

    print("\nVISION PIPELINE TEST PASS")


if __name__ == "__main__":
    main()
