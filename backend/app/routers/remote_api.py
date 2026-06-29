"""Remote-control + settings API for the on-network control page.

No auth by request (trusted home LAN). As a safety net, secret values (tokens/keys/PII)
are write-only: GET masks them, POST keeps the existing value unless a new one is sent.
"""
from __future__ import annotations

import subprocess
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, remote

router = APIRouter(prefix="/api", tags=["remote"])

# Keys whose values are never sent to the browser and are only ever overwritten.
SECRET_KEYS = {
    "admin_token", "token", "api_key", "access_key", "secret_key", "refresh_token",
    "licence_number", "national_insurance", "postcode", "search_id", "account_id",
}
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
    action: str                 # "go" | "reload"
    value: str | None = None    # for "go": the route (home/aircraft/radar/trains/tracker)


@router.post("/remote/cmd")
async def post_cmd(body: CmdIn) -> dict[str, Any]:
    return remote.set_cmd(body.action, body.value)


@router.post("/remote/reboot")
async def reboot() -> dict[str, Any]:
    try:
        subprocess.run(["sudo", "-n", "/usr/sbin/reboot"], check=True, timeout=10)
    except Exception as e:  # noqa: BLE001 - surface why (likely missing sudoers entry)
        raise HTTPException(status_code=500, detail=f"reboot failed: {e}")
    return {"ok": True}


# --- full settings (secrets write-only) ---------------------------------------------
@router.get("/admin/config")
async def get_full_config() -> dict[str, Any]:
    return _mask(config.get())


@router.post("/admin/config")
async def patch_full_config(body: dict[str, Any]) -> dict[str, Any]:
    data = config.get()
    _merge(data, body)
    config.save()
    return {"ok": True, "config": _mask(config.get())}
