"""Tiny async TTL cache with last-good fallback and per-key single-flight.

Usage:
    data = await cache.get_or_fetch("weather", ttl=600, coro=fetch_weather)

- Within `ttl` seconds, the cached value is returned without calling the fetcher.
- Concurrent callers for the same key share one in-flight fetch (single-flight).
- If the fetcher raises but we have a previous value, that stale value is returned
  with `stale=True` so the UI can flag it instead of breaking.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable


@dataclass
class _Entry:
    value: Any
    fetched_at: float
    error: str | None = None


# Bound the store so per-callsign route / per-hex photo keys can't grow without limit
# over weeks of uptime on a 512MB Pi. The handful of fixed keys (weather/radar/...) plus
# recently-seen flights fit comfortably; the oldest entries are evicted past this.
_MAX_ENTRIES = 200


class TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _evict_if_needed(self) -> None:
        if len(self._store) <= _MAX_ENTRIES:
            return
        # Drop oldest-fetched entries (and their now-orphaned locks).
        overflow = len(self._store) - _MAX_ENTRIES
        for k in sorted(self._store, key=lambda k: self._store[k].fetched_at)[:overflow]:
            self._store.pop(k, None)
            self._locks.pop(k, None)

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def get_or_fetch(
        self,
        key: str,
        ttl: float,
        coro: Callable[[], Awaitable[Any]],
    ) -> dict[str, Any]:
        now = time.time()
        entry = self._store.get(key)
        if entry is not None and (now - entry.fetched_at) < ttl:
            return self._wrap(entry, fresh=True)

        async with self._lock_for(key):
            # Re-check: another waiter may have refreshed while we waited.
            entry = self._store.get(key)
            now = time.time()
            if entry is not None and (now - entry.fetched_at) < ttl:
                return self._wrap(entry, fresh=True)
            try:
                value = await coro()
                entry = _Entry(value=value, fetched_at=time.time())
                self._store[key] = entry
                self._evict_if_needed()
                return self._wrap(entry, fresh=True)
            except Exception as exc:  # noqa: BLE001 - surface as stale, don't crash UI
                if entry is not None:
                    entry.error = str(exc)
                    return self._wrap(entry, fresh=False)
                raise

    @staticmethod
    def _wrap(entry: _Entry, fresh: bool) -> dict[str, Any]:
        return {
            "data": entry.value,
            "stale": not fresh,
            "fetched_at": entry.fetched_at,
            "age": round(time.time() - entry.fetched_at, 1),
            "error": entry.error if not fresh else None,
        }


cache = TTLCache()
