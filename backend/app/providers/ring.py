"""Ring camera snapshots (unofficial community API via `ring-doorbell`).

Ring has no public API. This uses the community library that Home Assistant relies on.
Auth is capture-once: you log in interactively ONCE (username + password + 2FA OTP) via
`deploy/scripts/ring_auth.py`, which writes a long-lived refresh token. After that the Pi
refreshes tokens machine-to-machine with no further 2FA.

Ring ROTATES the refresh token on use, so `token_updater` persists each new one to a
sidecar JSON file on the writable data partition (never the repo, never config.yaml).
Losing that write means auth breaks the next time the token rotates.

Snapshots only — no live video. The kiosk's WPE build has no WebRTC media stack
(no webrtcbin/libnice/DTLS-SRTP), and H.264 decode on a Zero 2W would be marginal anyway.

Disabled cameras: `async_get_snapshot()` does NOT check device state — it retries and
returns None, costing ~3s per dead camera. So we filter on `motion_detection` /
`connection_status` BEFORE requesting, which is what keeps the cycling home tile moving.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

_UA = "PiDeskDashboard/1.0"

# One shared Ring session; creating it costs an auth round-trip, so we keep it alive.
_ring: Any = None
_auth: Any = None
_lock = asyncio.Lock()
_devices_at: float = 0.0
_DEVICE_TTL = 300.0          # re-list devices every 5 min (picks up schedule changes)


def _token_path(cfg: dict[str, Any]) -> Path:
    r = cfg.get("ring") or {}
    p = r.get("token_file")
    if p:
        return Path(p)
    # Default next to the active config (i.e. /data on the Pi), not in the repo.
    from .. import config as _config
    src = _config.source_path()
    return (src.parent if src else Path.cwd()) / "ring_token.json"


def _load_token(cfg: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return json.loads(_token_path(cfg).read_text("utf-8"))
    except Exception:  # noqa: BLE001 - missing/corrupt token just means "not set up"
        return None


def save_token(cfg: dict[str, Any], token: dict[str, Any]) -> None:
    """Persist a (possibly rotated) refresh token, 0600, atomically."""
    p = _token_path(cfg)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(token), encoding="utf-8")
        os.chmod(tmp, 0o600)          # token is a credential - keep it owner-only
        os.replace(tmp, p)            # atomic; a crash can't leave a half-written token
    except Exception:  # noqa: BLE001 - never let a token write break a snapshot request
        pass


def _enabled(cfg: dict[str, Any]) -> bool:
    r = cfg.get("ring") or {}
    return bool(r.get("enabled")) and _token_path(cfg).is_file()


async def _session(cfg: dict[str, Any]):
    """Lazily create (and reuse) the authenticated Ring session."""
    global _ring, _auth, _devices_at
    if _ring is not None:
        return _ring
    from ring_doorbell import Auth, Ring

    token = _load_token(cfg)
    if not token:
        raise RuntimeError("no Ring token; run deploy/scripts/ring_auth.py")
    _auth = Auth(_UA, token, lambda t: save_token(cfg, t))
    _ring = Ring(_auth)
    await _ring.async_create_session()
    await _ring.async_update_devices()
    _devices_at = time.time()
    return _ring


def _cameras(ring: Any) -> list[Any]:
    """All camera-like devices (doorbells + stick-up cams), in a stable order."""
    d = ring.devices()
    cams = list(getattr(d, "doorbots", []) or []) + \
        list(getattr(d, "stickup_cams", []) or []) + \
        list(getattr(d, "authorized_doorbots", []) or [])
    # Stable order so the home tile's cycle doesn't jump around between refreshes.
    return sorted(cams, key=lambda c: str(getattr(c, "id", "")))


def is_active(cam: Any) -> bool:
    """True when a camera is online and not switched off by a schedule.

    Ring exposes no explicit 'disabled' flag; a camera turned off (mode schedule, or
    motion detection off) reports motion_detection False, and an offline one reports a
    non-'online' connection_status. Requesting a snapshot from either just burns ~3s of
    retries and returns None, so skip them.
    """
    status = getattr(cam, "connection_status", None)
    if status is not None and str(status).lower() not in ("online", "connected"):
        return False
    motion = getattr(cam, "motion_detection", None)
    if motion is False:
        return False
    return True


def describe(cam: Any) -> dict[str, Any]:
    """Pure: the JSON-safe summary the frontend needs for one camera."""
    battery = getattr(cam, "battery_life", None)
    try:
        battery = int(battery) if battery is not None else None
    except (TypeError, ValueError):
        battery = None
    return {
        "id": str(getattr(cam, "id", "")),
        "name": str(getattr(cam, "name", "") or "Camera"),
        "kind": str(getattr(cam, "kind", "") or ""),
        "family": str(getattr(cam, "family", "") or ""),
        "battery": battery,
        "active": is_active(cam),
    }


async def list_cameras(cfg: dict[str, Any]) -> dict[str, Any]:
    """Camera list for the UI. Disabled/offline ones are included but flagged inactive."""
    if not _enabled(cfg):
        return {"enabled": False, "cameras": []}
    global _devices_at
    async with _lock:
        try:
            ring = await _session(cfg)
            # Refresh device state periodically so a camera coming off its schedule shows up.
            if time.time() - _devices_at > _DEVICE_TTL:
                await ring.async_update_devices()
                _devices_at = time.time()
            cams = [describe(c) for c in _cameras(ring)]
            return {"enabled": True, "cameras": cams}
        except Exception as exc:  # noqa: BLE001 - surface as a message, don't 500 the UI
            await _reset()
            return {"enabled": True, "cameras": [], "error": str(exc)[:160]}


async def _fetch_snapshot(ring: Any, cam: Any, max_age: float) -> bytes | None:
    """Fetch a camera's snapshot, tolerating Ring not producing a fresh one.

    The library's own async_get_snapshot() asks Ring for a NEW capture and only returns an
    image if the stored timestamp advances past the moment we asked. On mains-powered
    models (e.g. the 2024 battery doorbell, kind=doorbell_tahoe) that timestamp often never
    moves - Ring refreshes on its own cadence - so it retries and returns None forever,
    even though a perfectly good recent JPEG is sitting there.

    So: nudge Ring to refresh, give it a short window, then serve the newest image we have
    as long as it isn't stale. A few-seconds-old frame beats a blank tile.
    """
    from ring_doorbell.const import SNAPSHOT_ENDPOINT, SNAPSHOT_TIMESTAMP_ENDPOINT

    dev_id = cam._attrs.get("id")  # noqa: SLF001 - the library exposes no public accessor
    payload = {"doorbot_ids": [dev_id]}
    asked_at = time.time()

    def _ts(resp: Any) -> float:
        try:
            stamps = (resp.json() or {}).get("timestamps") or []
            return float(stamps[0]["timestamp"]) / 1000.0 if stamps else 0.0
        except Exception:  # noqa: BLE001
            return 0.0

    # Ask for a fresh capture, then poll briefly for it to land.
    latest = _ts(await ring.async_query(SNAPSHOT_TIMESTAMP_ENDPOINT, method="POST",
                                        json=payload))
    for _ in range(2):
        if latest > asked_at:
            break
        await asyncio.sleep(1.0)
        latest = _ts(await ring.async_query(SNAPSHOT_TIMESTAMP_ENDPOINT, method="POST",
                                            json=payload))

    # Serve whatever Ring has, provided it's recent enough to be meaningful.
    if latest and (time.time() - latest) > max_age:
        return None
    resp = await ring.async_query(SNAPSHOT_ENDPOINT.format(dev_id))
    content = getattr(resp, "content", None)
    if not content:
        return None
    # Pair the bytes with Ring's own capture time so the UI can show how old the frame
    # really is (not merely when we asked for it).
    return (content, latest or time.time())


async def snapshot(cfg: dict[str, Any], cam_id: str) -> tuple[bytes, float] | None:
    """(JPEG bytes, capture unix time), or None if disabled/offline/failed."""
    if not _enabled(cfg):
        return None
    r = cfg.get("ring") or {}
    # Don't serve a frame older than a few refresh intervals - that's a dead camera, and a
    # stale picture on a "live-ish" tile is worse than an honest blank.
    max_age = float(r.get("max_snapshot_age_seconds",
                          max(120.0, float(r.get("interval_seconds", 30)) * 4)))
    async with _lock:
        try:
            ring = await _session(cfg)
            for cam in _cameras(ring):
                if str(getattr(cam, "id", "")) != str(cam_id):
                    continue
                if not is_active(cam):
                    return None          # don't pay the retry cost on a disabled camera
                return await _fetch_snapshot(ring, cam, max_age)
            return None
        except Exception:  # noqa: BLE001 - a bad snapshot must not break the page
            await _reset()
            return None


async def _reset() -> None:
    """Close and drop the cached session so the next call re-authenticates."""
    global _ring, _auth
    auth = _auth
    _ring = None
    _auth = None
    if auth is not None:
        try:
            await auth.async_close()
        except Exception:  # noqa: BLE001 - cleanup must not hide the original failure
            pass


async def aclose() -> None:
    async with _lock:
        await _reset()
