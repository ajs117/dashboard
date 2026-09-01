"""Data endpoints. Each is cached server-side and serves last-good data if upstream fails."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import config, watch
from ..cache import cache
from ..providers import (
    aircraft, air_quality, claude_usage, ecoflow, facts, flightwatch, govee, news, photos,
    radar, radar_forecast, ring, route, stocks, trains, weather,
)
from .config_api import require_admin, require_admin_or_local

# A failed Ring poll is worth retrying soon; a good one is expensive enough to keep.
_RING_ERROR_TTL = 20.0

router = APIRouter(prefix="/api", tags=["data"])


def _ttls() -> dict[str, int]:
    return config.get().get("cache", {})


@router.get("/weather")
async def get_weather() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("weather", 600)
    return await cache.get_or_fetch("weather", ttl, lambda: weather.fetch(cfg))


@router.get("/air")
async def get_air() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("air", 1800)
    return await cache.get_or_fetch("air", ttl, lambda: air_quality.fetch(cfg))


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


@router.get("/trains/watch")
async def get_train_watch() -> dict[str, Any]:
    """The followed service, refreshed. Envelope matches the other endpoints so the
    frontend's stale handling works unchanged; `data: null` simply means nothing is
    being watched."""
    w = watch.get()
    if not w:
        return {"data": None, "stale": False, "fetched_at": time.time()}
    cfg = config.get()
    ttl = _ttls().get("train_watch", 30)
    sid = w["service_id"]
    env = await cache.get_or_fetch(
        f"train_watch:{sid}", ttl, lambda: trains.fetch_service(cfg, sid))
    data = dict(env.get("data") or {})
    data["watch"] = w
    # Fill the board station's blanks from what the board knew when it was pushed.
    data["platform"] = data.get("platform") or w.get("platform")
    if w.get("std"):
        for s in data.get("stops") or []:
            if s.get("crs") == data.get("board_crs") and not s.get("st"):
                s["st"] = w["std"]
    return {**env, "data": data}


class WatchIn(BaseModel):
    service_id: str = Field(min_length=1, max_length=64)
    label: str | None = Field(default=None, max_length=120)
    std: str | None = Field(default=None, max_length=5)
    platform: str | None = Field(default=None, max_length=8)
    to_crs: str | None = Field(default=None, max_length=3)


@router.post("/trains/watch")
async def set_train_watch(
    body: WatchIn,
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin_or_local(request, x_admin_token)
    return {"ok": True, "watch": watch.set_watch(
        body.service_id, body.label, body.std, body.platform, body.to_crs)}


@router.delete("/trains/watch")
async def clear_train_watch(
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin_or_local(request, x_admin_token)
    watch.clear()
    return {"ok": True}


@router.get("/news")
async def get_news() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("news", 900)
    return await cache.get_or_fetch("news", ttl, lambda: news.fetch(cfg))


@router.get("/facts")
async def get_facts() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("facts", 3600)
    return await cache.get_or_fetch("facts", ttl, lambda: facts.fetch(cfg))


@router.get("/sensor")
async def get_sensor() -> dict[str, Any]:
    # Govee #1: the live local/outdoor reading that overrides the headline temperature.
    cfg = config.get()
    ttl = _ttls().get("indoor", 60)
    return await cache.get_or_fetch("sensor", ttl, lambda: govee.fetch(cfg))


@router.get("/solar")
async def get_solar() -> dict[str, Any]:
    cfg = config.get()
    ttl = _ttls().get("solar", 60)
    return await cache.get_or_fetch("solar", ttl, lambda: ecoflow.fetch(cfg))


@router.get("/indoor")
async def get_indoor() -> dict[str, Any]:
    # Govee #2: the indoor sensor shown on the home-strip Indoor tile.
    cfg = config.get()
    ttl = _ttls().get("indoor", 60)
    return await cache.get_or_fetch("indoor_room", ttl, lambda: govee.fetch(cfg, "govee_indoor"))


# --- Claude subscription usage ---------------------------------------------------------
# Not cached: fetch() is a local file read, and the cache's `age` would report when we last
# read the file rather than when the numbers were actually pushed — the only age that means
# anything here. The provider computes the real age instead.
@router.get("/claude-usage")
async def get_claude_usage() -> dict[str, Any]:
    data = await claude_usage.fetch(config.get())
    return {"data": data, "stale": bool(data.get("stale")),
            "age": data.get("age"), "error": None}


@router.post("/claude-usage")
async def post_claude_usage(
    body: dict[str, Any],
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Receive a usage snapshot from a machine that runs Claude Code.

    Admin-gated unlike the rest of the LAN API: this one WRITES to /data, so an accidental
    request from anything else on the network shouldn't be able to plant numbers here.
    """
    require_admin(x_admin_token)
    try:
        record = claude_usage.store(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "stored": record}


@router.get("/flights/watch")
async def get_watched_flights() -> dict[str, Any]:
    """Live status of the watched flights (config: watch_flights)."""
    cfg = config.get()
    ttl = _ttls().get("flightwatch", 30)
    return await cache.get_or_fetch("flightwatch", ttl, lambda: flightwatch.fetch(cfg))


_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _require_local(request: Request) -> None:
    """Camera imagery is only served to the kiosk itself (which loads from localhost).

    The rest of the API is deliberately open on the LAN, but a camera feed is a much
    bigger privacy exposure. The frontend holds no secret it could authenticate with, so
    a token would have to be readable by any LAN client anyway - restricting to loopback
    is the control that actually works here.
    """
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        raise HTTPException(status_code=403, detail="Ring endpoints are localhost-only")


@router.get("/ring/cameras")
async def get_ring_cameras(request: Request) -> dict[str, Any]:
    _require_local(request)
    cfg = config.get()
    ttl = _ttls().get("ring_cameras", 300)
    result = await cache.get_or_fetch("ring_cameras", ttl, lambda: ring.list_cameras(cfg))
    # list_cameras reports failure in its payload rather than raising, so the cache treats a
    # transient Ring timeout as a good value and pins "no cameras" on screen for the whole
    # TTL. Expire a failed result quickly so the next poll retries instead.
    data = result.get("data") or {}
    if isinstance(data, dict) and data.get("error"):
        cache.expire_after("ring_cameras", _RING_ERROR_TTL)
    return result


@router.get("/ring/snapshot/{cam_id}")
async def get_ring_snapshot(cam_id: str, request: Request) -> Response:
    _require_local(request)
    cfg = config.get()
    # Cache per-camera for the configured interval so the home tile and the Ring page
    # share one upstream fetch instead of each hitting Ring separately.
    ttl = float((cfg.get("ring") or {}).get("interval_seconds", 30))
    env = await cache.get_or_fetch(
        f"ring_snap:{cam_id}", ttl, lambda: ring.snapshot(cfg, cam_id)
    )
    got = env.get("data")
    if not got:
        raise HTTPException(status_code=404, detail="no snapshot (camera off or offline)")
    img, captured_at = got
    # Expose Ring's own capture time so the UI can show a real "updated Ns ago" instead of
    # a meaningless battery percentage. Age is computed here to avoid clock skew in the
    # browser, and the header is CORS-safelisted for same-origin reads anyway.
    return Response(content=img, media_type="image/jpeg", headers={
        "Cache-Control": "no-store",
        "X-Snapshot-Age": str(max(0, int(time.time() - captured_at))),
    })


@router.get("/govee/devices")
async def get_govee_devices() -> dict[str, Any]:
    # Helper to discover sku + device id once an API key is set.
    key = (config.get().get("govee", {}) or {}).get("api_key")
    if not key:
        raise HTTPException(status_code=400, detail="govee.api_key is not set in config")
    return await govee.list_devices(key)
