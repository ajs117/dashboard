"""Pure geometry helpers: distances, bearing, compass, look-angle. No I/O -> easy to test."""
from __future__ import annotations

import math

_R_KM = 6371.0
_COMPASS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

KM_PER_NM = 1.852
MI_PER_KM = 0.621371
M_PER_FT = 0.3048


def compass16(deg: float | None) -> str | None:
    """Compass point (16-wind) for a bearing in degrees."""
    if deg is None:
        return None
    return _COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * _R_KM * math.asin(min(1.0, math.sqrt(a)))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing from point 1 -> point 2, degrees 0..360."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def elevation_deg(ground_km: float, altitude_ft: float | None) -> float:
    """Angle above the horizon to look at an aircraft (observer at ~sea level).

    Ignores Earth curvature — fine for the tens-of-miles range of a desk tracker.
    """
    if not altitude_ft or altitude_ft <= 0:
        return 0.0
    alt_m = altitude_ft * M_PER_FT
    ground_m = ground_km * 1000.0
    if ground_m <= 0:
        return 90.0
    return round(math.degrees(math.atan2(alt_m, ground_m)), 1)
