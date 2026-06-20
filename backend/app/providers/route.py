"""Flight route (departure -> destination) by callsign via adsbdb.com (free, no key).

  GET https://api.adsbdb.com/v0/callsign/{callsign}

Returns None when the callsign/route is unknown, so the UI shows "route unknown"
rather than erroring. Routes are stable per callsign -> callers cache hard.
"""
from __future__ import annotations

from typing import Any

from . import client

_BASE = "https://api.adsbdb.com/v0/callsign"


def _airport(a: dict | None) -> dict | None:
    if not a:
        return None
    return {
        "iata": a.get("iata_code"),
        "icao": a.get("icao_code"),
        "name": a.get("name"),
        "city": a.get("municipality"),
        "country": a.get("country_name"),
    }


async def fetch(callsign: str) -> dict[str, Any] | None:
    callsign = (callsign or "").strip().upper()
    if not callsign:
        return None
    resp = await client().get(f"{_BASE}/{callsign}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    body = resp.json()
    fr = (body.get("response") or {})
    if not isinstance(fr, dict):
        return None  # e.g. "unknown callsign"
    fr = fr.get("flightroute")
    if not fr:
        return None
    airline = fr.get("airline") or {}
    return {
        "callsign": fr.get("callsign") or callsign,
        "airline": airline.get("name"),
        "origin": _airport(fr.get("origin")),
        "destination": _airport(fr.get("destination")),
    }
