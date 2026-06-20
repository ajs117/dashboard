"""Aircraft photo lookup via the Planespotters public API.

  GET https://api.planespotters.net/pub/photos/hex/{icao24}

Free for non-commercial use; results include a thumbnail URL and required
photographer attribution. Photos rarely change, so callers cache per-hex for a long TTL.
Returns None (not an error) when no photo exists, so the UI shows a placeholder.
"""
from __future__ import annotations

from typing import Any

from . import client

_BASE = "https://api.planespotters.net/pub/photos/hex"


async def fetch(hex_code: str) -> dict[str, Any] | None:
    hex_code = (hex_code or "").strip().lower()
    if not hex_code:
        return None
    resp = await client().get(f"{_BASE}/{hex_code}")
    resp.raise_for_status()
    photos = (resp.json() or {}).get("photos") or []
    if not photos:
        return None
    p = photos[0]
    thumb = p.get("thumbnail_large") or p.get("thumbnail") or {}
    return {
        "hex": hex_code,
        "thumbnail": thumb.get("src"),
        "width": (thumb.get("size") or {}).get("width"),
        "height": (thumb.get("size") or {}).get("height"),
        "link": p.get("link"),
        "photographer": p.get("photographer"),
    }
