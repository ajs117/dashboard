"""The one train the dashboard is currently following.

Pushed from the remote (or by tapping a row on the board) and polled by the kiosk. Kept on
the writable partition rather than in memory like remote.py: a watch outlives a backend
restart by design — the point is to leave it up for a whole journey.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from . import config

_watch: dict[str, Any] | None = None
_loaded = False


def _path() -> Path:
    src = config.source_path()
    base = src.parent if src else Path.cwd()
    return base / "train_watch.json"


def _load() -> None:
    global _watch, _loaded
    if _loaded:
        return
    p = _path()
    try:
        _watch = json.loads(p.read_text("utf-8")) if p.is_file() else None
    except Exception:  # noqa: BLE001 - corrupt file shouldn't break the board
        _watch = None
    _loaded = True


def _save() -> None:
    p = _path()
    if _watch is None:
        p.unlink(missing_ok=True)
        return
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_watch), "utf-8")
    os.replace(tmp, p)


def get() -> dict[str, Any] | None:
    _load()
    return dict(_watch) if _watch else None


def set_watch(service_id: str, label: str | None = None, std: str | None = None,
              platform: str | None = None, to_crs: str | None = None) -> dict[str, Any]:
    """`std`/`platform` come from the departure board the train was pushed from: Darwin's
    service details leave the board station's own time and platform null, so the board is
    the only place they are known. `to_crs` is where the passenger actually gets off, which
    is rarely where the train terminates."""
    global _watch
    _load()
    _watch = {"service_id": service_id, "label": label, "std": std, "platform": platform,
              "to_crs": (to_crs or "").strip().upper() or None, "at": time.time()}
    _save()
    return dict(_watch)


def clear() -> None:
    global _watch
    _load()
    _watch = None
    _save()
