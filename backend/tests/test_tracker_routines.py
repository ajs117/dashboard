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
