import os


class DepthEngine:
    """Monocular depth estimation with a graceful fallback.

    Tier 1 — MiDaS (DPT) via ``torch.hub`` when torch/torchvision are installed
    (real per-pixel relative depth map; geometry.py combines it with the
    camera-model calibration for an absolute-scale depression estimate).

    Tier 2 — ``camera-model``: no depth model; geometry.py falls back to the
    assumed dashcam projection + brightness contrast.

    Regardless of tier the volume is flagged "estimated": true volumetric depth
    requires stereo vision or LiDAR (see ``accuracy.upgrade_path``).
    """

    def __init__(self):
        self.model = None
        self.transform = None
        self.tier = "camera-model"
        try:
            import torch  # noqa: F401
            import torchvision  # noqa: F401

            self._load_midas()
        except Exception:
            self.tier = "camera-model"

    def _load_midas(self):
        import torch

        cache = os.getenv("TORCH_HOME") or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", ".torch"
        )
        torch.hub.set_dir(cache)
        midas = torch.hub.load("intel-isl/MiDaS", "DPT_Large", trust_repo=True)
        midas.eval()
        transforms = torch.hub.load("intel-isl/MiDaS", "transforms", trust_repo=True)
        self.model = midas
        self.transform = transforms.dpt_transform
        self.tier = "midas"

    def estimate(self, bgr):
        """Return a relative depth map (0..1, farther = larger) or None."""
        if self.model is None or self.transform is None:
            return None
        import cv2
        import numpy as np
        import torch
        from PIL import Image

        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        with torch.no_grad():
            sample = self.transform(Image.fromarray(rgb)).unsqueeze(0)
            prediction = self.model(sample)
            depth = torch.nn.functional.interpolate(
                prediction.unsqueeze(1),
                size=(bgr.shape[0], bgr.shape[1]),
                mode="bicubic",
                align_corners=False,
            ).squeeze().cpu().numpy()
        dmin, dmax = float(depth.min()), float(depth.max())
        if dmax - dmin < 1e-6:
            return None
        return (depth - dmin) / (dmax - dmin)
