"""HTTP-level tests for the config/location endpoints (no upstream network needed)."""
from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


def _make_client(tmp_path, monkeypatch, admin_token: str):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(
        "location: {label: Test, lat: 1.0, lon: 2.0, timezone: UTC}\n"
        "trains: {token: SECRET, station_crs: KGX, enabled: true}\n"
        "aircraft: {enabled: true, radius_nm: 50}\n"
        "units: {temperature: celsius}\n"
        "world_clocks: []\n"
        "refresh: {weather: 600}\n"
        "cache: {weather: 600}\n"
        f"admin_token: {admin_token}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("DASHBOARD_CONFIG", str(cfg_file))
    import app.config as config_mod
    importlib.reload(config_mod)
    import app.main as main_mod
    importlib.reload(main_mod)
    return TestClient(main_mod.app)


@pytest.fixture
def client(tmp_path, monkeypatch):
    with _make_client(tmp_path, monkeypatch, "hunter2") as c:
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


def test_location_wrong_token_rejected(client):
    r = client.post(
        "/api/location",
        json={"lat": 5.0, "lon": 6.0},
        headers={"X-Admin-Token": "nope"},
    )
    assert r.status_code == 403


def test_placeholder_token_blocks_writes(tmp_path, monkeypatch):
    # A config that still has the example placeholder must refuse writes (503),
    # even when the caller presents that placeholder.
    with _make_client(tmp_path, monkeypatch, "change-me") as c:
        r = c.post(
            "/api/location",
            json={"lat": 5.0, "lon": 6.0},
            headers={"X-Admin-Token": "change-me"},
        )
        assert r.status_code == 503


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
