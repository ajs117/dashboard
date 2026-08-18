"""Config + location endpoints.

GET  /api/config          -> non-secret config for the browser
POST /api/location        -> push a new location (no GPS on the Pi)
POST /api/settings        -> patch other non-secret settings
Mutating endpoints require the admin token via the X-Admin-Token header.
"""
from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from .. import config

router = APIRouter(prefix="/api", tags=["config"])

# Placeholder tokens shipped in the example/template config — never accept these.
_INSECURE_TOKENS = {"", "change-me", "change-me-to-something-random"}


def require_admin(token: str | None) -> None:
    # If we're running on the committed example (no real config.yaml), refuse all
    # mutations — the example's admin_token is public, so honouring it is unsafe.
    if config.is_fallback():
        raise HTTPException(status_code=503,
                            detail="Config is read-only: no config.yaml present on this device")
    expected = config.get().get("admin_token")
    if not expected or expected in _INSECURE_TOKENS:
        raise HTTPException(status_code=503,
                            detail="Refusing writes: admin_token is unset or a default placeholder")
    # Constant-time compare to avoid leaking the token via response timing.
    if not hmac.compare_digest(str(token or ""), str(expected)):
        raise HTTPException(status_code=403, detail="Invalid or missing admin token")


class LocationIn(BaseModel):
    lat: float
    lon: float
    label: str | None = None
    timezone: str | None = None




@router.get("/config")
async def get_config() -> dict[str, Any]:
    return config.public()


@router.post("/location")
async def set_location(
    body: LocationIn,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    data = config.get()
    loc = data.setdefault("location", {})
    loc["lat"] = body.lat
    loc["lon"] = body.lon
    if body.label is not None:
        loc["label"] = body.label
    if body.timezone is not None:
        loc["timezone"] = body.timezone
    config.save()
    return {"ok": True, "location": loc}


@router.post("/settings")
async def patch_settings(
    body: dict[str, Any],
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    data = config.get()
    # Only allow patching known non-secret top-level sections.
    allowed = {"units", "world_clocks", "aircraft", "refresh"}
    for key, value in body.items():
        if key in allowed:
            data[key] = value
        elif key == "trains":
            # allow station/destination/rows but never the token
            t = data.setdefault("trains", {})
            for k in ("station_crs", "destination_crs", "rows", "enabled"):
                if k in value:
                    t[k] = value[k]
    config.save()
    return {"ok": True, "config": config.public()}
