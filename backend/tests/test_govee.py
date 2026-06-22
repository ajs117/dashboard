"""Govee device-state parsing (pure; no network)."""
from __future__ import annotations

from app.providers import govee


def _caps(*caps):
    return {"payload": {"capabilities": list(caps)}}


def test_parse_fahrenheit_source_converts_to_celsius():
    js = _caps(
        {"type": "devices.capabilities.online", "instance": "online", "state": {"value": True}},
        {"type": "devices.capabilities.property", "instance": "sensorTemperature", "state": {"value": 71.6}},
        {"type": "devices.capabilities.property", "instance": "sensorHumidity", "state": {"value": 48}},
    )
    out = govee.parse_state(js, reports_f=True)
    assert out["temperature_f"] == 71.6
    assert out["temperature_c"] == 22.0
    assert out["humidity"] == 48
    assert out["online"] is True


def test_parse_celsius_source():
    out = govee.parse_state(_caps({"instance": "sensorTemperature", "state": {"value": 22}}), reports_f=False)
    assert out["temperature_c"] == 22.0
    assert out["temperature_f"] == 71.6


def test_parse_humidity_as_dict():
    js = _caps({"instance": "sensorHumidity", "state": {"value": {"currentHumidity": 55}}})
    assert govee.parse_state(js)["humidity"] == 55


def test_parse_offline_and_missing():
    js = _caps({"instance": "online", "state": {"value": False}})
    out = govee.parse_state(js)
    assert out["online"] is False
    assert out["temperature_c"] is None and out["humidity"] is None


def test_parse_empty():
    out = govee.parse_state({})
    assert out == {
        "temperature_c": None, "temperature_f": None, "humidity": None, "online": None,
        "dew_point_c": None, "dew_point_f": None,
    }


def test_dew_point_derived():
    js = _caps(
        {"instance": "sensorTemperature", "state": {"value": 78.44}},   # 25.8°C
        {"instance": "sensorHumidity", "state": {"value": 46.6}},
    )
    out = govee.parse_state(js, reports_f=True)
    assert out["dew_point_c"] == 13.5      # Magnus formula
    assert out["dew_point_f"] == 56.3
