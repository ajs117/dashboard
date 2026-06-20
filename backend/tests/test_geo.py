"""Pure geometry helpers."""
from __future__ import annotations

import math

import pytest

from app.providers import geo


def test_compass16():
    assert geo.compass16(0) == "N"
    assert geo.compass16(90) == "E"
    assert geo.compass16(180) == "S"
    assert geo.compass16(270) == "W"
    assert geo.compass16(45) == "NE"
    assert geo.compass16(360) == "N"      # wraps
    assert geo.compass16(None) is None


def test_bearing_cardinal():
    # From equator/prime-meridian, due north and due east.
    assert geo.bearing(0, 0, 1, 0) == pytest.approx(0, abs=0.5)
    assert geo.bearing(0, 0, 0, 1) == pytest.approx(90, abs=0.5)
    assert geo.bearing(0, 0, -1, 0) == pytest.approx(180, abs=0.5)


def test_haversine_known_distance():
    # London -> Paris ~ 343 km.
    km = geo.haversine_km(51.5074, -0.1278, 48.8566, 2.3522)
    assert 330 < km < 360


def test_elevation_deg():
    # Aircraft directly overhead-ish: large angle. Far away + low: small angle.
    assert geo.elevation_deg(0.0, 30000) == 90.0          # zero ground distance
    assert geo.elevation_deg(1.0, 0) == 0.0               # on the ground
    # 10 km away at ~10 km altitude (~32800 ft) ≈ 45°.
    e = geo.elevation_deg(10.0, 32808)
    assert 40 < e < 50


def test_elevation_monotonic_with_altitude():
    low = geo.elevation_deg(5.0, 5000)
    high = geo.elevation_deg(5.0, 40000)
    assert high > low
