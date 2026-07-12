"""'Did you know' facts from Wikipedia (keyless), refreshed daily.

  GET https://api.wikimedia.org/feed/v1/wikipedia/en/featured/YYYY/MM/DD
  -> {"dyk": [{"text": "... that <b>X</b>?", ...}, ...], "tfa":..., "news":...}

The `dyk` block is Wikipedia's editor-curated "Did you know ..." hooks — genuine trivia,
a fresh set every day, so it never churns through a finite pool the way the old random-
trivia API did (stale, repetitive). Wikimedia's UA policy requires a descriptive
User-Agent with a contact URL, else it 403s ("respect our robot policy").
"""
from __future__ import annotations

import datetime
import re
from typing import Any

from . import client

_URL = ("https://api.wikimedia.org/feed/v1/wikipedia/en/featured"
        "/{yyyy:04d}/{mm:02d}/{dd:02d}")
_UA = "PiDeskDashboard/1.0 (+https://github.com/ajs117/dashboard)"
_MAX = 8   # a modest daily set — enough variety without burning through facts

_TAG_RE = re.compile(r"<[^>]+>")          # DYK hooks embed <a>/<b> Wikipedia links


def _clean(text: str) -> str:
    """Strip the HTML links and the leading '... ' so it reads after 'Did you know'."""
    text = _TAG_RE.sub("", text).strip()
    text = re.sub(r"^\.{2,}\s*|^…\s*", "", text)   # drop the leading "..." / "…" placeholder
    return text.strip()


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    today = datetime.date.today()
    url = _URL.format(yyyy=today.year, mm=today.month, dd=today.day)
    try:
        resp = await client().get(url, headers={"User-Agent": _UA})
        resp.raise_for_status()
        hooks = (resp.json() or {}).get("dyk") or []
    except Exception:  # noqa: BLE001 - facts are non-essential; empty just means news-only
        return {"facts": []}
    facts: list[str] = []
    for e in hooks:
        text = e.get("text")
        if isinstance(text, str) and text.strip():
            cleaned = _clean(text)
            if cleaned:
                facts.append(cleaned)
    return {"facts": facts[:_MAX]}
