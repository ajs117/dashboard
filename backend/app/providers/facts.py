"""Random trivia facts via the Useless Facts API (no key).

  GET https://uselessfacts.jsph.pl/api/v2/facts/random?language=en  -> {"text": "..."}

The endpoint returns one random fact per call, so we fetch a handful concurrently and
de-duplicate. Cached hard upstream (these don't need to be fresh).
"""
from __future__ import annotations

import asyncio
from typing import Any

from . import client

_URL = "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en"
_COUNT = 15


async def _one() -> str | None:
    try:
        resp = await client().get(_URL)
        resp.raise_for_status()
        text = (resp.json() or {}).get("text")
        return text.strip() if isinstance(text, str) and text.strip() else None
    except Exception:  # noqa: BLE001
        return None


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    count = int(cfg.get("facts", {}).get("count", _COUNT))
    results = await asyncio.gather(*[_one() for _ in range(count)])
    seen: list[str] = []
    for t in results:
        if t and t not in seen:
            seen.append(t)
    return {"facts": seen}
