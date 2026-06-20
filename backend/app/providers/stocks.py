"""Index / commodity quotes via the Yahoo Finance chart endpoint (no key).

  GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1d

Default symbols cover FTSE 100, S&P 500, NASDAQ, gold and crude oil. Each symbol is
fetched independently; a failure on one is reported per-row, not as a whole-module error.
"""
from __future__ import annotations

import asyncio
from typing import Any

from . import client

_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

DEFAULT_SYMBOLS = [
    {"symbol": "^FTSE", "label": "FTSE 100"},
    {"symbol": "^GSPC", "label": "S&P 500"},
    {"symbol": "^IXIC", "label": "NASDAQ"},
    {"symbol": "GC=F", "label": "Gold"},
    {"symbol": "CL=F", "label": "Oil (WTI)"},
]


async def _one(symbol: str, label: str) -> dict[str, Any]:
    try:
        resp = await client().get(
            _URL.format(symbol=symbol),
            params={"range": "1d", "interval": "1d"},
        )
        resp.raise_for_status()
        meta = (resp.json()["chart"]["result"][0]["meta"])
        price = meta.get("regularMarketPrice")
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        change = pct = None
        if price is not None and prev:
            change = round(price - prev, 2)
            pct = round((price - prev) / prev * 100, 2)
        return {
            "symbol": symbol,
            "label": label,
            "price": round(price, 2) if price is not None else None,
            "change": change,
            "pct": pct,
            "currency": meta.get("currency"),
            "ok": price is not None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"symbol": symbol, "label": label, "ok": False, "error": str(exc)}


async def fetch(cfg: dict[str, Any]) -> dict[str, Any]:
    symbols = cfg.get("stocks", {}).get("symbols") or DEFAULT_SYMBOLS
    rows = await asyncio.gather(*[_one(s["symbol"], s["label"]) for s in symbols])
    return {"quotes": list(rows)}
