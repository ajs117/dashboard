"""Coded routines for the custom 'watch this thing' trackers.

These are deliberately *not* permanent providers (cf. app/providers/, which are the core
weather/aircraft/radar/trains feeds). A tracker routine is a small, swappable bit of code
that produces one number over time; they come and go as the things being watched change.
Each returns a float (the current value) or None when unavailable.

Currently:
  - holiday_price: TUI package price, read from Holiday Hypermarket's JSON API.
(Next up: dvla_licence — see notes; will need secrets kept in the gitignored config.)
"""
from __future__ import annotations

from typing import Any

from . import config
from .providers import client  # shared httpx pool only (plumbing, not a data provider)

# --- TUI holiday price (via Holiday Hypermarket) -------------------------------------
# tui.co.uk paints the price in with JS behind an Akamai bot-wall, so it needs a real
# browser (the Pi can't run one). Holiday Hypermarket is TUI-owned, sells the identical
# packages at the same prices, and exposes a plain JSON endpoint with no bot-wall:
#   POST https://api.holidayhype.co.uk/api/Results/GetResults
# keyed on a `searchId` captured once from the site (devtools -> Results/GetResults).
# Response holidayResults[] carry pricePp (per-person, matches TUI's headline) + details.
_HH_URL = "https://api.holidayhype.co.uk/api/Results/GetResults"
_HH_HEADERS = {  # the API answers 403 without a matching Origin/Referer
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://www.holidayhypermarket.co.uk",
    "referer": "https://www.holidayhypermarket.co.uk/",
}


def parse_holiday_price(js: dict, accommodation_id: int | None = None,
                        field: str = "pricePp") -> float | None:
    """Pure: pull the tracked package's price out of a GetResults response.

    With accommodation_id we match that hotel exactly (a search can return siblings);
    otherwise take the first result (cheapest, as the call sorts price.asc). Returns the
    per-person price by default (matches TUI's displayed figure), else the party total.
    """
    results = js.get("holidayResults") or []
    chosen = None
    for r in results:
        if accommodation_id is None or r.get("accommodationId") == accommodation_id:
            chosen = r
            break
    if chosen is None and accommodation_id is None and results:
        chosen = results[0]
    if not chosen:
        return None
    val = chosen.get(field)
    if not isinstance(val, (int, float)):
        val = chosen.get("price")  # fall back to party total
    return float(val) if isinstance(val, (int, float)) else None


async def holiday_price() -> float | None:
    """Current per-person price of the watched TUI package, or None if unavailable."""
    h = (config.get().get("holiday_tracker") or {})
    if not (h.get("enabled") and h.get("search_id")):
        return None
    body = {
        "searchId": h["search_id"],
        "sort": "recommended.asc,price.asc",
        "Limit": 10,
        "Offset": 0,
        "clientId": str(h.get("client_id", "1")),
        "accountId": str(h.get("account_id", "")),
        "generateHolidayIds": False,
        "oneSortPriorityScoringMethod": "",
    }
    resp = await client().post(_HH_URL, headers=_HH_HEADERS, json=body)
    resp.raise_for_status()
    return parse_holiday_price(resp.json(), h.get("accommodation_id"),
                               h.get("price_field", "pricePp"))
