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

import html as _html
import re
from typing import Any

from . import config
from .providers import client  # shared httpx pool only (plumbing, not a data provider)

# A real browser UA — the shared client defaults to a bot-ish UA some of these sites reject.
_BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

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


# --- DVLA driving-licence status -----------------------------------------------------
# GOV.UK "View your driving licence information". No JSON API: it's a Rails wizard behind
# F5 bot-defense with a CSRF token + a honeypot field. A plain server-side replay works:
#   GET  /driving-record/licence-number   -> session cookie + the wizard's CSRF token
#   POST /view_driving_licence/save        -> details + token, honeypot empty, sharing=1
#   -> redirects to /view_licence with the record (status + valid dates in a summary list).
# Used to watch the licence status while a medical renewal is in progress.
_DVLA_BASE = "https://www.viewdrivingrecord.service.gov.uk"


def _strip(s: str) -> str:
    return _html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse_dvla(page_html: str) -> dict[str, Any] | None:
    """Pure: turn the driving-record page into {value, status, detail}.

    value: 1.0 when the licence is currently valid, else 0.0 (drives the change alert /
    sparkline). status: a one-line summary ("<status> · valid to <date>") so a renewal
    (status text or expiry date changing) trips the alert. None if the record wasn't found.
    """
    rows = {
        _strip(k): _strip(v)
        for k, v in re.findall(r'__key">(.*?)</d[td]>.*?__value">(.*?)</dd>',
                               page_html, re.S)
    }
    status = rows.get("Licence status")
    if not status:
        return None
    valid_to = rows.get("Licence valid to", "")
    valid_from = rows.get("Licence valid from", "")
    invalid = re.search(r"revoked|disqualif|expired|cannot|not\s+entitled|surrender",
                        status, re.I)
    value = 0.0 if invalid else 1.0
    summary = status + (f" · valid to {valid_to}" if valid_to else "")
    detail = f"Valid {valid_from} – {valid_to}" if (valid_from and valid_to) else ""
    return {"value": value, "status": summary, "detail": detail}


# --- Parcel tracking (WhereParcel: 1000 free trackings/month, courier auto-detected) ---
#   POST https://api.whereparcel.com/v2/track
#   Authorization: Bearer <api_key>:<secret_key>
#   body: {"trackingItems": [{"trackingNumber": "...", "carrier": "<optional>"}]}
_WHEREPARCEL = "https://api.whereparcel.com/v2/track"
# Normalised milestone -> (label, sparkline value). Keys cover the common status vocab.
_MILESTONE = {
    "pending": ("Pending", 0.0), "info_received": ("Label created", 0.5),
    "infrequent": ("Tracking stalled", 0.5), "in_transit": ("In transit", 1.0),
    "transit": ("In transit", 1.0), "out_for_delivery": ("Out for delivery", 2.0),
    "available_for_pickup": ("Ready for pickup", 2.0), "pickup": ("Ready for pickup", 2.0),
    "failed_attempt": ("Failed attempt", -1.0), "failure": ("Failed attempt", -1.0),
    "exception": ("Exception", -1.0), "delivered": ("Delivered", 3.0),
}


def parse_parcel(js: dict[str, Any]) -> dict[str, Any]:
    """Pure (defensive): turn a parcel-tracking response into {value, status, detail}.

    status = the milestone ("In transit"/"Out for delivery"/"Delivered"), so a change fires
    the tracker's change alert; value codes it for the sparkline; detail = latest scan. Tries
    several field names so it survives minor response-shape differences (calibrated to the
    real WhereParcel response once a key is in place).
    """
    items = (js.get("trackingItems") or js.get("trackings") or js.get("data") or [])
    if isinstance(items, dict):
        items = items.get("trackings", [items])   # empty trackings -> [] (not the wrapper)
    if not items:
        return {"value": None, "status": "No info yet", "detail": ""}
    it = items[0]
    sh = it.get("shipment") or it
    raw = (sh.get("deliveryStatus") or sh.get("statusMilestone") or sh.get("status")
           or it.get("statusText") or "pending")
    key = re.sub(r"[\s-]+", "_", str(raw).strip().lower())
    label, value = _MILESTONE.get(key, (str(raw).replace("_", " ").title() or "Pending", 0.0))
    events = it.get("events") or sh.get("events") or []
    ev = events[0] if events else (it.get("latestEvent") or {})
    detail = (ev.get("description") or ev.get("status") or ev.get("statusText")
              or ev.get("location") or "")
    return {"value": value, "status": label, "detail": str(detail)[:70]}


async def parcel_status(api_key: str, tracking_number: str,
                        secret_key: str = "", carrier: str = "") -> dict[str, Any] | None:
    """Current status of one parcel via WhereParcel (courier auto-detected when omitted)."""
    if not (api_key and tracking_number):
        return None
    item: dict[str, Any] = {"trackingNumber": tracking_number}
    if carrier:
        item["carrier"] = carrier
    token = f"{api_key}:{secret_key}" if secret_key else api_key
    resp = await client().post(
        _WHEREPARCEL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"trackingItems": [item]},
    )
    resp.raise_for_status()
    return parse_parcel(resp.json())


async def dvla_licence() -> dict[str, Any] | None:
    """Fetch the current driving-licence status, or None if unavailable/not configured."""
    d = (config.get().get("dvla_licence") or {})
    if not (d.get("enabled") and d.get("licence_number")
            and d.get("national_insurance") and d.get("postcode")):
        return None
    headers = {"User-Agent": _BROWSER_UA}
    c = client()
    form = await c.get(f"{_DVLA_BASE}/driving-record/licence-number", headers=headers)
    form.raise_for_status()
    # The page has two forms (cookie banner + the wizard); the wizard's token is the 2nd.
    tokens = re.findall(r'name="authenticity_token"[^>]*value="([^"]+)"', form.text)
    if not tokens:
        return None
    token = tokens[1] if len(tokens) > 1 else tokens[0]
    field = "wizard_view_driving_licence_enter_details"
    data = {
        "authenticity_token": token,
        f"{field}[driving_licence_number]": d["licence_number"],
        f"{field}[national_insurance_number]": d["national_insurance"],
        f"{field}[post_code]": str(d["postcode"]).replace(" ", ""),
        f"{field}[passport_honeypot]": "",          # bait field: must stay empty
        f"{field}[data_sharing_confirmation]": "1",
    }
    resp = await c.post(
        f"{_DVLA_BASE}/view_driving_licence/save?locale=en",
        data=data,
        headers={**headers, "Referer": f"{_DVLA_BASE}/driving-record/licence-number"},
    )
    resp.raise_for_status()
    return parse_dvla(resp.text)
