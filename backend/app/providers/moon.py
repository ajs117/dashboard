"""Moon phase, computed locally (no API needed).

Uses the well-known synodic-month approximation from a known new-moon epoch.
Accurate to within a few hours for phase naming, which is plenty for a dashboard.
"""
from __future__ import annotations

from datetime import datetime, timezone

_SYNODIC = 29.53058867          # days between new moons
_KNOWN_NEW_MOON = 2451550.1     # Julian date of a known new moon (2000-01-06 18:14 UTC)

_PHASE_NAMES = [
    "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
    "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent",
]


def _to_julian(dt: datetime) -> float:
    dt = dt.astimezone(timezone.utc)
    y, m = dt.year, dt.month
    d = dt.day + (dt.hour + dt.minute / 60 + dt.second / 3600) / 24
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def phase(dt: datetime | None = None) -> dict:
    dt = dt or datetime.now(timezone.utc)
    days_since = _to_julian(dt) - _KNOWN_NEW_MOON
    age = days_since % _SYNODIC
    if age < 0:
        age += _SYNODIC
    fraction = age / _SYNODIC                      # 0..1 through the cycle
    # Illuminated fraction of the disc (0 new -> 1 full -> 0 new).
    illumination = (1 - __import__("math").cos(2 * 3.141592653589793 * fraction)) / 2
    index = int((fraction * 8) + 0.5) % 8
    return {
        "age_days": round(age, 1),
        "fraction": round(fraction, 3),
        "illumination": round(illumination, 3),
        "name": _PHASE_NAMES[index],
        "index": index,
    }
