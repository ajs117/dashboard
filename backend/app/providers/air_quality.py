"""Open-Meteo Air Quality provider (no API key) — AQI, UV and pollen.

  GET https://air-quality-api.open-meteo.com/v1/air-quality
      ?current=european_aqi,pm2_5,pm10,uv_index,grass_pollen,birch_pollen,...

Returns compact, banded values for the weather panel: a European AQI band, the UV index
band, and the dominant pollen (grass dominates UK summer; tree pollens in spring).
"""
from __future__ import annotations

from typing import Any

from . import client

_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# European AQI (EAQI) bands.
_AQI_BANDS = [(20, "Good"), (40, "Fair"), (60, "Moderate"), (80, "Poor"),
              (100, "Very poor")]
# UV index (WHO) bands.
_UV_BANDS = [(3, "Low"), (6, "Moderate"), (8, "High"), (11, "Very high")]
# Pollen grains/m³ (Met Office-style, grass/tree).
_POLLEN_BANDS = [(30, "Low"), (50, "Moderate"), (150, "High")]
_POLLENS = {
    "grass_pollen": "Grass", "birch_pollen": "Birch", "alder_pollen": "Alder",
    "ragweed_pollen": "Ragweed",
}


def _band(value: float | None, bands: list[tuple[float, str]], top: str) -> str | None:
    if value is None:
        return None
    for ceiling, name in bands:
        if value < ceiling:
            return name
    return top


def aqi_band(v):     # noqa: ANN001 - thin wrappers, typed via _band
    return _band(v, _AQI_BANDS, "Extremely poor")


def uv_band(v):
    return _band(v, _UV_BANDS, "Extreme")


def pollen_band(v):
    return _band(v, _POLLEN_BANDS, "Very high")


def parse(cur: dict[str, Any]) -> dict[str, Any]:
    """Pure: shape the `current` block into banded AQI / UV / dominant-pollen values."""
    aqi = cur.get("european_aqi")
    uv = cur.get("uv_index")
    # dominant pollen = the highest of the tracked species (most relevant to "should I
    # worry today"); carry its name so the UI can say e.g. "Grass · High".
    worst_name, worst_val = None, None
    for key, label in _POLLENS.items():
        val = cur.get(key)
        if isinstance(val, (int, float)) and (worst_val is None or val > worst_val):
            worst_name, worst_val = label, val
    return {
        "aqi": {"value": aqi, "band": aqi_band(aqi)},
        "uv": {"value": round(uv) if isinstance(uv, (int, float)) else None,
               "band": uv_band(uv)},
        "pollen": {"value": round(worst_val) if worst_val is not None else None,
                   "type": worst_name, "band": pollen_band(worst_val)},
        "pm2_5": cur.get("pm2_5"),
        "pm10": cur.get("pm10"),
    }


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    loc = cfg.get("location", {})
    params = {
        "latitude": loc.get("lat"),
        "longitude": loc.get("lon"),
        "timezone": loc.get("timezone", "auto"),
        "current": "european_aqi,pm2_5,pm10,uv_index,"
                   "grass_pollen,birch_pollen,alder_pollen,ragweed_pollen",
    }
    resp = await client().get(_URL, params=params)
    resp.raise_for_status()
    return parse(resp.json().get("current", {}) or {})
