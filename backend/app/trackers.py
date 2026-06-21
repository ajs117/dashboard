"""Custom 'watch this thing' trackers.

Each tracker is a small coded routine that produces a numeric value over time. The
framework records history, flags an alert when the value moves, and persists everything
to a JSON file on the writable partition so it survives restarts / power cuts.

Trackers can be:
  - kind "manual": the value is entered from the UI (POST /api/trackers/{id}/value).
  - kind "auto":   the value is produced by an async `fetch()` routine, run on a schedule.

The first tracker is the TUI holiday price (manual for now; see [[tui-price-scraping]]).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import config

# --- tracker definitions (coded routines) -------------------------------------------
# A definition: id -> {label, unit, kind, url?, fetch?}. `fetch` (auto only) is an async
# callable returning a float or None.
_DEFS: dict[str, dict[str, Any]] = {
    "holiday": {
        "label": "TUI Holiday",
        "unit": "£",
        "kind": "manual",
        "note": "Lanzarote · Jan 2027 · 2ad AI · BHX",
    },
}

_HISTORY_CAP = 60
_lock = asyncio.Lock()
_state: dict[str, dict[str, Any]] = {}
_loaded = False


def register_auto(tid: str, label: str, unit: str,
                  fetch: Callable[[], Awaitable[float | None]], **extra: Any) -> None:
    """Register an auto tracker (used to bolt on the TUI price routine later)."""
    _DEFS[tid] = {"label": label, "unit": unit, "kind": "auto", "fetch": fetch, **extra}


def _state_path() -> Path:
    src = config.source_path()
    base = src.parent if src else Path.cwd()
    return base / "trackers_state.json"


def _load() -> None:
    global _state, _loaded
    if _loaded:
        return
    p = _state_path()
    try:
        _state = json.loads(p.read_text("utf-8")) if p.is_file() else {}
    except Exception:  # noqa: BLE001 - corrupt file shouldn't break the app
        _state = {}
    _loaded = True


def _save() -> None:
    p = _state_path()
    tmp = p.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(_state), "utf-8")
        os.replace(tmp, p)  # atomic
    except Exception:  # noqa: BLE001 - best-effort persistence
        pass


def _entry(tid: str) -> dict[str, Any]:
    return _state.setdefault(tid, {
        "value": None, "baseline": None, "updated_at": None,
        "history": [], "alert": None,
    })


def _apply(tid: str, value: float, source: str) -> dict[str, Any]:
    """Record a new value, updating history + alert. Caller holds the lock."""
    st = _entry(tid)
    prev = st.get("value")
    now = time.time()
    if st.get("baseline") is None:
        st["baseline"] = value
    if prev is not None and value != prev:
        st["alert"] = {
            "active": True,
            "direction": "up" if value > prev else "down",
            "delta": round(value - prev, 2),
            "from": prev, "to": value, "at": now,
        }
    st["value"] = value
    st["updated_at"] = now
    st["source"] = source
    hist = st.setdefault("history", [])
    hist.append([now, value])
    del hist[:-_HISTORY_CAP]
    _save()
    return st


def _public_one(tid: str, d: dict[str, Any]) -> dict[str, Any]:
    st = _entry(tid)
    value = st.get("value")
    baseline = st.get("baseline")
    change = round(value - baseline, 2) if (value is not None and baseline is not None) else None
    return {
        "id": tid,
        "label": d.get("label", tid),
        "unit": d.get("unit", ""),
        "kind": d.get("kind", "manual"),
        "note": d.get("note", ""),
        "value": value,
        "baseline": baseline,
        "change": change,
        "updated_at": st.get("updated_at"),
        "history": st.get("history", []),
        "alert": st.get("alert"),
    }


async def list_public() -> dict[str, Any]:
    async with _lock:
        _load()
        items = [_public_one(tid, d) for tid, d in _DEFS.items()]
    any_alert = any(i["alert"] and i["alert"].get("active") for i in items)
    return {"trackers": items, "alert": any_alert}


async def set_value(tid: str, value: float) -> dict[str, Any]:
    async with _lock:
        _load()
        if tid not in _DEFS:
            raise KeyError(tid)
        _apply(tid, float(value), "manual")
        return _public_one(tid, _DEFS[tid])


async def ack(tid: str) -> dict[str, Any]:
    async with _lock:
        _load()
        if tid not in _DEFS:
            raise KeyError(tid)
        st = _entry(tid)
        if st.get("alert"):
            st["alert"]["active"] = False
        _save()
        return _public_one(tid, _DEFS[tid])


async def refresh(tid: str) -> dict[str, Any]:
    """Run an auto tracker's fetch routine now and record the result."""
    d = _DEFS.get(tid)
    if not d:
        raise KeyError(tid)
    if d.get("kind") != "auto" or not d.get("fetch"):
        # manual trackers have nothing to fetch; just return current state
        async with _lock:
            _load()
            return _public_one(tid, d)
    value = await d["fetch"]()          # outside the lock (network)
    async with _lock:
        _load()
        if value is not None:
            _apply(tid, float(value), "auto")
        return _public_one(tid, d)


async def check_all_auto() -> None:
    """Run every auto tracker once (used by the background scheduler)."""
    for tid, d in list(_DEFS.items()):
        if d.get("kind") == "auto" and d.get("fetch"):
            try:
                await refresh(tid)
            except Exception:  # noqa: BLE001 - one tracker failing mustn't stop the rest
                pass
