"""Rain nowcast logic (pure: rate classification + start/stop detection)."""
from __future__ import annotations

from app.providers import radar_forecast as rf


def test_classify_rate_bands():
    assert rf.classify_rate(0.0) == "none"
    assert rf.classify_rate(0.05) == "none"      # below 0.1 mm/h
    assert rf.classify_rate(1.0) == "light"
    assert rf.classify_rate(5.0) == "moderate"
    assert rf.classify_rate(10.0) == "heavy"


def test_dry_when_no_precip():
    # 8 x 15-min steps, all zero -> dry, no start/stop.
    out = rf.build_forecast([0.0] * 8, [10] * 8, wind_dir=225)
    assert out["raining_now"] is False
    assert out["status"] == "dry"
    assert out["level"] == "none"
    assert out["minutes_until_start"] is None
    assert out["from_compass"] == "SW"           # 225° -> SW


def test_raining_now_with_stop():
    # raining now (1.0 mm/15min = 4 mm/h -> moderate), stops at step 2 (=30 min).
    out = rf.build_forecast([1.0, 1.0, 0.0, 0.0], [90, 80, 10, 10], wind_dir=0)
    assert out["raining_now"] is True
    assert out["status"] == "raining"
    assert out["level"] == "moderate"
    assert out["minutes_until_stop"] == 30
    assert out["from_compass"] == "N"


def test_rain_starting():
    # dry now, starts at step 3 (=45 min).
    out = rf.build_forecast([0.0, 0.0, 0.0, 2.0, 2.0], [10, 20, 40, 80, 80], wind_dir=270)
    assert out["raining_now"] is False
    assert out["status"] == "starting"
    assert out["minutes_until_start"] == 45
    assert out["from_compass"] == "W"


def test_heavy_persisting_has_no_stop():
    out = rf.build_forecast([3.0] * 6, None, wind_dir=None)
    assert out["level"] == "heavy"          # 3 mm/15min = 12 mm/h
    assert out["minutes_until_stop"] is None
    assert out["from_compass"] is None
    assert out["peak_mm"] == 3.0


def test_empty_series():
    out = rf.build_forecast([], [], wind_dir=None)
    assert out["raining_now"] is False
    assert out["status"] == "dry"
    assert out["timeline"] == []
