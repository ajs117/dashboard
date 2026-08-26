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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class _Entry:
    value: Any
    fetched_at: float
    error: str | None = None
    # Hard deadline overriding the caller's TTL; set by expire_after for a payload that
    # reports a failure the cache cannot see as an exception.
    expires_at: float | None = None


@dataclass
class _KeyLock:
    lock: asyncio.Lock
    users: int = 0


# Bound the store so per-callsign route / per-hex photo keys can't grow without limit
# over weeks of uptime on a 512MB Pi. The handful of fixed keys (weather/radar/...) plus
# recently-seen flights fit comfortably; the oldest entries are evicted past this.
_MAX_ENTRIES = 200


class TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, _Entry] = {}
        self._locks: dict[str, _KeyLock] = {}
        self._generation = 0

    def clear(self) -> None:
        """Invalidate every cached value after a runtime configuration change.

        Incrementing the generation also prevents a fetch that started before the
        change from putting data produced with the old config back into the cache.
        Keep only locks that are currently in use; removing those could break the
        per-key single-flight guarantee for existing waiters.
        """
        self._generation += 1
        self._store.clear()
        self._locks = {key: state for key, state in self._locks.items() if state.users}

    def _evict_if_needed(self) -> None:
        if len(self._store) <= _MAX_ENTRIES:
            return
        # Drop oldest-fetched entries (and their now-orphaned locks).
        overflow = len(self._store) - _MAX_ENTRIES
        for k in sorted(self._store, key=lambda k: self._store[k].fetched_at)[:overflow]:
            self._store.pop(k, None)
            state = self._locks.get(k)
            if state is not None and state.users == 0:
                self._locks.pop(k, None)

    def _lock_for(self, key: str) -> _KeyLock:
        state = self._locks.get(key)
        if state is None:
            state = _KeyLock(asyncio.Lock())
            self._locks[key] = state
        state.users += 1
        return state

    async def get_or_fetch(
        self,
        key: str,
        ttl: float,
        coro: Callable[[], Awaitable[Any]],
    ) -> dict[str, Any]:
        now = time.time()
        entry = self._store.get(key)
        if entry is not None and self._is_fresh(entry, ttl, now):
            return self._wrap(entry, fresh=True)

        state = self._lock_for(key)
        try:
            async with state.lock:
                # Re-check: another waiter may have refreshed while we waited.
                entry = self._store.get(key)
                now = time.time()
                if entry is not None and self._is_fresh(entry, ttl, now):
                    return self._wrap(entry, fresh=True)
                generation = self._generation
                try:
                    value = await coro()
                    entry = _Entry(value=value, fetched_at=time.time())
                    if generation == self._generation:
                        self._store[key] = entry
                        self._evict_if_needed()
                    return self._wrap(entry, fresh=True)
                except Exception as exc:
                    if entry is not None:
                        entry.error = str(exc)
                        return self._wrap(entry, fresh=False)
                    raise
        finally:
            state.users -= 1
            if state.users == 0 and self._locks.get(key) is state:
                self._locks.pop(key, None)

    def expire_after(self, key: str, ttl: float) -> None:
        """Leave a cached entry no more than `ttl` seconds of life from now.

        For a value that is technically a successful fetch but carries a failure, so the
        caller's own (long) TTL shouldn't pin it. Never extends an entry's life.
        """
        entry = self._store.get(key)
        if entry is None:
            return
        deadline = time.time() + max(0.0, ttl)
        if entry.expires_at is None or deadline < entry.expires_at:
            entry.expires_at = deadline

    @staticmethod
    def _is_fresh(entry: _Entry, ttl: float, now: float) -> bool:
        if entry.expires_at is not None and now >= entry.expires_at:
            return False
        return (now - entry.fetched_at) < ttl

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
