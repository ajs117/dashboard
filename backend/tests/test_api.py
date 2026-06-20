"""HTTP-level tests for the config/location endpoints (no upstream network needed)."""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(
        "location: {label: Test, lat: 1.0, lon: 2.0, timezone: UTC}\n"
        "trains: {token: SECRET, station_crs: KGX, enabled: true}\n"
        "aircraft: {enabled: true, radius_nm: 50}\n"
        "units: {temperature: celsius}\n"
        "world_clocks: []\n"
        "refresh: {weather: 600}\n"
        "cache: {weather: 600}\n"
        "admin_token: hunter2\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("DASHBOARD_CONFIG", str(cfg_file))
    import app.config as config_mod
    importlib.reload(config_mod)
    import app.main as main_mod
    importlib.reload(main_mod)
    with TestClient(main_mod.app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["using_example_config"] is False


def test_config_hides_token(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert body["location"]["label"] == "Test"
    assert "token" not in body["trains"]
    assert "admin_token" not in body


def test_location_requires_token(client):
    r = client.post("/api/location", json={"lat": 5.0, "lon": 6.0})
    assert r.status_code == 403


def test_location_update_with_token(client):
    r = client.post(
        "/api/location",
        json={"lat": 5.0, "lon": 6.0, "label": "New"},
        headers={"X-Admin-Token": "hunter2"},
    )
    assert r.status_code == 200
    assert r.json()["location"]["lat"] == 5.0
    # Reflected in subsequent config read.
    assert client.get("/api/config").json()["location"]["label"] == "New"
