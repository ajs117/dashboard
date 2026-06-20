"""Stocks (Yahoo) and flight-route (adsbdb) parsing — offline via MockTransport."""
from __future__ import annotations

import httpx

from app.providers import route, stocks
from tests.conftest import load_fixture


async def test_stocks_change_and_pct(make_mock_http):
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("yahoo_ftse.json")))
    cfg = {"stocks": {"symbols": [{"symbol": "^FTSE", "label": "FTSE 100"}]}}
    out = await stocks.fetch(cfg)
    q = out["quotes"][0]
    assert q["ok"] is True
    assert q["price"] == 8200.5
    assert q["change"] == 50.5
    assert q["pct"] == round(50.5 / 8150.0 * 100, 2)
    assert q["currency"] == "GBP"


async def test_stocks_one_bad_symbol_isolated(make_mock_http):
    def handler(request):
        if "BAD" in str(request.url):
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json=load_fixture("yahoo_ftse.json"))

    make_mock_http(handler)
    cfg = {"stocks": {"symbols": [
        {"symbol": "^FTSE", "label": "FTSE 100"},
        {"symbol": "BAD", "label": "Broken"},
    ]}}
    out = await stocks.fetch(cfg)
    oks = {q["label"]: q["ok"] for q in out["quotes"]}
    assert oks == {"FTSE 100": True, "Broken": False}   # failure isolated per-row


async def test_route_parsing(make_mock_http):
    make_mock_http(lambda r: httpx.Response(200, json=load_fixture("adsbdb_route.json")))
    out = await route.fetch("baw123")
    assert out["airline"] == "British Airways"
    assert out["origin"]["iata"] == "LHR"
    assert out["destination"]["city"] == "New York"


async def test_route_unknown_string(make_mock_http):
    make_mock_http(lambda r: httpx.Response(200, json={"response": "unknown callsign"}))
    assert await route.fetch("ZZZ999") is None


async def test_route_404(make_mock_http):
    make_mock_http(lambda r: httpx.Response(404, json={"response": "unknown callsign"}))
    assert await route.fetch("ZZZ999") is None


async def test_route_empty_callsign(make_mock_http):
    assert await route.fetch("") is None
