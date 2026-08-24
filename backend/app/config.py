"""Runtime configuration loader.

Resolution order for the config file:
  1. $DASHBOARD_CONFIG  (explicit path; used by the systemd unit on the Pi)
  2. ./config.yaml      (next to the repo root / cwd)
  3. <repo>/config.yaml
  4. <repo>/deploy/config.example.yaml   (fallback so local dev runs without secrets)

Config is mutable at runtime (POST /api/location etc.). We keep an in-memory copy
and write back to whichever file we loaded from (never the example fallback).
"""
from __future__ import annotations

import math
import os
import re
import threading
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_EXAMPLE = _REPO_ROOT / "deploy" / "config.example.yaml"

_lock = threading.RLock()
_data: dict[str, Any] = {}
_path: Path | None = None
_is_fallback = False

_DICT_SECTIONS = {
    "location", "units", "stocks", "trains", "aircraft", "radar", "govee",
    "trackers", "holiday_tracker", "dvla_licence", "ecoflow", "govee_indoor",
    "claude_usage", "parcel_api", "ring", "cache", "refresh", "server",
}
_LIST_SECTIONS = {"world_clocks", "countdowns", "watch_flights"}


def validate(data: Any) -> dict[str, Any]:
    """Reject shapes that would persistently break normal provider `.get()` calls."""
    if not isinstance(data, dict):
        raise ValueError("configuration root must be an object")
    for key in _DICT_SECTIONS:
        if key in data and not isinstance(data[key], dict):
            raise ValueError(f"configuration section {key!r} must be an object")
    for key in _LIST_SECTIONS:
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"configuration section {key!r} must be a list")
    loc = data.get("location") or {}
    for key, low, high in (("lat", -90, 90), ("lon", -180, 180)):
        if key not in loc:
            continue
        value = loc[key]
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not low <= value <= high):
            raise ValueError(f"location.{key} must be a finite number from {low} to {high}")
    timezone = loc.get("timezone")
    if timezone and not (timezone == "UTC" or re.fullmatch(
            r"[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)+", str(timezone))):
        raise ValueError("location.timezone must be UTC or an IANA Area/City name")
    return data


def _candidate_paths() -> list[Path]:
    env = os.environ.get("DASHBOARD_CONFIG")
    paths: list[Path] = []
    if env:
        paths.append(Path(env))
    paths.append(Path.cwd() / "config.yaml")
    paths.append(_REPO_ROOT / "config.yaml")
    paths.append(_EXAMPLE)
    return paths


def load() -> dict[str, Any]:
    """Load (or reload) config from the first existing candidate path."""
    global _data, _path, _is_fallback
    with _lock:
        for p in _candidate_paths():
            if p.is_file():
                with p.open("r", encoding="utf-8") as fh:
                    _data = validate(yaml.safe_load(fh) or {})
                _path = p
                _is_fallback = p == _EXAMPLE
                return _data
        raise FileNotFoundError(
            "No config.yaml found. Copy deploy/config.example.yaml to config.yaml."
        )


def get() -> dict[str, Any]:
    with _lock:
        if not _data:
            load()
        return _data


def source_path() -> Path | None:
    return _path


def is_fallback() -> bool:
    """True when we loaded the committed example (i.e. no real config present)."""
    return _is_fallback


def save() -> None:
    """Persist the in-memory config back to disk.

    Refuses to overwrite the committed example fallback — writes to <repo>/config.yaml
    instead, so a dev edit creates a real (gitignored) config rather than mutating the
    template.
    """
    global _path, _is_fallback
    with _lock:
        target = _path
        if target is None or _is_fallback:
            target = _REPO_ROOT / "config.yaml"
        tmp = target.with_suffix(target.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            # The config contains API credentials and the admin token. os.replace keeps
            # the temp file's mode, not the target's, so set it before writing any secret
            # content; otherwise the first settings save can silently turn 0600 into 0644.
            os.chmod(tmp, 0o600)
            yaml.safe_dump(_data, fh, sort_keys=False, allow_unicode=True)
        os.replace(tmp, target)  # atomic
        _path = target
        _is_fallback = False


def public() -> dict[str, Any]:
    """Config safe to expose to the browser — secrets stripped out."""
    d = get()
    trains = dict(d.get("trains", {}))
    trains.pop("token", None)
    return {
        "location": d.get("location", {}),
        "units": d.get("units", {}),
        "world_clocks": d.get("world_clocks", []),
        "countdowns": d.get("countdowns", []),
        "trains": {k: v for k, v in trains.items() if k != "token"},
        "aircraft": d.get("aircraft", {}),
        "refresh": d.get("refresh", {}),
        "ring": {"interval_seconds": (d.get("ring") or {}).get("interval_seconds", 30)},
        "watch_flights": d.get("watch_flights", []),
    }
