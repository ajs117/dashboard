"""Upstream data providers and shared HTTP plumbing."""
from __future__ import annotations

import asyncio
import time

import httpx

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    """Lazily-created shared async HTTP client (connection pooling, sane timeouts)."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=8.0),
            headers={"User-Agent": "pi-desk-dashboard/1.0 (+https://github.com)"},
            follow_redirects=True,
        )
    return _client


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class RateLimiter:
    """Minimum interval between calls (e.g. airplanes.live = 1 req/sec)."""

    def __init__(self, min_interval: float) -> None:
        self._min = min_interval
        self._last = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            delta = now - self._last
            if delta < self._min:
                await asyncio.sleep(self._min - delta)
            self._last = time.monotonic()
