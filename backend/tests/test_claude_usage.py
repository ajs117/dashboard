"""Claude Pro usage: normalising the pushed payload, and ageing it out."""
from __future__ import annotations

import json
import time

import pytest

from app import config
from app.providers import claude_usage as cu

# Trimmed real response from Anthropic's OAuth usage endpoint: the two stable windows plus
# a couple of the code-named experimental ones that come and go.
SAMPLE = {
    "five_hour": {"utilization": 35.0, "resets_at": "2026-08-18T18:09:59+00:00"},
    "seven_day": {"utilization": 39.0, "resets_at": "2026-08-24T09:59:59+00:00"},
    "seven_day_opus": None,
    "nimbus_quill": {"utilization": 0.0, "resets_at": None},
    "plan": "pro",
}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "source_path", lambda: tmp_path / "config.yaml")
    return tmp_path / "claude_usage.json"


def test_normalise_keeps_only_the_stable_windows():
    rec = cu.normalise(SAMPLE)
    assert rec["session"] == {"percent": 35, "resets_at": "2026-08-18T18:09:59+00:00"}
    assert rec["weekly"] == {"percent": 39, "resets_at": "2026-08-24T09:59:59+00:00"}
    assert rec["opus"] is None
    assert rec["plan"] == "pro"
    assert "nimbus_quill" not in rec       # experimental fields must not reach the tile


def test_normalise_clamps_and_rounds():
    rec = cu.normalise({"five_hour": {"utilization": 99.6},
                        "seven_day": {"utilization": 140}})
    assert rec["session"]["percent"] == 100      # rounds up, then clamps
    assert rec["weekly"]["percent"] == 100
    assert rec["session"]["resets_at"] is None   # absent, not invented


def test_store_rejects_a_payload_with_no_windows(store):
    with pytest.raises(ValueError):
        cu.store({"seven_day_opus": {"utilization": 5}})
    assert not store.exists()


@pytest.mark.anyio
async def test_store_then_fetch_round_trip(store):
    cu.store(SAMPLE)
    out = await cu.fetch({})
    assert out["enabled"] is True
    assert out["session"]["percent"] == 35
    assert out["weekly"]["percent"] == 39
    assert out["stale"] is False
    assert out["age"] is not None and out["age"] < 5


@pytest.mark.anyio
async def test_fetch_with_nothing_pushed_yet(store):
    out = await cu.fetch({})
    assert out["updated_at"] is None and out["stale"] is True
    assert out["session"] is None


@pytest.mark.anyio
async def test_fetch_marks_an_old_push_stale(store):
    cu.store(SAMPLE)
    rec = json.loads(store.read_text("utf-8"))
    rec["updated_at"] = time.time() - 3600          # an hour old
    store.write_text(json.dumps(rec), encoding="utf-8")

    fresh = await cu.fetch({"claude_usage": {"max_age_minutes": 120}})
    assert fresh["stale"] is False                  # inside a generous window

    old = await cu.fetch({"claude_usage": {"max_age_minutes": 45}})
    assert old["stale"] is True
    assert old["session"]["percent"] == 35          # still returned, just flagged


@pytest.mark.anyio
async def test_fetch_respects_the_disable_switch(store):
    cu.store(SAMPLE)
    out = await cu.fetch({"claude_usage": {"enabled": False}})
    assert out["enabled"] is False and out["session"] is None
