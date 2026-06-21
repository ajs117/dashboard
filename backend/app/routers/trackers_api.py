"""Custom tracker endpoints.

  GET  /api/trackers              -> all trackers + whether any has an active alert
  POST /api/trackers/{id}/value   -> set a manual value {value: number}
  POST /api/trackers/{id}/ack     -> clear a tracker's alert
  POST /api/trackers/{id}/refresh -> run an auto tracker's fetch now

No admin token: the server binds 127.0.0.1, so only the local kiosk can reach it.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import trackers

router = APIRouter(prefix="/api/trackers", tags=["trackers"])


class ValueIn(BaseModel):
    value: float


@router.get("")
async def list_trackers() -> dict[str, Any]:
    return await trackers.list_public()


@router.post("/{tid}/value")
async def set_value(tid: str, body: ValueIn) -> dict[str, Any]:
    try:
        return await trackers.set_value(tid, body.value)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")


@router.post("/{tid}/ack")
async def ack(tid: str) -> dict[str, Any]:
    try:
        return await trackers.ack(tid)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")


@router.post("/{tid}/refresh")
async def refresh(tid: str) -> dict[str, Any]:
    try:
        return await trackers.refresh(tid)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown tracker")
