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


# --- Parcel (Ship24) parsing --------------------------------------------------------
def _ship24(milestone, event_status="At depot"):
    return {"data": {"trackings": [{
        "shipment": {"statusMilestone": milestone},
        "events": [{"status": event_status, "location": "Birmingham"}],
    }]}}


def test_parcel_in_transit():
    out = tr.parse_parcel(_ship24("in_transit"))
    assert out["status"] == "In transit"
    assert out["value"] == 1.0
    assert out["detail"] == "At depot"


def test_parcel_delivered():
    out = tr.parse_parcel(_ship24("delivered", "Delivered, signed for"))
    assert out["status"] == "Delivered"
    assert out["value"] == 3.0


def test_parcel_no_trackings():
    out = tr.parse_parcel({"data": {"trackings": []}})
    assert out["value"] is None and out["status"] == "No info yet"
