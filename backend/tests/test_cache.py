"""TTL cache: freshness, expiry, single-flight, and stale fallback on error."""
from __future__ import annotations

import asyncio

import pytest

from app.cache import TTLCache


async def test_returns_fresh_then_caches():
    c = TTLCache()
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return {"n": calls}

    r1 = await c.get_or_fetch("k", ttl=100, coro=fetch)
    r2 = await c.get_or_fetch("k", ttl=100, coro=fetch)
    assert r1["data"] == {"n": 1}
    assert r2["data"] == {"n": 1}      # served from cache
    assert r1["stale"] is False
    assert calls == 1


async def test_expiry_refetches():
    c = TTLCache()
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return calls

    await c.get_or_fetch("k", ttl=0, coro=fetch)   # ttl 0 -> always stale
    await c.get_or_fetch("k", ttl=0, coro=fetch)
    assert calls == 2


async def test_single_flight_shares_one_fetch():
    c = TTLCache()
    calls = 0

    async def slow():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return "v"

    results = await asyncio.gather(
        *[c.get_or_fetch("k", ttl=100, coro=slow) for _ in range(5)]
    )
    assert all(r["data"] == "v" for r in results)
    assert calls == 1                  # concurrent callers coalesced


async def test_stale_fallback_on_error():
    c = TTLCache()
    state = {"ok": True}

    async def flaky():
        if state["ok"]:
            return "good"
        raise RuntimeError("upstream down")

    first = await c.get_or_fetch("k", ttl=0, coro=flaky)
    assert first["data"] == "good"

    state["ok"] = False
    second = await c.get_or_fetch("k", ttl=0, coro=flaky)
    assert second["data"] == "good"    # last-good value
    assert second["stale"] is True
    assert "upstream down" in second["error"]


async def test_error_with_no_prior_value_raises():
    c = TTLCache()

    async def boom():
        raise RuntimeError("nope")

    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", ttl=0, coro=boom)
