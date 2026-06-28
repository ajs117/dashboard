"""Hive indoor-temperature parsing (pure; no network)."""
from __future__ import annotations

from app.providers import hive


def _prod(temp):
    return {"type": "trvcontrol", "props": {"temperature": temp}, "state": {}}


def test_average_across_rooms():
    js = {"products": [_prod(22.0), _prod(23.0), _prod(24.0), _prod(23.0)]}
    out = hive.parse_indoor(js)
    assert out["enabled"] is True
    assert out["rooms"] == 4
    assert out["temperature_c"] == 23.0     # mean of the four


def test_ignores_products_without_temperature():
    js = {"products": [_prod(20.0), {"type": "x", "props": {}}, _prod(22.0)]}
    out = hive.parse_indoor(js)
    assert out["rooms"] == 2
    assert out["temperature_c"] == 21.0


def test_no_products():
    out = hive.parse_indoor({"products": []})
    assert out["enabled"] is True and out["temperature_c"] is None and out["rooms"] == 0
