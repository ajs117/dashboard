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


# --- Parcel (WhereParcel) parsing ---------------------------------------------------
# Shapes captured live from api.whereparcel.com/v2/track (success body from the playground
# example; error body from a not-yet-launched carrier). Tracking detail nests under `data`;
# events are newest-first.
def _wp_success(status, desc="Out for delivery", carrier="hk.post"):
    return {"success": True, "results": [{
        "carrier": carrier, "trackingNumber": "EA366042905HK", "success": True,
        "data": {"carrier": carrier, "carrierName": "Hongkong Post", "status": status,
                 "statusText": "delivered", "events": [
                     {"timestamp": "2026-07-01T10:00:00+08:00", "status": status,
                      "location": "Hong Kong", "description": desc}]},
    }]}


def test_parcel_in_transit():
    out = tr.parse_parcel(_wp_success("in_transit", "Departed sorting centre"))
    assert out["status"] == "In transit"
    assert out["value"] == 1.0
    assert out["detail"] == "Departed sorting centre"


def test_parcel_delivered():
    out = tr.parse_parcel(_wp_success("delivered", "Delivered, signed for"))
    assert out["status"] == "Delivered"
    assert out["value"] == 3.0


def test_parcel_status_flat_on_item():
    # Some responses carry status/events directly on the item (not under `data`).
    js = {"results": [{"carrier": "gb.royalmail", "trackingNumber": "AB1GB",
                       "status": "out_for_delivery",
                       "events": [{"description": "Out for delivery", "location": "BHX"}]}]}
    out = tr.parse_parcel(js)
    assert out["status"] == "Out for delivery" and out["value"] == 2.0


def test_parcel_carrier_error_surfaces_message():
    js = {"success": True, "results": [{
        "carrier": "hk.post", "trackingNumber": "EA366042905HK", "status": "error",
        "error": {"code": "INTERNAL_ERROR",
                  "message": "Carrier 'Hongkong Post' is scheduled to launch at 2026-06-30 14:00 (KST)."}}]}
    out = tr.parse_parcel(js)
    assert out["value"] is None and out["status"] == "No info yet"
    assert "scheduled to launch" in out["detail"]


def test_parcel_no_results():
    assert tr.parse_parcel({"success": True, "results": []})["status"] == "No info yet"
