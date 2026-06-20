"""Rain start/stop prediction at the observer's exact location.

RainViewer gives past frames plus short-range *nowcast* (forecast) frames. We sample the
radar tile pixel over the user's lat/lon for every frame, classify precip intensity from
the tile's alpha channel, then report whether it's raining now and when the next
start/stop transition is expected.

The tile-coordinate maths is pure (and unit-tested); pixel sampling needs Pillow.
"""
from __future__ import annotations

import asyncio
import io
import math
import time
from typing import Any

from . import client
from . import radar as radar_provider


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
    if alpha < 25:
        return "none", 0
    if alpha < 90:
        return "light", 1
    if alpha < 170:
        return "moderate", 2
    return "heavy", 3


def _sample_alpha(img, px: int, py: int) -> int:
    """Max alpha in a 3x3 neighbourhood (robust to single-pixel noise)."""
    best = 0
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            x = min(255, max(0, px + dx))
            y = min(255, max(0, py + dy))
            p = img.getpixel((x, y))
            a = p[3] if len(p) > 3 else 255
            best = max(best, a)
    return best


_RAIN_ALPHA = 25            # alpha at/above this = precipitation
_TREND_HORIZON_MIN = 45     # how far the extrapolation is allowed to look ahead


async def _frame(host: str, path: str, z: int, tx: int, ty: int,
                 px: int, py: int) -> dict[str, Any]:
    from PIL import Image  # lazy import so the app starts without Pillow

    url = f"{host}{path}/256/{z}/{tx}/{ty}/4/1_0.png"  # scheme 4, smooth, no snow
    try:
        r = await client().get(url)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGBA")
        alpha = _sample_alpha(img, px, py)
        name, lvl = classify(alpha)
        return {"precip": lvl > 0, "level": name, "intensity": lvl, "alpha": alpha}
    except Exception:  # noqa: BLE001 - one bad tile shouldn't sink the forecast
        return {"precip": None, "level": "unknown", "intensity": None, "alpha": None}


def _slope_per_min(times: list[float], alphas: list[float]) -> float:
    """Least-squares slope of alpha vs minutes."""
    n = len(times)
    if n < 2:
        return 0.0
    xs = [(t - times[0]) / 60.0 for t in times]
    mx = sum(xs) / n
    my = sum(alphas) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return 0.0
    return sum((x - mx) * (a - my) for x, a in zip(xs, alphas)) / den


def extrapolate_change(times: list[float], alphas: list[float], now: float,
                       horizon_min: float = _TREND_HORIZON_MIN) -> dict | None:
    """Project the recent intensity trend at the point to the next rain start/stop.

    Used when RainViewer provides no nowcast frames. Fits a line through the last few
    observed alphas and finds where it crosses the rain threshold, within `horizon_min`.
    """
    pts = [(t, a) for t, a in zip(times, alphas) if a is not None]
    if len(pts) < 3:
        return None
    pts = pts[-4:]
    ts = [t for t, _ in pts]
    al = [a for _, a in pts]
    slope = _slope_per_min(ts, al)
    if abs(slope) < 0.5:            # essentially flat -> no confident transition
        return None
    cur_a, cur_t = al[-1], ts[-1]
    raining = cur_a >= _RAIN_ALPHA
    if not raining and slope > 0:
        kind = "start"
    elif raining and slope < 0:
        kind = "stop"
    else:
        return None
    eta = cur_t + (_RAIN_ALPHA - cur_a) / slope * 60.0
    mins = (eta - now) / 60.0
    if mins <= 0 or mins > horizon_min:
        return None
    return {"type": kind, "time": eta, "minutes": round(mins), "method": "trend"}


def build_forecast(series: list[dict], past_count: int, now: float) -> dict[str, Any]:
    """Pure: turn the per-frame precip series into a now/next-change summary.

    Prefers RainViewer nowcast (future) frames; falls back to trend extrapolation of the
    recent past frames when no nowcast is available.
    """
    if not series:
        return {"raining_now": False, "level": "unknown", "change": None,
                "minutes_until": None, "horizon_min": 0, "method": "none", "series": []}
    cur_idx = max(0, min(len(series) - 1, past_count - 1))
    current = series[cur_idx]
    raining_now = bool(current["precip"])
    future = series[cur_idx + 1:]

    change = None
    method = "none"
    for s in future:
        if raining_now and s["precip"] is False:
            change = {"type": "stop", "time": s["time"], "level": current["level"]}
            break
        if not raining_now and s["precip"]:
            change = {"type": "start", "time": s["time"], "level": s["level"]}
            break
    if change:
        method = "nowcast"

    horizon_min = max(0, round((series[-1]["time"] - now) / 60))
    # No usable nowcast horizon -> extrapolate from the recent trend.
    if change is None and horizon_min <= 0:
        past = series[: cur_idx + 1]
        ext = extrapolate_change([s["time"] for s in past],
                                 [s["alpha"] for s in past], now)
        if ext:
            change = {"type": ext["type"], "time": ext["time"]}
            method = "trend"
            horizon_min = _TREND_HORIZON_MIN

    minutes = max(0, round((change["time"] - now) / 60)) if change else None
    return {
        "raining_now": raining_now,
        "level": current["level"],
        "change": change,
        "minutes_until": minutes,
        "horizon_min": horizon_min,
        "method": method,
        "series": series,
    }


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    lat, lon = float(loc.get("lat")), float(loc.get("lon"))
    # RainViewer's free radar tiles cap at z7; higher zooms return a placeholder.
    z = min(7, int(cfg.get("radar", {}).get("forecast_zoom", 7)))

    rdata = await radar_provider.fetch(cfg)
    frames = rdata.get("frames", [])
    host = rdata.get("host")
    past_count = rdata.get("past_count", len(frames))

    tx, ty, px, py = latlon_to_tile(lat, lon, z)
    samples = await asyncio.gather(
        *[_frame(host, f["path"], z, tx, ty, px, py) for f in frames]
    )
    series = [{"time": f["time"], **s} for f, s in zip(frames, samples)]

    out = build_forecast(series, past_count, time.time())
    out["location"] = loc.get("label", "")
    return out
