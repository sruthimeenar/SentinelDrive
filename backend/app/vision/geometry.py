import math

import cv2
import numpy as np

# Painted lane-line width (US standard) used as the in-frame reference object of
# known size for monocular scale calibration.
LANE_LINE_WIDTH_M = 0.125

# Existing cost formula: Cost = Volume * Price_PMB + Labor + Sealing.
PMB_PRICE_PER_M3 = 185.0
LABOR_COST = 42.0
SEALING_COST = 18.0

MATERIAL_SPEC = "PMB-25 Polymer-Modified Bitumen + elastomeric edge sealant"


class CameraModel:
    """Nominal forward-facing dashcam projection (absolute-scale anchor).

    True volumetric depth requires stereo vision or LiDAR. A monocular frame
    carries no absolute scale, so we calibrate against a known-size reference in
    frame (painted lane line -> LANE_LINE_WIDTH_M) or, failing that, an assumed
    pinhole camera pitched so the horizon sits at ``horizon_frac`` of the frame
    with the lens at ``cam_h_m`` above the road. Every measurement built from
    this stays flagged ``volume_estimated`` / ``accuracy.mode = monocular-estimated``.
    """

    def __init__(self, img_w, img_h, horizon_frac=0.35, fov_v_deg=55.0, cam_h_m=1.30):
        self.img_w = int(img_w)
        self.img_h = int(img_h)
        self.cam_h_m = cam_h_m
        self.horizon_row = self.img_h * horizon_frac
        self.f_px = (self.img_h / 2.0) / math.tan(math.radians(fov_v_deg) / 2.0)

    def ground_distance(self, row):
        """Distance along the road plane to the point imaged at ``row`` (m)."""
        dpx = row - self.horizon_row
        if dpx < 4.0:
            dpx = 4.0
        return self.cam_h_m * self.f_px / dpx

    def m_per_px_h(self, row):
        """World width represented by one horizontal pixel at ``row`` (m)."""
        return self.ground_distance(row) / self.f_px

    def m_per_px_v(self, row):
        """World extent along the road spanned by one vertical pixel at ``row`` (m)."""
        d = self.ground_distance(row)
        return d * d / (self.cam_h_m * self.f_px)


def lane_line_m_per_px_h(bgr, row):
    """Calibrate horizontal m-per-px from a painted lane line near ``row``.

    Dashcam lane markings run vertically in the frame, so we search a band of
    rows around ``row`` for the widest horizontal run of marking pixels (a
    ~0.125 m painted line) and derive the local scale from it. Returns None
    when no clear painted marking is found.
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 180), (180, 60, 255))
    yellow = cv2.inRange(hsv, (15, 60, 120), (45, 255, 255))
    mask = cv2.bitwise_or(white, yellow)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 15), np.uint8))

    best_px = 0
    lo = max(0, int(row) - 40)
    hi = min(bgr.shape[0] - 1, int(row) + 40)
    for r in range(lo, hi + 1):
        row_bin = mask[r, :] > 0
        edges = np.diff(np.r_[False, row_bin, False].astype(np.int8))
        starts = np.where(edges == 1)[0]
        ends = np.where(edges == -1)[0]
        for a, b in zip(starts, ends):
            if b - a >= 15:
                best_px = max(best_px, int(b - a))
    if best_px <= 0:
        return None
    return LANE_LINE_WIDTH_M / best_px


def estimate_depression(bgr, bbox, depth_map=None):
    """Depression depth (m) for a pothole bbox.

    ``depth_map`` (optional) is a relative monocular depth map (0..1, farther =
    larger). A pothole reads slightly farther than its surrounding road, so the
    depth-map contrast scales the estimate. Without it we use a brightness
    contrast proxy (a dark hole against lit asphalt). Either way the result is a
    calibrated estimate, never a measured value.
    """
    img_h, img_w = bgr.shape[:2]
    x, y, w, h = (int(v) for v in (bbox["x"], bbox["y"], bbox["w"], bbox["h"]))
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = max(1, min(w, img_w - x))
    h = max(1, min(h, img_h - y))
    cam = CameraModel(img_w, img_h)
    mpp_v = cam.m_per_px_v(y + h - 1)  # vertical metres per px at the bbox bottom row

    if depth_map is not None and depth_map.shape[:2] == (img_h, img_w):
        cy = min(y + h // 2, img_h - 1)
        cx = min(x + w // 2, img_w - 1)
        r = max(8, min(w, h) // 3)
        hole = depth_map[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
        ring = np.concatenate([
            depth_map[max(0, cy - 2 * r):cy, max(0, cx - r):cx + r + 1].ravel(),
            depth_map[cy + 1:cy + 2 * r + 1, max(0, cx - r):cx + r + 1].ravel(),
        ])
        if hole.size and ring.size:
            med_hole = float(np.median(hole))
            med_ring = float(np.median(ring))
            if med_ring > 1e-6:
                rel = abs(med_hole - med_ring) / med_ring
                factor = float(np.clip(0.06 + 0.30 * rel, 0.03, 0.25))
                return max(0.03, factor * (h * mpp_v))

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    sub = gray[y:y + h, x:x + w]
    if sub.size == 0:
        return 0.05
    border = max(4, min(w, h) // 4)
    ring = cv2.copyMakeBorder(sub, border, border, border, border, cv2.BORDER_REPLICATE)
    inner = float(np.median(sub))
    outer = float(np.median(ring))
    contrast = max(0.0, (outer - inner) / (outer + 1e-6))
    factor = float(np.clip(0.05 + 0.22 * contrast, 0.03, 0.25))
    return max(0.03, factor * (h * mpp_v))


def compute_measurements(bgr, bbox, depth_map=None):
    """Area / depth / volume for a detected pothole, all flagged estimated."""
    img_h, img_w = bgr.shape[:2]
    cam = CameraModel(img_w, img_h)
    x, y, w, h = (int(v) for v in (bbox["x"], bbox["y"], bbox["w"], bbox["h"]))
    row_bottom = min(y + h - 1, img_h - 1)

    mpp_h_ref = lane_line_m_per_px_h(bgr, row_bottom)
    mpp_h = mpp_h_ref if mpp_h_ref else cam.m_per_px_h(row_bottom)
    mpp_v = cam.m_per_px_v(row_bottom)

    width_m = w * mpp_h
    length_m = h * mpp_v
    # Bounding rectangle -> elliptical approximation of the hole opening.
    area_m2 = width_m * length_m * (math.pi / 4.0)
    depth_m = estimate_depression(bgr, bbox, depth_map)
    volume_m3 = max(0.0, area_m2 * depth_m)

    reference = "painted-lane-line" if mpp_h_ref else "assumed-camera-model"
    return {
        "bbox": {"x": x, "y": y, "w": w, "h": h},
        "area": round(area_m2, 4),
        "depth": round(depth_m, 4),
        "volume": round(volume_m3, 6),
        "volume_estimated": True,
        "accuracy": {
            "mode": "monocular-estimated",
            "reference": reference,
            "depth_signal": "depth-map" if depth_map is not None else "brightness-contrast",
            "upgrade_path": "stereo-vision-or-LiDAR",
        },
    }


def pothole_cost(volume):
    """Keep the existing formula: Cost = Volume x Price_PMB + Labor + Sealing."""
    material = round(volume * PMB_PRICE_PER_M3, 2)
    return {
        "material": material,
        "labor": LABOR_COST,
        "sealing": SEALING_COST,
        "unit_price_pmb": PMB_PRICE_PER_M3,
    }
