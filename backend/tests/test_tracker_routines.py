"""Holiday-price parsing (pure; no network)."""
from __future__ import annotations

from app import tracker_routines as tr


def _resp(*results):
    return {"searchId": 1, "holidayResults": list(results)}


def test_parse_matches_accommodation_and_returns_pp():
    js = _resp(
        {"accommodationId": 11111, "pricePp": 999, "price": 1998.0},
        {"accommodationId": 47977, "pricePp": 1357, "price": 2714.0,
         "accommodationName": "Riu Palace Boavista", "boardBasis": "All Inclusive"},
    )
    assert tr.parse_holiday_price(js, accommodation_id=47977) == 1357.0


def test_parse_first_when_no_id():
    js = _resp({"accommodationId": 5, "pricePp": 800, "price": 1600.0},
               {"accommodationId": 6, "pricePp": 900, "price": 1800.0})
    assert tr.parse_holiday_price(js) == 800.0


def test_parse_party_total_field():
    js = _resp({"accommodationId": 47977, "pricePp": 1357, "price": 2714.0})
    assert tr.parse_holiday_price(js, 47977, field="price") == 2714.0


def test_parse_falls_back_to_total_when_field_missing():
    js = _resp({"accommodationId": 47977, "price": 2714.0})  # no pricePp
    assert tr.parse_holiday_price(js, 47977, field="pricePp") == 2714.0


def test_parse_empty_results():
    assert tr.parse_holiday_price({"holidayResults": []}) is None
    assert tr.parse_holiday_price({}) is None


def test_parse_no_matching_accommodation():
    js = _resp({"accommodationId": 1, "pricePp": 500})
    assert tr.parse_holiday_price(js, accommodation_id=999) is None


# --- DVLA licence parsing -----------------------------------------------------------
def _dvla_page(status, valid_from="18 September 2025", valid_to="17 September 2028"):
    return f"""
      <dl class="govuk-summary-list">
        <dt class="govuk-summary-list__key">Driver&#39;s full name</dt>
          <dd class="govuk-summary-list__value">A Person</dd>
        <dt class="govuk-summary-list__key">Licence status</dt>
          <dd class="govuk-summary-list__value">{status}</dd>
        <dt class="govuk-summary-list__key">Licence valid from</dt>
          <dd class="govuk-summary-list__value">{valid_from}</dd>
        <dt class="govuk-summary-list__key">Licence valid to</dt>
          <dd class="govuk-summary-list__value">{valid_to}</dd>
      </dl>"""


def test_dvla_full_licence_is_valid():
    out = tr.parse_dvla(_dvla_page("You have a full driving licence"))
    assert out["value"] == 1.0
    assert out["status"] == "You have a full driving licence · valid to 17 September 2028"
    assert out["detail"] == "Valid 18 September 2025 – 17 September 2028"


def test_dvla_revoked_is_invalid():
    out = tr.parse_dvla(_dvla_page("Your licence has been revoked"))
    assert out["value"] == 0.0


def test_dvla_no_record():
    assert tr.parse_dvla("<p>check your identity</p>") is None


# --- Parcel (Parcel.app) parsing ----------------------------------------------------
# Shapes captured live from api.parcel.app/external/deliveries/. status_code -> milestone;
# events newest-first; carrier_code mapped to a friendly name.
def _delivery(status_code, carrier="hk", desc="29 Jun, Hongkong Post",
              tn="EA366042905HK", event="Handed over to carrier", loc="HONG KONG"):
    return {"carrier_code": carrier, "description": desc, "status_code": status_code,
            "tracking_number": tn, "events": [{"event": event, "date": "30-06-2026", "location": loc}]}


def test_delivery_in_transit():
    out = tr.parse_delivery(_delivery(2))
    assert out["status"] == "In transit" and out["value"] == 1.0
    assert out["tracking"] == "EA366042905HK"
    assert out["label"] == "29 Jun, Hongkong Post"
    assert out["note"] == "📦 Hongkong Post · EA366042905HK"
    assert out["detail"] == "Handed over to carrier · HONG KONG"


def test_delivery_out_for_delivery_and_delivered():
    assert tr.parse_delivery(_delivery(4))["status"] == "Out for delivery"
    d = tr.parse_delivery(_delivery(0, carrier="amzluk", desc="Tango cans"))
    assert d["status"] == "Delivered" and d["value"] == 3.0
    assert d["note"].startswith("📦 Amazon")


def test_delivery_needs_attention():
    out = tr.parse_delivery(_delivery(7))
    assert out["status"] == "Needs attention" and out["value"] == -1.0


def test_delivery_unknown_carrier_falls_back_and_no_events():
    d = {"carrier_code": "wombat", "description": "", "status_code": 8,
         "tracking_number": "XY1", "events": []}
    out = tr.parse_delivery(d)
    assert out["status"] == "Label created"
    assert out["note"] == "📦 WOMBAT · XY1"      # unknown code -> upper-cased
    assert out["label"] == "XY1"                 # no description -> tracking number
    assert out["detail"] == ""
