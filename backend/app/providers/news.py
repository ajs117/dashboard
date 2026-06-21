"""Headlines via BBC News RSS — a mix of UK and World (no key).

  https://feeds.bbci.co.uk/news/uk/rss.xml
  https://feeds.bbci.co.uk/news/world/rss.xml

RSS is XML, parsed with the stdlib. The two feeds are interleaved (UK, World, UK, …)
and de-duplicated, so the panel shows a blend of domestic and international news.
"""
from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from typing import Any

from . import client

_FEEDS = [
    ("UK", "https://feeds.bbci.co.uk/news/uk/rss.xml"),
    ("World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
]
_UA = ("Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/126.0.0.0 Safari/537.36")
_PER_FEED = 10
_MAX = 16


def parse(xml_text: str, scope: str = "") -> list[dict[str, str]]:
    """Pure: pull (title, link, scope) from RSS <item> elements. Unit-testable."""
    items: list[dict[str, str]] = []
    root = ET.fromstring(xml_text)
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        if not title:
            continue
        items.append({
            "title": title,
            "link": (it.findtext("link") or "").strip(),
            "scope": scope,
        })
        if len(items) >= _PER_FEED:
            break
    return items


def interleave(lists: list[list[dict[str, str]]]) -> list[dict[str, str]]:
    """Pure: round-robin merge, dropping duplicate titles. Unit-testable."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for i in range(max((len(x) for x in lists), default=0)):
        for lst in lists:
            if i < len(lst):
                it = lst[i]
                key = it["title"].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(it)
                    if len(out) >= _MAX:
                        return out
    return out


async def _one(scope: str, url: str) -> list[dict[str, str]]:
    try:
        resp = await client().get(url, headers={"User-Agent": _UA})
        resp.raise_for_status()
        return parse(resp.text, scope)
    except Exception:  # noqa: BLE001 - one feed failing shouldn't blank the panel
        return []


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    feeds = cfg.get("news", {}).get("feeds") or _FEEDS
    results = await asyncio.gather(*[_one(scope, url) for scope, url in feeds])
    return {"headlines": interleave(list(results)), "source": "BBC News"}
