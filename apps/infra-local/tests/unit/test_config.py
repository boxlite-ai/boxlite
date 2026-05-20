"""Unit tests for InfraConfig defaults and env-var overrides."""

from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig


def test_defaults():
    cfg = InfraConfig()
    assert cfg.host_hub == "host.boxlite.internal"
    assert cfg.pg_host_port == 25432
    assert cfg.pg_user == "boxlite"
    assert cfg.pg_password == "boxlite"
    assert cfg.pg_db == "boxlite"
    assert cfg.data_dir == Path.home() / ".boxlite-local" / "data"


def test_pg_url_uses_host_hub_and_port():
    cfg = InfraConfig()
    assert cfg.pg_url == "postgresql://boxlite@host.boxlite.internal:25432/boxlite"


def test_load_picks_up_env_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("BOXLITE_HOST_HUB", "custom.host")
    monkeypatch.setenv("BOXLITE_PG_HOST_PORT", "55432")
    monkeypatch.setenv("BOXLITE_PG_USER", "alice")
    monkeypatch.setenv("BOXLITE_PG_PASSWORD", "s3cret")
    monkeypatch.setenv("BOXLITE_PG_DB", "appdb")
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp_path))

    cfg = InfraConfig.load()

    assert cfg.host_hub == "custom.host"
    assert cfg.pg_host_port == 55432
    assert cfg.pg_user == "alice"
    assert cfg.pg_password == "s3cret"
    assert cfg.pg_db == "appdb"
    assert cfg.data_dir == tmp_path


def test_load_raises_clear_error_on_malformed_int_env(monkeypatch):
    monkeypatch.setenv("BOXLITE_PG_HOST_PORT", "notanumber")
    with pytest.raises(ValueError, match="BOXLITE_PG_HOST_PORT must be an integer"):
        InfraConfig.load()


def test_load_falls_back_to_defaults_when_env_unset(monkeypatch):
    for var in (
        "BOXLITE_HOST_HUB", "BOXLITE_PG_HOST_PORT", "BOXLITE_PG_USER",
        "BOXLITE_PG_PASSWORD", "BOXLITE_PG_DB", "BOXLITE_DATA_DIR",
    ):
        monkeypatch.delenv(var, raising=False)

    cfg = InfraConfig.load()

    assert cfg.host_hub == "host.boxlite.internal"
    assert cfg.pg_host_port == 25432
    assert cfg.data_dir == Path.home() / ".boxlite-local" / "data"
