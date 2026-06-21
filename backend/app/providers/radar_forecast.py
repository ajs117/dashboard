"""Rain prediction for the observer's location.

RainViewer gives past frames plus (sometimes) short nowcast frames. Sampling only the
exact point misses rain that is clearly visible nearby and heading in, so we sample a
box around the location across the most recent frames and:
  - report whether it's raining *at* the location now,
  - find the nearest rain and how far away it is,
  - estimate an arrival time from how the nearest-rain distance is changing.

Tile maths is pure (unit-tested); pixel sampling needs Pillow.
"""
from __future__ import annotations

import asyncio
import io
import math
import time
from typing import Any

from . import client
from . import radar as radar_provider

_RAIN_ALPHA = 25            # tile alpha at/above this = precipitation
_AREA_ZOOM = 5              # lower zoom -> one tile covers the whole search area
_BOX_PX = 20               # search radius in pixels (~60 km at z5, UK latitude)
_MAX_FRAMES = 5            # most recent frames to analyse (~40 min of history)
_NEAR_KM = 30.0           # rain this close (or closer) counts as "nearby"
_APPROACH_KM = 65.0       # rain closing in from up to here can still be "approaching"


def latlon_to_tile(lat: float, lon: float, z: int) -> tuple[int, int, int, int]:
    """Web-Mercator tile (x, y) at zoom z plus the (px, py) pixel within a 256px tile."""
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    tx, ty = int(x), int(y)
    px = min(255, max(0, int((x - tx) * 256)))
    py = min(255, max(0, int((y - ty) * 256)))
    return tx, ty, px, py


def classify(alpha: int) -> tuple[str, int]:
    """Map a tile pixel's alpha to a precip level."""
    if alpha < _RAIN_ALPHA:
        return "none", 0
    if alpha < 90:
        return "light", 1
    if alpha < 170:
        return "moderate", 2
    return "heavy", 3


def km_per_pixel(lat: float, z: int) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z) / 1000.0


_UNKNOWN = {"center_alpha": None, "nearest_km": None, "center_level": "unknown"}


def _scan(content: bytes, lat: float, px: int, py: int) -> dict[str, Any]:
    """CPU-bound: decode the tile and scan the box. Runs in a worker thread."""
    from PIL import Image  # lazy import so the app starts without Pillow

    try:
        img = Image.open(io.BytesIO(content)).convert("RGBA")
    except Exception:  # noqa: BLE001
        return dict(_UNKNOWN)
    pix = img.load()  # one pixel-access object beats thousands of getpixel() calls
    kmpp = km_per_pixel(lat, _AREA_ZOOM)
    center_alpha = 0
    nearest_px = None
    for dy in range(-_BOX_PX, _BOX_PX + 1):
        y = py + dy
        if not (0 <= y <= 255):
            continue
        for dx in range(-_BOX_PX, _BOX_PX + 1):
            x = px + dx
            if not (0 <= x <= 255):
                continue
            a = pix[x, y][3]
            if abs(dx) <= 1 and abs(dy) <= 1:
                center_alpha = max(center_alpha, a)
            if a >= _RAIN_ALPHA:
                d = math.hypot(dx, dy)
                if nearest_px is None or d < nearest_px:
                    nearest_px = d
    return {
        "center_alpha": center_alpha,
        "center_level": classify(center_alpha)[0],
        "nearest_km": round(nearest_px * kmpp, 1) if nearest_px is not None else None,
    }


async def _sample_area(host: str, path: str, lat: float, lon: float) -> dict[str, Any]:
    """Fetch one frame's tile and sample a box around the location.

    Returns center precip + nearest-rain distance (km) within the search radius. The
    image decode + pixel scan are CPU-bound, so they run off the event loop (important
    on a single-worker Pi Zero 2W).
    """
    tx, ty, px, py = latlon_to_tile(lat, lon, _AREA_ZOOM)
    url = f"{host}{path}/256/{_AREA_ZOOM}/{tx}/{ty}/4/1_0.png"
    try:
        r = await client().get(url)
        r.raise_for_status()
        content = r.content
    except Exception:  # noqa: BLE001
        return dict(_UNKNOWN)
    return await asyncio.to_thread(_scan, content, lat, px, py)


def build_forecast(series: list[dict], now: float) -> dict[str, Any]:
    """Pure: turn the per-frame area samples into a now/approaching summary.

    `series` is oldest->newest; each item: {time, center_alpha, nearest_km}.
    """
    if not series:
        return {"raining_now": False, "level": "none", "status": "unknown",
                "nearest_km": None, "minutes_until": None, "series": []}

    cur = series[-1]
    raining_now = bool(cur.get("center_alpha") and cur["center_alpha"] >= _RAIN_ALPHA)
    level = classify(cur.get("center_alpha") or 0)[0]
    nearest = cur.get("nearest_km")

    # Approach speed: linear fit of nearest_km vs minutes over frames that saw rain.
    pts = [(s["time"], s["nearest_km"]) for s in series if s.get("nearest_km") is not None]
    minutes_until = None
    approaching = False
    if len(pts) >= 2:
        t0 = pts[0][0]
        xs = [(t - t0) / 60.0 for t, _ in pts]
        ys = [k for _, k in pts]
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        den = sum((x - mx) ** 2 for x in xs)
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0.0
        if slope < -0.2 and nearest is not None and nearest > 0:   # closing in
            approaching = True
            eta = nearest / -slope
            if 0 < eta <= 120:
                minutes_until = round(eta)

    if raining_now:
        status = "raining"
    elif approaching and nearest is not None and nearest <= _APPROACH_KM:
        status = "approaching"
    elif nearest is not None and nearest <= _NEAR_KM:
        status = "nearby"
    else:
        status = "dry"

    return {
        "raining_now": raining_now,
        "level": level,
        "status": status,                 # raining | approaching | nearby | dry
        "nearest_km": nearest,
        "minutes_until": minutes_until,
        "series": series,
    }


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    lat, lon = float(loc.get("lat")), float(loc.get("lon"))

    rdata = await radar_provider.fetch(cfg)
    frames = rdata.get("frames", [])[-_MAX_FRAMES:]

    host = rdata.get("host")
    samples = await asyncio.gather(*[_sample_area(host, f["path"], lat, lon) for f in frames])
    series = [{"time": f["time"], **s} for f, s in zip(frames, samples)]

    out = build_forecast(series, time.time())
    out["location"] = loc.get("label", "")
    return out
