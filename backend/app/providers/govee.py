"""Govee Wi-Fi thermo-hygrometer -> indoor temperature & humidity (Govee Platform API).

  POST https://openapi.api.govee.com/router/api/v1/device/state
       header: Govee-API-Key: <key>
       body:   {"requestId": "...", "payload": {"sku": "H5179", "device": "AA:BB:.."}}

The response's `payload.capabilities[]` carries instances "sensorTemperature" (°F),
"sensorHumidity" (%), and "online". Disabled until an API key + device + sku are set:
  - API key:  Govee Home app -> Settings -> Apply for API Key
  - device/sku: GET .../user/devices  (exposed here as /api/govee/devices)
"""
from __future__ import annotations

from typing import Any

from . import client

_BASE = "https://openapi.api.govee.com/router/api/v1"


def _num(v: Any) -> float | None:
    """Pull a number out of a Govee state value (sometimes a dict)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dict):
        for k in ("currentHumidity", "temperature", "value"):
            n = v.get(k)
            if isinstance(n, (int, float)) and not isinstance(n, bool):
                return float(n)
    return None


def parse_state(js: dict, reports_f: bool = True) -> dict[str, Any]:
    """Pure: turn a device/state response into temp (°C and °F), humidity %, online."""
    payload = js.get("payload", {}) or {}
    caps = payload.get("capabilities", []) or []
    out: dict[str, Any] = {
        "temperature_c": None, "temperature_f": None, "humidity": None, "online": None,
    }
    for c in caps:
        inst = (c.get("instance") or "").lower()
        val = (c.get("state") or {}).get("value")
        if "temperature" in inst:
            t = _num(val)
            if t is not None:
                if reports_f:
                    out["temperature_f"] = round(t, 1)
                    out["temperature_c"] = round((t - 32) * 5 / 9, 1)
                else:
                    out["temperature_c"] = round(t, 1)
                    out["temperature_f"] = round(t * 9 / 5 + 32, 1)
        elif "humidity" in inst:
            h = _num(val)
            if h is not None:
                out["humidity"] = round(h, 1)
        elif inst == "online":
            out["online"] = bool(val) if val is not None else None
    return out


async def list_devices(api_key: str) -> dict[str, Any]:
    """List the account's Govee devices (to discover sku + device id)."""
    resp = await client().get(f"{_BASE}/user/devices", headers={"Govee-API-Key": api_key})
    resp.raise_for_status()
    return resp.json()


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    g = cfg.get("govee", {}) or {}
    if not (g.get("enabled") and g.get("api_key") and g.get("device") and g.get("sku")):
        return {"enabled": False}
    body = {"requestId": "dashboard", "payload": {"sku": g["sku"], "device": g["device"]}}
    resp = await client().post(
        f"{_BASE}/device/state",
        headers={"Govee-API-Key": g["api_key"], "Content-Type": "application/json"},
        json=body,
    )
    resp.raise_for_status()
    js = resp.json()
    # Govee returns HTTP 200 even for auth/rate-limit/bad-device errors, signalling them
    # via an in-body code. Treat those as failures so the cache serves last-good instead
    # of silently showing a fake "live" reading with no values.
    code = js.get("code")
    if code not in (200, None):
        raise RuntimeError(f"Govee API error code {code}: {js.get('message', '')}")
    data = parse_state(js, reports_f=g.get("reports_fahrenheit", True))
    data["enabled"] = True
    data["label"] = g.get("label", "Sensor")
    return data
