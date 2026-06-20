"""Moon-phase calculation sanity checks against known dates."""
from __future__ import annotations

from datetime import datetime, timezone

from app.providers import moon


def test_known_full_moon():
    # 2026-01-03 was a full moon.
    p = moon.phase(datetime(2026, 1, 3, 12, 0, tzinfo=timezone.utc))
    assert p["name"] == "Full Moon"
    assert p["illumination"] > 0.95


def test_known_new_moon():
    # 2026-01-18 was a new moon.
    p = moon.phase(datetime(2026, 1, 18, 19, 0, tzinfo=timezone.utc))
    assert p["name"] == "New Moon"
    assert p["illumination"] < 0.05


def test_fields_present_and_bounded():
    p = moon.phase(datetime(2026, 6, 20, tzinfo=timezone.utc))
    assert 0.0 <= p["fraction"] <= 1.0
    assert 0.0 <= p["illumination"] <= 1.0
    assert 0 <= p["index"] <= 7
    assert p["name"]
