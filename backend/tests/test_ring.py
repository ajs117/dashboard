"""Tests for the pure Ring helpers: active-camera filtering and the UI summary.

The filtering matters because `async_get_snapshot()` doesn't check device state — it
retries and returns None, so a camera that's off on a schedule costs ~3s per poll and
would stall the cycling home tile. These cases pin that behaviour down.
"""
from __future__ import annotations

from app.providers import ring


class FakeCam:
    """Stand-in for a ring_doorbell device (the real one needs a live session)."""

    def __init__(self, **kw):
        self.id = kw.get("id", 1)
        self.name = kw.get("name", "Front Door")
        self.kind = kw.get("kind", "doorbell_v3")
        self.family = kw.get("family", "doorbots")
        self.battery_life = kw.get("battery_life")
        self.connection_status = kw.get("connection_status", "online")
        self.motion_detection = kw.get("motion_detection", True)


def test_active_camera_is_active():
    assert ring.is_active(FakeCam()) is True


def test_camera_off_on_schedule_is_skipped():
    # Motion detection off = disabled by a mode/schedule -> don't request a snapshot.
    assert ring.is_active(FakeCam(motion_detection=False)) is False


def test_offline_camera_is_skipped():
    assert ring.is_active(FakeCam(connection_status="offline")) is False


def test_unknown_connection_status_is_skipped():
    assert ring.is_active(FakeCam(connection_status="unknown")) is False


def test_missing_attributes_default_to_active():
    """A device that doesn't report these fields shouldn't be filtered out."""
    cam = FakeCam()
    del cam.connection_status
    del cam.motion_detection
    assert ring.is_active(cam) is True


def test_describe_shapes_payload():
    out = ring.describe(FakeCam(id=42, name="Drive", battery_life=87))
    assert out["id"] == "42"
    assert out["name"] == "Drive"
    assert out["battery"] == 87
    assert out["active"] is True


def test_describe_handles_bad_battery():
    # Ring sometimes reports battery as a non-numeric string for wired cams.
    assert ring.describe(FakeCam(battery_life="unknown"))["battery"] is None
    assert ring.describe(FakeCam(battery_life=None))["battery"] is None


def test_describe_marks_disabled_camera_inactive():
    out = ring.describe(FakeCam(name="Garden", motion_detection=False))
    assert out["active"] is False
    assert out["name"] == "Garden"


def test_describe_is_json_safe():
    """Everything the frontend receives must survive json.dumps."""
    import json
    json.dumps(ring.describe(FakeCam()))


# --- loopback gate -------------------------------------------------------------------
# Camera imagery must be reachable from the kiosk (which loads from localhost, so uvicorn
# reports 127.0.0.1) but not from other hosts on the LAN.

def _req(host: str | None):
    from types import SimpleNamespace
    return SimpleNamespace(client=SimpleNamespace(host=host) if host else None)


def test_kiosk_origin_is_allowed():
    from app.routers.api import _require_local
    _require_local(_req("127.0.0.1"))    # must not raise


def test_lan_client_is_blocked():
    import pytest
    from fastapi import HTTPException
    from app.routers.api import _require_local
    for host in ("192.168.8.50", "192.168.10.124", "10.0.0.5"):
        with pytest.raises(HTTPException) as ex:
            _require_local(_req(host))
        assert ex.value.status_code == 403


def test_missing_client_is_blocked():
    import pytest
    from fastapi import HTTPException
    from app.routers.api import _require_local
    with pytest.raises(HTTPException):
        _require_local(_req(None))
