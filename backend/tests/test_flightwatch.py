"""Tests for the flight-watch maths: progress along a route and ETA."""
from __future__ import annotations

from app.providers import flightwatch

# Real coordinates for the CX255 route that prompted this feature.
HKG = {"lat": 22.308901, "lon": 113.915001, "iata": "HKG"}
LHR = {"lat": 51.4706, "lon": -0.461941, "iata": "LHR"}


def test_normalise_callsign():
    assert flightwatch.normalise("  cx 255 ") == "CX255"
    assert flightwatch.normalise("") == ""
    assert flightwatch.normalise(None) == ""


def test_progress_at_origin_is_zero():
    p = flightwatch.progress(HKG["lat"], HKG["lon"], HKG, LHR)
    assert p["percent"] == 0
    assert p["flown_nm"] == 0
    assert p["remaining_nm"] > 4000        # HKG->LHR is roughly 5200nm great circle


def test_progress_at_destination_is_complete():
    p = flightwatch.progress(LHR["lat"], LHR["lon"], HKG, LHR)
    assert p["percent"] == 100
    assert p["remaining_nm"] == 0


def test_progress_midway_is_about_half():
    # A point roughly midway along the HKG->LHR great circle (over central Asia).
    p = flightwatch.progress(55.0, 60.0, HKG, LHR)
    assert 30 <= p["percent"] <= 70        # generous: great-circle vs actual track
    assert p["flown_nm"] > 0 and p["remaining_nm"] > 0


def test_progress_never_exceeds_100_on_a_diversion():
    """Measuring against flown+remaining (not origin->dest) keeps a dog-leg sane."""
    p = flightwatch.progress(70.0, -40.0, HKG, LHR)   # way off route, over Greenland
    assert p["percent"] is not None
    assert 0 <= p["percent"] <= 100


def test_progress_without_route_still_gives_what_it_can():
    p = flightwatch.progress(51.0, -1.0, None, LHR)
    assert p["remaining_nm"] is not None
    assert p["flown_nm"] is None
    assert p["percent"] is None


def test_progress_with_no_airports_is_all_none():
    p = flightwatch.progress(51.0, -1.0, None, None)
    assert p == {"percent": None, "remaining_nm": None, "flown_nm": None}


def test_progress_ignores_airports_missing_coordinates():
    p = flightwatch.progress(51.0, -1.0, {"iata": "HKG"}, {"iata": "LHR"})
    assert p["percent"] is None and p["remaining_nm"] is None


def test_eta_basic():
    # 500nm to run at 500kt = 1 hour.
    assert flightwatch.eta_minutes(500, 500) == 60


def test_eta_rejects_taxi_and_manoeuvring_speeds():
    """Below 80kt the aircraft isn't cruising; an ETA from that would be nonsense."""
    assert flightwatch.eta_minutes(500, 20) is None
    assert flightwatch.eta_minutes(500, 0) is None


def test_eta_handles_missing_inputs():
    assert flightwatch.eta_minutes(None, 500) is None
    assert flightwatch.eta_minutes(500, None) is None
    assert flightwatch.eta_minutes(0, 500) is None


def test_shape_computes_bearing_and_distance_from_home():
    ac = {"hex": "abc", "lat": 52.5, "lon": -2.0, "alt_baro": 37000, "gs": 480,
          "track": 270, "r": "B-LXA", "t": "A35K"}
    out = flightwatch._shape(ac, 52.4, -2.2)   # noqa: SLF001 - pure helper
    assert out["altitude"] == 37000
    assert out["distance_mi"] >= 0
    assert out["compass"]


def test_shape_treats_ground_altitude_as_zero():
    ac = {"hex": "abc", "lat": 52.4, "lon": -2.2, "alt_baro": "ground"}
    assert flightwatch._shape(ac, 52.4, -2.2)["altitude"] == 0   # noqa: SLF001
