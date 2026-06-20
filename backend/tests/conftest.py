"""Shared test fixtures.

`mock_http` installs an httpx.AsyncClient backed by a MockTransport as the shared
provider client, so provider tests run fully offline with canned responses.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app import providers

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def make_mock_http(monkeypatch):
    """Returns a factory: pass a handler(request)->httpx.Response to install it."""
    def _install(handler):
        transport = httpx.MockTransport(handler)
        client = httpx.AsyncClient(transport=transport)
        monkeypatch.setattr(providers, "_client", client)
        return client
    return _install


@pytest.fixture
def sample_cfg() -> dict:
    return {
        "location": {"label": "Home", "lat": 51.5074, "lon": -0.1278,
                     "timezone": "Europe/London"},
        "units": {"temperature": "celsius", "wind": "kmh", "distance": "nm"},
        "aircraft": {"enabled": True, "radius_nm": 50, "max_results": 5},
        "trains": {"enabled": True, "token": "T", "station_crs": "KGX",
                   "destination_crs": "", "rows": 10},
        "cache": {"weather": 600, "radar": 120, "aircraft": 5, "trains": 30},
    }
