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
# Imported lazily so trackers.py has no hard dependency on the HTTP stack at import.
async def _holiday_fetch() -> float | None:
    from . import tracker_routines
    return await tracker_routines.holiday_price()


async def _dvla_fetch() -> dict[str, Any] | None:
    from . import tracker_routines
    return await tracker_routines.dvla_licence()


_DEFS: dict[str, dict[str, Any]] = {
    "holiday": {
        "label": "TUI Holiday",
        "unit": "£",
        "kind": "auto",          # auto-polled from Holiday Hypermarket (TUI's own prices)
        "fetch": _holiday_fetch,
        # Verified from the TUI page + URL params (not guessed).
        "note": "Riu Palace Boavista · Boa Vista · 7nts 3 Jan 2027 · 2 adults AI · from BHX",
    },
    "dvla": {
        "label": "Driving Licence",
        "unit": "",
        "kind": "auto",          # status tracker: alerts when the licence status changes
        "fetch": _dvla_fetch,
        "note": "DVLA licence status — watching the medical renewal",
    },
}

_HISTORY_CAP = 60
_lock = asyncio.Lock()
_state: dict[str, dict[str, Any]] = {}
_loaded = False


def _sync_parcels() -> None:
    """Mirror the config `parcels` list into _DEFS as auto status-trackers.

    Parcels are user-managed (added/removed from the remote), so unlike the static
    holiday/dvla trackers they're rebuilt from config each time we list or poll. Each
    becomes tracker id 'parcel:<id>', fetched via WhereParcel (alerts on status change).
    """
    cfg = config.get()
    pa = cfg.get("parcel_api") or {}
    key, secret = pa.get("api_key"), pa.get("secret_key", "")
    wanted: set[str] = set()
    for p in (cfg.get("parcels") or []):
        pid = str(p.get("id") or p.get("tracking") or "").strip()
        tracking = (p.get("tracking") or "").strip()
        if not (pid and tracking):
            continue
        tid = f"parcel:{pid}"
        wanted.add(tid)
        carrier = (p.get("carrier") or "").strip()

        async def _fetch(tracking=tracking, key=key, secret=secret, carrier=carrier):
            from . import tracker_routines
            return await tracker_routines.parcel_status(key, tracking, secret, carrier)

        _DEFS[tid] = {"label": p.get("label") or tracking, "unit": "", "kind": "auto",
                      "fetch": _fetch, "note": f"📦 {tracking}"}
    for tid in [t for t in _DEFS if t.startswith("parcel:") and t not in wanted]:
        _DEFS.pop(tid, None)
        _state.pop(tid, None)


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


def _apply(tid: str, value: float | None, source: str,
           status: str | None = None, detail: str | None = None) -> dict[str, Any]:
    """Record a new reading, updating history + alert. Caller holds the lock.

    Most trackers are numeric (price): a changed value fires an up/down alert. Some are
    status trackers (DVLA licence): they pass a `status` string and a change in that text
    fires a 'change' alert even when the number is steady.
    """
    st = _entry(tid)
    now = time.time()
    alert = None
    if value is not None:
        prev = st.get("value")
        if st.get("baseline") is None:
            st["baseline"] = value
        if prev is not None and value != prev:
            alert = {"active": True, "direction": "up" if value > prev else "down",
                     "delta": round(value - prev, 2), "from": prev, "to": value, "at": now}
        st["value"] = value
        hist = st.setdefault("history", [])
        hist.append([now, value])
        del hist[:-_HISTORY_CAP]
    if status is not None:
        prev_status = st.get("status")
        if prev_status is not None and status != prev_status:
            alert = {"active": True, "direction": "change",
                     "from": prev_status, "to": status, "at": now}
        st["status"] = status
    if detail is not None:
        st["detail"] = detail
    if alert is not None:
        st["alert"] = alert
    st["updated_at"] = now
    st["source"] = source
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
        "status": st.get("status"),        # status trackers (DVLA): human-readable state
        "detail": st.get("detail"),        # extra line (e.g. valid-from/to dates)
        "updated_at": st.get("updated_at"),
        "history": st.get("history", []),
        "alert": st.get("alert"),
    }


async def list_public() -> dict[str, Any]:
    async with _lock:
        _load()
        _sync_parcels()
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
    _sync_parcels()                 # so a just-added parcel id resolves
    d = _DEFS.get(tid)
    if not d:
        raise KeyError(tid)
    if d.get("kind") != "auto" or not d.get("fetch"):
        # manual trackers have nothing to fetch; just return current state
        async with _lock:
            _load()
            return _public_one(tid, d)
    res = await d["fetch"]()            # outside the lock (network)
    async with _lock:
        _load()
        if isinstance(res, dict):       # status tracker -> {value, status, detail}
            v = res.get("value")
            _apply(tid, float(v) if v is not None else None, "auto",
                   status=res.get("status"), detail=res.get("detail"))
        elif res is not None:           # numeric tracker -> a bare float
            _apply(tid, float(res), "auto")
        return _public_one(tid, d)


async def check_all_auto() -> None:
    """Run every auto tracker once (used by the background scheduler)."""
    _sync_parcels()
    for tid, d in list(_DEFS.items()):
        if d.get("kind") == "auto" and d.get("fetch"):
            try:
                await refresh(tid)
            except Exception:  # noqa: BLE001 - one tracker failing mustn't stop the rest
                pass
