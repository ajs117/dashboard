"""In-memory remote-control command channel.

The phone/laptop remote POSTs a command (navigate the kiosk, reload it, …); the kiosk
polls GET /api/remote/cmd and acts when the sequence number advances. State is in memory
(a single kiosk, single command) and resets on restart — that's fine, it's transient.
"""
from __future__ import annotations

import time
from typing import Any

_cmd: dict[str, Any] = {"seq": 0, "action": None, "value": None, "at": 0.0}


def get_cmd() -> dict[str, Any]:
    return dict(_cmd)


def set_cmd(action: str, value: str | None = None) -> dict[str, Any]:
    _cmd["seq"] += 1
    _cmd["action"] = action
    _cmd["value"] = value
    _cmd["at"] = time.time()
    return dict(_cmd)
