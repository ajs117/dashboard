"""Data endpoints. Each is cached server-side and serves last-good data if upstream fails."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from .. import config
from ..cache import cache
from ..providers import (
    aircraft, photos, radar, radar_forecast, route, stocks, trains, weather,
)

router = APIRouter(prefix="/api", tags=["data"])


def _ttls() -> dict[str, int]:
    return config.get().get("cache", {})


@router.get("/weather")
async def get_weather() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("weather", 600)
    return await cache.get_or_fetch("weather", ttl, lambda: weather.fetch(cfg))


@router.get("/radar")
async def get_radar() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("radar", 120)
    return await cache.get_or_fetch("radar", ttl, lambda: radar.fetch(cfg))


@router.get("/aircraft")
async def get_aircraft() -> dict[str, Any]:
    cfg = config.get()
    if not cfg.get("aircraft", {}).get("enabled", True):
        raise HTTPException(status_code=404, detail="aircraft module disabled")
    ttl = _ttls().get("aircraft", 5)
    return await cache.get_or_fetch("aircraft", ttl, lambda: aircraft.fetch(cfg))


@router.get("/aircraft/{hex_code}/photo")
async def get_aircraft_photo(hex_code: str) -> dict[str, Any]:
    # Photos rarely change; cache hard per-hex (24h).
    return await cache.get_or_fetch(
        f"photo:{hex_code.lower()}", 86400, lambda: photos.fetch(hex_code)
    )


@router.get("/route/{callsign}")
async def get_route(callsign: str) -> dict[str, Any]:
    # Routes are stable per callsign; cache for an hour.
    return await cache.get_or_fetch(
        f"route:{callsign.upper()}", 3600, lambda: route.fetch(callsign)
    )


@router.get("/stocks")
async def get_stocks() -> dict[str, Any]:
    cfg = config.get()
    if not cfg.get("stocks", {}).get("enabled", True):
        raise HTTPException(status_code=404, detail="stocks module disabled")
    ttl = _ttls().get("stocks", 300)
    return await cache.get_or_fetch("stocks", ttl, lambda: stocks.fetch(cfg))


@router.get("/radar/forecast")
async def get_radar_forecast() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("radar", 120)
    return await cache.get_or_fetch(
        "radar_forecast", ttl, lambda: radar_forecast.fetch(cfg)
    )


@router.get("/trains")
async def get_trains() -> dict[str, Any]:
    cfg = config.get()
    if not cfg.get("trains", {}).get("enabled", True):
        raise HTTPException(status_code=404, detail="trains module disabled")
    ttl = _ttls().get("trains", 30)
    return await cache.get_or_fetch("trains", ttl, lambda: trains.fetch(cfg))
