"""Unit tests for InfraConfig defaults and env-var overrides."""

from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig, pick_runtime_dir


def _make_runtime(parent: Path, name: str, *, guest: bool, complete: bool = True) -> Path:
    d = parent / name
    d.mkdir(parents=True)
    if guest:
        (d / "boxlite-guest").write_bytes(b"\x00")
    if complete:
        (d / ".complete").write_text("0.9.5")
    return d


def test_pick_runtime_dir_selects_complete_matching_version(tmp_path):
    rt = tmp_path / "runtimes"
    rt.mkdir()
    good = _make_runtime(rt, "v0.9.5", guest=True)
    # .complete stamp but no boxlite-guest — the stale/partial cache the SDK
    # fast-path trusts and then fails on at box.start().
    _make_runtime(rt, "v0.9.5-deadbeef", guest=False)
    _make_runtime(rt, "v0.8.0", guest=True)  # wrong version
    assert pick_runtime_dir(rt, "0.9.5") == good


def test_pick_runtime_dir_skips_complete_marker_without_guest(tmp_path):
    rt = tmp_path / "runtimes"
    rt.mkdir()
    _make_runtime(rt, "v0.9.5-deadbeef", guest=False)
    assert pick_runtime_dir(rt, "0.9.5") is None


def test_pick_runtime_dir_none_when_dir_missing(tmp_path):
    assert pick_runtime_dir(tmp_path / "nope", "0.9.5") is None


def test_pick_runtime_dir_prefers_hashless_release(tmp_path):
    rt = tmp_path / "runtimes"
    rt.mkdir()
    release = _make_runtime(rt, "v0.9.5", guest=True)
    _make_runtime(rt, "v0.9.5-deadbeef", guest=True)
    assert pick_runtime_dir(rt, "0.9.5") == release


def test_pick_runtime_dir_matches_debug_hash_when_no_release(tmp_path):
    rt = tmp_path / "runtimes"
    rt.mkdir()
    debug = _make_runtime(rt, "v0.9.5-deadbeef", guest=True)
    assert pick_runtime_dir(rt, "0.9.5") == debug


def test_pick_runtime_dir_skips_other_version_and_extracting_tmp(tmp_path):
    rt = tmp_path / "runtimes"
    rt.mkdir()
    _make_runtime(rt, "v0.9.5.extracting.123", guest=True)  # interrupted extraction
    _make_runtime(rt, "v0.8.0", guest=True)  # other version
    assert pick_runtime_dir(rt, "0.9.5") is None


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


def test_load_expands_tilde_in_data_dir_env(monkeypatch):
    # Docs tell users they can set BOXLITE_DATA_DIR=~/.boxlite-local/data.
    # Path("~/...") does NOT expand ~ on its own, so .load() must expanduser()
    # — otherwise a literal "~" dir gets created under the cwd.
    monkeypatch.setenv("BOXLITE_DATA_DIR", "~/.boxlite-local/data")

    cfg = InfraConfig.load()

    assert "~" not in str(cfg.data_dir)
    assert cfg.data_dir == Path.home() / ".boxlite-local" / "data"


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


def test_new_3a_defaults():
    cfg = InfraConfig()
    assert cfg.redis_host_port == 26379
    assert cfg.minio_host_port == 29000
    assert cfg.minio_user == "minioadmin"
    assert cfg.minio_password == "minioadmin"
    assert cfg.registry_host_port == 25000


def test_minio_password_hidden_in_repr():
    cfg = InfraConfig(minio_password="hunter2")
    assert "hunter2" not in repr(cfg)


def test_load_picks_up_3a_env_overrides(monkeypatch):
    monkeypatch.setenv("BOXLITE_REDIS_HOST_PORT", "16379")
    monkeypatch.setenv("BOXLITE_MINIO_HOST_PORT", "19000")
    monkeypatch.setenv("BOXLITE_MINIO_USER", "u1")
    monkeypatch.setenv("BOXLITE_MINIO_PASSWORD", "p1")
    monkeypatch.setenv("BOXLITE_REGISTRY_HOST_PORT", "15000")

    cfg = InfraConfig.load()
    assert cfg.redis_host_port == 16379
    assert cfg.minio_host_port == 19000
    assert cfg.minio_user == "u1"
    assert cfg.minio_password == "p1"
    assert cfg.registry_host_port == 15000


def test_repo_root_points_at_repo_with_pyproject_in_apps_infra_local():
    cfg = InfraConfig()
    assert (cfg.repo_root / "apps" / "infra-local" / "pyproject.toml").exists(), \
        f"_detect_repo_root returned wrong dir: {cfg.repo_root}"


def test_load_raises_clear_error_on_malformed_redis_port_env(monkeypatch):
    monkeypatch.setenv("BOXLITE_REDIS_HOST_PORT", "notanumber")
    import pytest as _pytest
    with _pytest.raises(ValueError, match="BOXLITE_REDIS_HOST_PORT must be an integer"):
        InfraConfig.load()


def test_new_3b_defaults():
    cfg = InfraConfig()
    assert cfg.dex_host_port == 25556
    assert cfg.jaeger_host_port == 26686
    assert cfg.pgadmin_host_port == 25051
    assert cfg.pgadmin_email == "admin@boxlite.dev"
    assert cfg.pgadmin_password == "boxlite"
    assert cfg.registry_ui_host_port == 25052


def test_dex_issuer_uses_localhost_for_browser_oidc_flow():
    cfg = InfraConfig()
    # Browser-fetched discovery doc needs a hostname the browser can resolve;
    # host.boxlite.internal only resolves inside boxes.
    assert cfg.dex_issuer == "http://localhost:25556/dex"


def test_pgadmin_password_hidden_in_repr():
    cfg = InfraConfig(pgadmin_password="topsecret")
    assert "topsecret" not in repr(cfg)


def test_load_picks_up_3b_env_overrides(monkeypatch):
    monkeypatch.setenv("BOXLITE_DEX_HOST_PORT", "15556")
    monkeypatch.setenv("BOXLITE_JAEGER_HOST_PORT", "16686")
    monkeypatch.setenv("BOXLITE_PGADMIN_HOST_PORT", "15051")
    monkeypatch.setenv("BOXLITE_PGADMIN_EMAIL", "ops@example.com")
    monkeypatch.setenv("BOXLITE_PGADMIN_PASSWORD", "p2")
    monkeypatch.setenv("BOXLITE_REGISTRY_UI_HOST_PORT", "15052")

    cfg = InfraConfig.load()
    assert cfg.dex_host_port == 15556
    assert cfg.jaeger_host_port == 16686
    assert cfg.pgadmin_host_port == 15051
    assert cfg.pgadmin_email == "ops@example.com"
    assert cfg.pgadmin_password == "p2"
    assert cfg.registry_ui_host_port == 15052


def test_new_3c_defaults():
    cfg = InfraConfig()
    assert cfg.caddy_http_port == 28080
    assert cfg.caddy_https_port == 28443
    assert cfg.otel_grpc_port == 24317
    assert cfg.otel_http_port == 24318
    assert cfg.otel_health_port == 23133


def test_load_picks_up_3c_env_overrides(monkeypatch):
    monkeypatch.setenv("BOXLITE_CADDY_HTTP_PORT", "18080")
    monkeypatch.setenv("BOXLITE_CADDY_HTTPS_PORT", "18443")
    monkeypatch.setenv("BOXLITE_OTEL_GRPC_PORT", "14317")
    monkeypatch.setenv("BOXLITE_OTEL_HTTP_PORT", "14318")
    monkeypatch.setenv("BOXLITE_OTEL_HEALTH_PORT", "13133")

    cfg = InfraConfig.load()
    assert cfg.caddy_http_port == 18080
    assert cfg.caddy_https_port == 18443
    assert cfg.otel_grpc_port == 14317
    assert cfg.otel_http_port == 14318
    assert cfg.otel_health_port == 13133
