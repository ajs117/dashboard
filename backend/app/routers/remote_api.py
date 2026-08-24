"""Admin-authenticated remote-control and settings API for the LAN control page."""
from __future__ import annotations

import asyncio
import subprocess
from copy import deepcopy
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, model_validator

from .. import config, remote
from ..cache import cache
from .config_api import require_admin

router = APIRouter(prefix="/api", tags=["remote"])

# Keys whose values are never sent to the browser and are only ever overwritten.
SECRET_KEYS = {
    "admin_token", "token", "api_key", "access_key", "secret_key", "refresh_token",
    "licence_number", "national_insurance", "postcode",
}   # NB: search_id/account_id are just identifiers, not secrets — editable in the remote
_MASK = "•••• (set)"


def _mask(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (_MASK if (k in SECRET_KEYS and v) else _mask(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask(x) for x in obj]
    return obj


def _merge(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if k in SECRET_KEYS:
            if v not in ("", None, _MASK):     # write-only: blank/placeholder = keep
                dst[k] = v
        elif isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v                          # lists (clocks/countdowns/…) replace wholesale


# --- kiosk command channel ----------------------------------------------------------
@router.get("/remote/cmd")
async def get_cmd() -> dict[str, Any]:
    return remote.get_cmd()


class CmdIn(BaseModel):
    action: Literal["go", "reload"]
    value: str | None = None    # for "go": the route (home/aircraft/radar/trains/tracker)

    @model_validator(mode="after")
    def valid_route(self):
        if self.action == "go" and self.value not in {
            "home", "aircraft", "radar", "trains", "tracker", "ring",
        }:
            raise ValueError("invalid dashboard route")
        return self


@router.post("/remote/cmd")
async def post_cmd(
    body: CmdIn,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    return remote.set_cmd(body.action, body.value)


@router.post("/remote/reboot")
async def reboot(x_admin_token: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(x_admin_token)
    try:
        await asyncio.to_thread(
            subprocess.run,
            ["sudo", "-n", "/usr/sbin/reboot"],
            check=True,
            timeout=10,
        )
    except Exception as e:  # noqa: BLE001 - surface why (likely missing sudoers entry)
        raise HTTPException(status_code=500, detail=f"reboot failed: {e}")
    return {"ok": True}


# --- full settings (secrets write-only) ---------------------------------------------
@router.get("/admin/config")
async def get_full_config(
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    return _mask(config.get())


@router.post("/admin/config")
async def patch_full_config(
    body: dict[str, Any],
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    data = config.get()
    candidate = deepcopy(data)
    _merge(candidate, body)
    try:
        config.validate(candidate)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    data.clear()
    data.update(candidate)
    config.save()
    cache.clear()
    return {"ok": True, "config": _mask(config.get())}
