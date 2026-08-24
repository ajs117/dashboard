"""Config loader: env override, public() strips secrets, save() round-trips."""
from __future__ import annotations

import importlib
import os
import stat

import pytest

import app.config as config_mod


@pytest.fixture
def fresh_config(tmp_path, monkeypatch):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(
        "location: {label: Test, lat: 1.0, lon: 2.0, timezone: UTC}\n"
        "trains: {token: SECRET, station_crs: KGX, rows: 5}\n"
        "aircraft: {radius_nm: 50}\n"
        "units: {temperature: celsius}\n"
        "world_clocks: []\n"
        "refresh: {weather: 600}\n"
        "admin_token: hunter2\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("DASHBOARD_CONFIG", str(cfg_file))
    importlib.reload(config_mod)
    config_mod.load()
    return config_mod, cfg_file


def test_load_from_env(fresh_config):
    cfg, path = fresh_config
    assert cfg.source_path() == path
    assert cfg.is_fallback() is False
    assert cfg.get()["location"]["label"] == "Test"


def test_public_strips_token(fresh_config):
    cfg, _ = fresh_config
    pub = cfg.public()
    assert "token" not in pub["trains"]
    assert pub["trains"]["station_crs"] == "KGX"
    assert "admin_token" not in pub


def test_save_roundtrip(fresh_config):
    cfg, path = fresh_config
    cfg.get()["location"]["lat"] = 9.9
    cfg.save()
    # Reload a clean module instance from the same file.
    importlib.reload(cfg)
    cfg.load()
    assert cfg.get()["location"]["lat"] == 9.9
    # Token preserved through save.
    assert cfg.get()["trains"]["token"] == "SECRET"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_save_keeps_secret_config_owner_only(fresh_config):
    cfg, path = fresh_config
    path.chmod(0o644)
    cfg.save()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.parametrize("bad", [
    {"location": None},
    {"location": {"lat": None, "lon": 0}},
    {"location": {"lat": 0, "lon": 181}},
    {"location": {"lat": 0, "lon": 0, "timezone": "../not-a-timezone"}},
    {"aircraft": None},
    {"watch_flights": "BA123"},
])
def test_validate_rejects_endpoint_breaking_shapes(bad):
    with pytest.raises(ValueError):
        config_mod.validate(bad)
