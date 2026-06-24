"""Air-quality banding (pure; no network)."""
from __future__ import annotations

from app.providers import air_quality as aq


def test_aqi_bands():
    assert aq.aqi_band(10) == "Good"
    assert aq.aqi_band(35) == "Fair"
    assert aq.aqi_band(55) == "Moderate"
    assert aq.aqi_band(120) == "Extremely poor"
    assert aq.aqi_band(None) is None


def test_uv_bands():
    assert aq.uv_band(0) == "Low"
    assert aq.uv_band(5) == "Moderate"
    assert aq.uv_band(7) == "High"
    assert aq.uv_band(12) == "Extreme"


def test_pollen_bands():
    assert aq.pollen_band(10) == "Low"
    assert aq.pollen_band(40) == "Moderate"
    assert aq.pollen_band(239) == "Very high"


def test_parse_picks_dominant_pollen():
    cur = {
        "european_aqi": 35, "uv_index": 0.0, "pm2_5": 10.4, "pm10": 15.7,
        "grass_pollen": 239.1, "birch_pollen": 0.0, "alder_pollen": 0.0,
        "ragweed_pollen": 0.0,
    }
    out = aq.parse(cur)
    assert out["aqi"] == {"value": 35, "band": "Fair"}
    assert out["uv"] == {"value": 0, "band": "Low"}
    assert out["pollen"]["type"] == "Grass"
    assert out["pollen"]["value"] == 239
    assert out["pollen"]["band"] == "Very high"


def test_parse_empty():
    out = aq.parse({})
    assert out["aqi"]["value"] is None and out["aqi"]["band"] is None
    assert out["pollen"]["type"] is None
