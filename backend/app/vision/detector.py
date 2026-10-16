import os

import cv2
import numpy as np

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models")
DEFAULT_WEIGHTS = os.path.join(MODELS_DIR, "pothole_yolo.pt")


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / max(1, union)


class PotholeDetector:
    """Bounding-box pothole detector with a graceful model fallback.

    Tier 1 — YOLO (v8/v11) fine-tuned on a pothole dataset, loaded via
    ``ultralytics`` from ``POTHOLES_YOLO_WEIGHTS`` (default
    ``backend/models/pothole_yolo.pt``). See README for fine-tuning steps on a
    Roboflow pothole dataset. Requires the optional ML deps (pip install -e .[ml]).

    Tier 2 — OpenCV heuristic: dark, low-saturation blobs on the road plane
    below the horizon (asphalt potholes read darker than surrounding road).
    Zero ML dependencies, results tagged ``cv-fallback``.
    """

    def __init__(self, weights_path=None):
        self.weights_path = weights_path or os.getenv("POTHOLES_YOLO_WEIGHTS", DEFAULT_WEIGHTS)
        self.model = None
        self.tier = self._load_yolo() if os.path.exists(self.weights_path) else None
        if self.tier is None:
            self.tier = "cv-fallback"

    def _load_yolo(self):
        try:
            from ultralytics import YOLO
        except Exception:
            return None
        try:
            model = YOLO(self.weights_path)
            self.model = model
            return "yolo"
        except Exception:
            return None

    def detect(self, bgr):
        if self.tier == "yolo" and self.model is not None:
            return self._detect_yolo(bgr)
        return self._detect_cv(bgr)

    def _detect_yolo(self, bgr):
        results = self.model.predict(bgr, verbose=False, imgsz=640)
        out = []
        if not results:
            return out
        for box in results[0].boxes:
            conf = float(box.conf[0])
            if conf < 0.25:
                continue
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            out.append({
                "bbox": {"x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1)},
                "confidence": round(conf, 3),
                "detection_source": "yolo",
            })
        return out

    def _detect_cv(self, bgr):
        img_h, img_w = bgr.shape[:2]
        horizon = int(img_h * 0.35)

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        # BlackHat (closing - original) responds to dark structures that are
        # smaller than the structuring element, i.e. precisely the local
        # "dark hole in the road" signature. Two scales cover small and large
        # potholes, and wide uniform bands (e.g. a shadow strip below a bright
        # stop line) produce no response because the closing matches them.
        scales = []
        for kernel_size in (61, 101):
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
            blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
            _, bh = cv2.threshold(blackhat, 15, 255, cv2.THRESH_BINARY)
            scales.append(bh)
        mask = cv2.bitwise_or(scales[0], scales[1])

        # Keep only genuinely dark, low-saturation pixels (road texture), which
        # drops bright markings, glare, and colored objects.
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        dark = cv2.inRange(hsv, (0, 0, 0), (180, 110, 160))
        mask = cv2.bitwise_and(mask, dark)
        mask[0 : horizon + 30, :] = 0
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        raw = []
        img_area = img_w * img_h
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            area = cv2.contourArea(c)
            if area < img_area * 0.0008 or area > img_area * 0.10:
                continue
            if w < 12 or h < 12:
                continue
            aspect = w / max(1, h)
            if aspect > 6 or aspect < 0.2:
                continue
            fill = area / max(1, w * h)
            if fill < 0.30:
                continue
            conf = float(np.clip(0.45 + 0.30 * fill + 0.1 * (area / max(1, img_w * 0.03)), 0.45, 0.85))
            raw.append({
                "bbox": {"x": x, "y": y, "w": w, "h": h},
                "confidence": round(conf, 3),
                "detection_source": "cv-fallback",
            })

        # Greedy NMS by area (keep larger overlapping boxes).
        raw.sort(key=lambda d: d["bbox"]["w"] * d["bbox"]["h"], reverse=True)
        kept = []
        for d in raw:
            if not any(_iou(d["bbox"], k["bbox"]) > 0.4 for k in kept):
                kept.append(d)
        return kept
