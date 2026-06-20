"""Provider parsing tests — fully offline via httpx MockTransport."""
from __future__ import annotations

import httpx
import pytest

from app.providers import aircraft, photos, radar, weather
from tests.conftest import load_fixture


async def test_weather_parsing(make_mock_http, sample_cfg):
    def handler(request):
        assert "open-meteo" in request.url.host
        return httpx.Response(200, json=load_fixture("open_meteo.json"))

    make_mock_http(handler)
    out = await weather.fetch(sample_cfg)

    assert out["current"]["temperature"] == 14.3
    assert out["current"]["text"] == "Overcast"          # code 3
    assert len(out["daily"]) == 5
    assert out["daily"][1]["text"] == "Light rain"        # code 61
    # New requirement: sun + moon present
    assert out["sun"]["sunrise"] == "2026-06-20T04:42"
    assert out["sun"]["sunset"] == "2026-06-20T21:21"
    assert "name" in out["moon"]
    assert 0.0 <= out["moon"]["illumination"] <= 1.0


async def test_radar_parsing(make_mock_http, sample_cfg):
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("rainviewer.json")))
    out = await radar.fetch(sample_cfg)
    assert out["host"] == "https://tilecache.rainviewer.com"
    assert out["past_count"] == 2
    assert out["nowcast_count"] == 1
    assert len(out["frames"]) == 3                         # past + nowcast


async def test_aircraft_parsing_sorts_and_filters(make_mock_http, sample_cfg):
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("airplanes.json")))
    out = await aircraft.fetch(sample_cfg)

    # The one with null lat/lon is dropped; 3 remain.
    assert out["count"] == 3
    callsigns = [a["callsign"] for a in out["aircraft"]]
    assert "NOPOS" not in callsigns
    # Sorted nearest-first by distance.
    dists = [a["distance_mi"] for a in out["aircraft"]]
    assert dists == sorted(dists)
    # 'ground' altitude normalised to 0.
    grounded = [a for a in out["aircraft"] if a["callsign"] == "EZY456"][0]
    assert grounded["altitude"] == 0
    assert grounded["elevation"] == 0.0          # on the ground -> look at horizon
    # Callsign whitespace trimmed.
    baw = [a for a in out["aircraft"] if a["hex"] == "400f1a"][0]
    assert baw["callsign"] == "BAW123"
    # Look-angles present and sane.
    for a in out["aircraft"]:
        assert 0 <= a["azimuth"] <= 360
        assert a["compass"] in {
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
        }
        assert a["elevation"] >= 0.0
        assert a["distance_mi"] >= 0.0


async def test_aircraft_respects_max_results(make_mock_http, sample_cfg):
    sample_cfg["aircraft"]["max_results"] = 1
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("airplanes.json")))
    out = await aircraft.fetch(sample_cfg)
    assert len(out["aircraft"]) == 1


async def test_photo_found(make_mock_http):
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("planespotters.json")))
    out = await photos.fetch("400F1A")
    assert out["thumbnail"] == "https://t.plnspttrs.net/large.jpg"
    assert out["photographer"] == "Jane Doe"
    assert out["hex"] == "400f1a"                          # normalised lower


async def test_photo_missing_returns_none(make_mock_http):
    make_mock_http(lambda r: httpx.Response(200, json={"photos": []}))
    assert await photos.fetch("abc123") is None


async def test_photo_empty_hex_returns_none(make_mock_http):
    assert await photos.fetch("") is None


async def test_upstream_error_raises(make_mock_http, sample_cfg):
    make_mock_http(lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(httpx.HTTPStatusError):
        await weather.fetch(sample_cfg)
