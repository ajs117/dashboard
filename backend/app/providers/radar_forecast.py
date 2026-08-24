"""Rain nowcast for the observer's exact location.

Driven by Open-Meteo's real precipitation numbers (mm) — current + 15-minutely — NOT by
sampling radar-tile pixels. (The old tile method read the PNG's alpha/opacity as if it
were intensity, so any precipitation showed as "heavy". Open-Meteo gives an actual mm
value at the point, which is what "is it raining here, and when does it start/stop" needs.)

The RainViewer tiles are still used for the visual map (see providers/radar.py); this
module only produces the text panel: raining now + intensity, minutes to start/stop, and
the wind direction the weather is coming from.
"""
from __future__ import annotations

from typing import Any

from . import client
from .geo import compass16

_URL = "https://api.open-meteo.com/v1/forecast"
_RAIN_MM_H = 0.1          # mm/hour at/above this counts as "raining"
_STEPS = 8               # 15-min steps to look ahead (8 = next 2 hours)


def classify_rate(mm_per_h: float) -> str:
    """UK Met-style rain rate bands (mm/hour)."""
    if mm_per_h < _RAIN_MM_H:
        return "none"
    if mm_per_h < 2.5:
        return "light"
    if mm_per_h < 7.6:
        return "moderate"
    return "heavy"


def build_forecast(precip: list[float], prob: list[int] | None,
                   wind_dir: float | None, step_min: int = 15) -> dict[str, Any]:
    """Pure: turn a 15-minutely precip series (mm/step, index 0 = now) into a nowcast."""
    precip = [float(p or 0.0) for p in (precip or [])]
    prob = prob or []
    n = len(precip)
    per_hour = 60.0 / step_min

    mm_now = precip[0] if n else 0.0
    level = classify_rate(mm_now * per_hour)
    raining = level != "none"

    start_idx = stop_idx = None
    if raining:
        for i in range(1, n):
            if precip[i] * per_hour < _RAIN_MM_H:
                stop_idx = i
                break
    else:
        for i in range(1, n):
            if precip[i] * per_hour >= _RAIN_MM_H:
                start_idx = i
                break

    status = "raining" if raining else ("starting" if start_idx is not None else "dry")
    timeline = [
        {"mm": round(precip[i], 2), "prob": (prob[i] if i < len(prob) else None)}
        for i in range(n)
    ]
    numeric_prob = [p for p in prob if isinstance(p, (int, float))]
    return {
        "raining_now": raining,
        "level": level,
        "status": status,
        "minutes_until_start": start_idx * step_min if start_idx is not None else None,
        "minutes_until_stop": stop_idx * step_min if stop_idx is not None else None,
        "from_compass": compass16(wind_dir) if wind_dir is not None else None,
        "wind_dir": wind_dir,
        "peak_mm": round(max(precip), 2) if precip else 0.0,
        "max_prob": max(numeric_prob) if numeric_prob else None,
        "timeline": timeline,
    }


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    params = {
        "latitude": loc.get("lat"),
        "longitude": loc.get("lon"),
        "timezone": loc.get("timezone", "auto"),
        "current": "precipitation,wind_direction_10m",
        "minutely_15": "precipitation,precipitation_probability",
        "forecast_minutely_15": _STEPS,
    }
    resp = await client().get(_URL, params=params)
    resp.raise_for_status()
    raw = resp.json()
    m = raw.get("minutely_15", {}) or {}
    cur = raw.get("current", {}) or {}
    out = build_forecast(
        m.get("precipitation") or [],
        m.get("precipitation_probability") or [],
        cur.get("wind_direction_10m"),
    )
    out["location"] = loc.get("label", "")
    return out
