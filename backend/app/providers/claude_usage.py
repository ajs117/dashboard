"""Claude subscription usage — the Pro plan's session (5h) and weekly limit windows.

The Pi cannot read these itself. The figures come from Anthropic's OAuth usage endpoint,
which is only reachable with the Claude Code login token — and that token ROTATES every
time it is refreshed. Copying it onto the Pi would put two machines in a refresh race, and
whichever refreshed last would silently log the other one out. So the Pi never holds the
token: a machine that already runs Claude Code pushes the numbers in (see
deploy/scripts/claude_usage_push.py) and this module only stores and serves them.

Consequence: when the pushing machine is off, the numbers age. That's surfaced as
`stale` rather than hidden, so the tile can say "not updating" instead of quietly showing
yesterday's percentage as if it were current.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .. import config

_FILENAME = "claude_usage.json"
_DEFAULT_MAX_AGE_MIN = 45


def _store_path() -> Path:
    # Alongside config.yaml, i.e. /data on the Pi — outside the git repo.
    src = config.source_path()
    return (src.parent if src else Path.cwd()) / _FILENAME


def _pct(value: Any) -> int | None:
    try:
        return max(0, min(100, round(float(value))))
    except (TypeError, ValueError):
        return None


def _window(block: Any) -> dict[str, Any] | None:
    """One limit window {percent, resets_at} from an upstream `five_hour`-shaped block."""
    if not isinstance(block, dict):
        return None
    percent = _pct(block.get("utilization"))
    if percent is None:
        return None
    resets_at = block.get("resets_at")
    return {"percent": percent, "resets_at": resets_at if isinstance(resets_at, str) else None}


def normalise(payload: dict[str, Any]) -> dict[str, Any]:
    """Upstream OAuth usage JSON -> the small shape the tile needs.

    Upstream carries a dozen experimental windows under code names that come and go; only
    the three stable ones are kept so a new field can't reshape the tile unannounced.
    """
    payload = payload or {}
    return {
        "session": _window(payload.get("five_hour")),
        "weekly": _window(payload.get("seven_day")),
        "opus": _window(payload.get("seven_day_opus")),
        "plan": payload.get("plan") or None,
        "updated_at": time.time(),
    }


def store(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist a pushed usage payload. Returns the normalised record."""
    record = normalise(payload)
    if record["session"] is None and record["weekly"] is None:
        raise ValueError("usage payload has neither a five_hour nor a seven_day window")
    path = _store_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record), encoding="utf-8")
    os.replace(tmp, path)        # atomic: a reader never sees a half-written file
    return record


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    conf = (cfg or {}).get("claude_usage") or {}
    out: dict[str, Any] = {
        "enabled": bool(conf.get("enabled", True)),
        "session": None, "weekly": None, "opus": None, "plan": None,
        "updated_at": None, "age": None, "stale": True,
    }
    if not out["enabled"]:
        return out
    try:
        record = json.loads(_store_path().read_text("utf-8"))
    except Exception:  # noqa: BLE001 - nothing pushed yet is a normal state, not an error
        return out
    for key in ("session", "weekly", "opus", "plan", "updated_at"):
        out[key] = record.get(key)
    updated_at = out.get("updated_at")
    if updated_at:
        age = max(0.0, time.time() - float(updated_at))
        max_age = float(conf.get("max_age_minutes", _DEFAULT_MAX_AGE_MIN)) * 60
        out["age"] = round(age)
        out["stale"] = age > max_age
    return out
