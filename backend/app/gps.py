"""GPS extraction from image EXIF metadata (fallback when the browser's
Geolocation API is unavailable or the user uploads without a position)."""

import io


def gps_from_exif(data: bytes):
    try:
        from PIL import ExifTags, Image

        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
        if not gps:
            return None
    except Exception:
        return None

    def _coord(tag, ref_tag):
        value = gps.get(tag)
        ref = gps.get(ref_tag)
        if not value or not ref:
            return None
        try:
            d, m, s = (float(x) for x in value)
        except (TypeError, ValueError):
            return None
        dec = d + m / 60.0 + s / 3600.0
        if ref in ("S", "W"):
            dec = -dec
        return round(dec, 6)

    lat = _coord(ExifTags.GPSTAGS.get("GPSLatitude", 2), ExifTags.GPSTAGS.get("GPSLatitudeRef", 1))
    lng = _coord(ExifTags.GPSTAGS.get("GPSLongitude", 4), ExifTags.GPSTAGS.get("GPSLongitudeRef", 3))
    if lat is None or lng is None:
        return None
    return {"lat": lat, "lng": lng}
