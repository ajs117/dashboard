"""Hive heating -> indoor temperature provider.

Phase 1 ships this disabled. Hive has no official API and the account uses 2FA, so a
headless Cognito login is blocked. Phase 3 uses a one-time token capture from the Hive web
app (stored in the gitignored Pi config), then refreshes via Cognito REFRESH_TOKEN_AUTH and
reads the heating receiver's `props.temperature`.

Until configured, `fetch` returns {"enabled": False} so the Indoor tile shows a neutral state.
"""
from __future__ import annotations

from typing import Any


def parse_indoor(js: dict[str, Any]) -> dict[str, Any]:
    """Pure: extract the indoor temperature (+ target if present) from a Hive /nodes payload.

    Hive reports the in-room temperature on the heating node as `props.temperature`; the
    target setpoint is `state.target`. Returns the current reading and the target.
    """
    nodes = js.get("nodes") or []
    for n in nodes:
        props = n.get("props") or {}
        temp = props.get("temperature")
        if isinstance(temp, (int, float)):
            state = n.get("state") or {}
            target = state.get("target")
            return {
                "enabled": True,
                "temperature_c": round(float(temp), 1),
                "target_c": float(target) if isinstance(target, (int, float)) else None,
            }
    return {"enabled": True, "temperature_c": None, "target_c": None}


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    h = (cfg.get("hive") or {})
    if not (h.get("enabled") and h.get("refresh_token")):
        return {"enabled": False}
    # Phase 3: refresh the Cognito token, GET /nodes, parse_indoor(...).
    return {"enabled": False}
