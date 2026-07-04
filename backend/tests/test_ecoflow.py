"""EcoFlow solar parsing (pure; no network/MQTT)."""
from __future__ import annotations

from app.providers import ecoflow as ef


def test_parse_solar_sums_pv_inputs():
    # STREAM pushes each PV input separately; total solar = their sum.
    s = {"powGetPv": 60.8, "powGetPv2": 57.0, "gridConnectionPower": 117.8, "other": 1}
    out = ef.parse_solar(s)
    assert out["enabled"] is True
    assert out["watts_now"] == 117.8
    assert out["grid_w"] == 117.8
    assert out["kwh_today"] is None


def test_parse_solar_pv_field_override():
    s = {"powGetPv2": 61.2, "customPv": 200}
    assert ef.parse_solar(s, "customPv")["watts_now"] == 200.0


def test_parse_solar_empty_state():
    out = ef.parse_solar({})
    assert out["watts_now"] is None and out["grid_w"] is None


def test_parse_solar_ignores_non_numeric():
    assert ef.parse_solar({"powGetPv": "x", "powGetPv2": 10})["watts_now"] == 10.0
