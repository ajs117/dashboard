"""Radar rain-prediction logic (pure parts: tile maths, classify, area forecast)."""
from __future__ import annotations

from app.providers import radar_forecast as rf


def test_latlon_to_tile_ranges():
    tx, ty, px, py = rf.latlon_to_tile(51.5, -0.12, 8)
    assert tx == int(tx) and ty == int(ty)
    assert 0 <= px <= 255 and 0 <= py <= 255
    assert 120 <= tx <= 135 and 80 <= ty <= 90


def test_classify_levels():
    assert rf.classify(0) == ("none", 0)
    assert rf.classify(50) == ("light", 1)
    assert rf.classify(120) == ("moderate", 2)
    assert rf.classify(200) == ("heavy", 3)


def test_km_per_pixel_positive():
    assert rf.km_per_pixel(52.4, 5) > 0


def _series(items, start=1_000_000, step=600):
    """items: list of (center_alpha, nearest_km); oldest->newest, 10-min spacing."""
    return [{"time": start + i * step, "center_alpha": a, "nearest_km": k}
            for i, (a, k) in enumerate(items)]


def test_raining_now():
    s = _series([(0, 30), (50, 10), (200, 0)])
    out = rf.build_forecast(s, now=s[-1]["time"])
    assert out["raining_now"] is True
    assert out["status"] == "raining"
    assert out["level"] == "heavy"


def test_approaching_sets_eta():
    # Nearest rain closing in: 60 -> 40 -> 20 km over 20 min.
    s = _series([(0, 60), (0, 40), (0, 20)])
    out = rf.build_forecast(s, now=s[-1]["time"])
    assert out["status"] == "approaching"
    assert out["minutes_until"] is not None and out["minutes_until"] > 0


def test_nearby_not_approaching():
    # Rain present and steady (~20 km), not closing.
    s = _series([(0, 20), (0, 21), (0, 20)])
    out = rf.build_forecast(s, now=s[-1]["time"])
    assert out["status"] == "nearby"
    assert out["raining_now"] is False


def test_dry_when_no_rain():
    s = _series([(0, None), (0, None), (0, None)])
    out = rf.build_forecast(s, now=s[-1]["time"])
    assert out["status"] == "dry"
    assert out["nearest_km"] is None


def test_empty_series():
    out = rf.build_forecast([], now=0)
    assert out["raining_now"] is False
    assert out["status"] == "unknown"
