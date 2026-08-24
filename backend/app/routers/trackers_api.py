"""Custom tracker endpoints.

  GET  /api/trackers              -> all trackers + whether any has an active alert
  POST /api/trackers/{id}/value   -> set a manual value {value: number}
  POST /api/trackers/{id}/ack     -> clear a tracker's alert
  POST /api/trackers/{id}/refresh -> run an auto tracker's fetch now

No admin token: the server binds 127.0.0.1, so only the local kiosk can reach it.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .. import trackers
from .config_api import require_admin_or_local

router = APIRouter(prefix="/api/trackers", tags=["trackers"])


class ValueIn(BaseModel):
    value: float = Field(allow_inf_nan=False)


@router.get("")
async def list_trackers() -> dict[str, Any]:
    return await trackers.list_public()


@router.post("/{tid}/value")
async def set_value(
    tid: str,
    body: ValueIn,
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin_or_local(request, x_admin_token)
    try:
        return await trackers.set_value(tid, body.value)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")


@router.post("/{tid}/ack")
async def ack(
    tid: str,
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin_or_local(request, x_admin_token)
    try:
        return await trackers.ack(tid)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")


@router.post("/{tid}/refresh")
async def refresh(
    tid: str,
    request: Request,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin_or_local(request, x_admin_token)
    try:
        return await trackers.refresh(tid)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")
