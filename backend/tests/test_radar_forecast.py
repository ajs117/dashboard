"""Radar rain-prediction logic (pure parts: tile maths, classify, build, extrapolate)."""
from __future__ import annotations

from app.providers import radar_forecast as rf


def test_latlon_to_tile_ranges():
    tx, ty, px, py = rf.latlon_to_tile(51.5, -0.12, 8)
    assert tx == int(tx) and ty == int(ty)
    assert 0 <= px <= 255 and 0 <= py <= 255
    # London at z=8 sits in tile x=127/128, y=85 region.
    assert 120 <= tx <= 135
    assert 80 <= ty <= 90


def test_classify_levels():
    assert rf.classify(0) == ("none", 0)
    assert rf.classify(50) == ("light", 1)
    assert rf.classify(120) == ("moderate", 2)
    assert rf.classify(200) == ("heavy", 3)


def _series(levels, start=1_000_000, step=600):
    """Build a series with given intensity levels, 10-min spacing."""
    out = []
    for i, lvl in enumerate(levels):
        alpha = {0: 0, 1: 50, 2: 120, 3: 200}[lvl]
        out.append({"time": start + i * step, "intensity": lvl,
                    "precip": lvl > 0, "level": rf.classify(alpha)[0], "alpha": alpha})
    return out


def test_build_nowcast_start():
    # 3 past dry frames + 2 nowcast frames, second is rain -> "start".
    s = _series([0, 0, 0, 0, 1])
    now = s[2]["time"]
    out = rf.build_forecast(s, past_count=3, now=now)
    assert out["raining_now"] is False
    assert out["change"]["type"] == "start"
    assert out["method"] == "nowcast"


def test_build_nowcast_stop():
    s = _series([2, 2, 2, 1, 0])
    now = s[2]["time"]
    out = rf.build_forecast(s, past_count=3, now=now)
    assert out["raining_now"] is True
    assert out["change"]["type"] == "stop"
    assert out["method"] == "nowcast"


def test_build_trend_extrapolation_start():
    # All past frames (no nowcast). Rising alpha while still dry -> extrapolate a start.
    times = [1_000_000 + i * 600 for i in range(4)]
    alphas = [0, 5, 12, 20]                       # trending up toward the 25 threshold
    series = [{"time": t, "intensity": 0, "precip": False, "level": "none", "alpha": a}
              for t, a in zip(times, alphas)]
    now = times[-1]                               # "now" == last past frame -> no horizon
    out = rf.build_forecast(series, past_count=len(series), now=now)
    assert out["method"] == "trend"
    assert out["change"]["type"] == "start"
    assert out["minutes_until"] is not None and out["minutes_until"] > 0


def test_build_flat_no_change():
    s = _series([0, 0, 0, 0])
    out = rf.build_forecast(s, past_count=len(s), now=s[-1]["time"])
    assert out["change"] is None
    assert out["raining_now"] is False


def test_extrapolate_requires_trend():
    times = [0, 600, 1200, 1800]
    flat = [10, 10, 10, 10]
    assert rf.extrapolate_change(times, flat, now=1800) is None


def test_build_empty_series():
    out = rf.build_forecast([], past_count=0, now=0)
    assert out["raining_now"] is False
    assert out["change"] is None
