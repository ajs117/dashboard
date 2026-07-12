"""'On this day' facts from Wikipedia (keyless), refreshed daily.

  GET https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/MM/DD
  -> {"selected": [{"text": "...", "year": 1998, "pages": [...]}, ...]}

Replaces the old random-trivia API, whose facts were stale and repetitive. These are
curated notable events for today's date, so it's a fresh, high-quality set each day that
never churns through a finite pool. Wikimedia's UA policy requires a descriptive
User-Agent with a contact URL, else it 403s ("respect our robot policy").
"""
from __future__ import annotations

import datetime
from typing import Any

from . import client

_URL = ("https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected"
        "/{mm:02d}/{dd:02d}")
_UA = "PiDeskDashboard/1.0 (+https://github.com/ajs117/dashboard)"
_MAX = 8   # a modest daily set — enough variety without burning through facts


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    today = datetime.date.today()
    url = _URL.format(mm=today.month, dd=today.day)
    try:
        resp = await client().get(url, headers={"User-Agent": _UA})
        resp.raise_for_status()
        events = (resp.json() or {}).get("selected") or []
    except Exception:  # noqa: BLE001 - facts are non-essential; empty just means news-only
        return {"facts": []}
    facts: list[str] = []
    for e in events:
        text = e.get("text")
        year = e.get("year")
        if isinstance(text, str) and text.strip():
            # "(pictured)" refers to a Wikipedia thumbnail we don't show — drop it.
            text = text.replace(" (pictured)", "").strip()
            facts.append(f"{year} — {text}" if year else text)
    return {"facts": facts[:_MAX]}
