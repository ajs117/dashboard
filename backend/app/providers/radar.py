"""RainViewer radar provider (no API key required).

Returns the tile host plus the list of available radar frames (past + nowcast).
The browser builds tile URLs as:
    {host}{frame.path}/{size}/{z}/{x}/{y}/{color}/{options}.png
and animates through the frames.
"""
from __future__ import annotations

from typing import Any

from . import client

_URL = "https://api.rainviewer.com/public/weather-maps.json"


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    resp = await client().get(_URL)
    resp.raise_for_status()
    raw = resp.json()

    radar = raw.get("radar", {})
    past = radar.get("past", []) or []
    nowcast = radar.get("nowcast", []) or []

    return {
        "host": raw.get("host", "https://tilecache.rainviewer.com"),
        "frames": past + nowcast,   # each: {time, path}
        "past_count": len(past),
        "nowcast_count": len(nowcast),
        "generated": raw.get("generated"),
    }
