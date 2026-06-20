"""Nearest-aircraft provider via airplanes.live (no auth, 1 req/sec limit).

Endpoint: http://api.airplanes.live/v2/point/{lat}/{lon}/{radius_nm}
Response follows the ADSBExchange v2 format: {"ac": [ ... ]}.

For each aircraft we also compute where to *look* from the observer: compass bearing
(azimuth), elevation angle above the horizon, and slant distance in miles.
"""
from __future__ import annotations

from typing import Any

from . import RateLimiter, client
from .geo import KM_PER_NM, MI_PER_KM, bearing, compass16, elevation_deg, haversine_km

_BASE = "https://api.airplanes.live/v2/point"
_limiter = RateLimiter(min_interval=1.05)  # respect the 1 req/sec limit


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    ac_cfg = cfg.get("aircraft", {})
    lat = float(loc.get("lat"))
    lon = float(loc.get("lon"))
    radius = int(ac_cfg.get("radius_nm", 50))
    limit = int(ac_cfg.get("max_results", 12))

    await _limiter.wait()
    url = f"{_BASE}/{lat}/{lon}/{radius}"
    resp = await client().get(url)
    resp.raise_for_status()
    raw = resp.json()

    out = []
    for ac in raw.get("ac", []) or []:
        a_lat, a_lon = ac.get("lat"), ac.get("lon")
        if a_lat is None or a_lon is None:
            continue
        ground_km = haversine_km(lat, lon, a_lat, a_lon)
        alt = ac.get("alt_baro")
        if alt == "ground":
            alt = 0
        brg = bearing(lat, lon, a_lat, a_lon)
        out.append({
            "hex": ac.get("hex"),
            "callsign": (ac.get("flight") or "").strip() or None,
            "type": ac.get("t"),
            "registration": ac.get("r"),
            "lat": a_lat,
            "lon": a_lon,
            "altitude": alt,
            "speed": ac.get("gs"),          # ground speed, knots
            "heading": ac.get("track"),
            "vertical_rate": ac.get("baro_rate"),
            # Where to look from the observer:
            "azimuth": round(brg),
            "compass": compass16(brg),
            "elevation": elevation_deg(ground_km, alt if isinstance(alt, (int, float)) else None),
            "distance_mi": round(ground_km * MI_PER_KM, 1),
            "distance_nm": round(ground_km / KM_PER_NM, 1),
            "_km": ground_km,
        })

    out.sort(key=lambda a: a["_km"])
    out = out[:limit]
    for a in out:
        a.pop("_km", None)

    return {
        "center": {"lat": lat, "lon": lon, "label": loc.get("label", "")},
        "radius_nm": radius,
        "count": len(out),
        "aircraft": out,
    }
