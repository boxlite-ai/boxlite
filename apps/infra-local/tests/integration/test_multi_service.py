"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

import pytest

from boxlite_local.config import InfraConfig
from boxlite_local.doctor import doctor
from boxlite_local.execwrap import exec_collect
from boxlite_local.orchestrator import down, get_runtime, ps, up
from boxlite_local.services import SERVICES

pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_INTEGRATION") != "1",
    reason="set BOXLITE_INTEGRATION=1 to run",
)


_DAEMON_SERVICES = [
    "boxlite-local-postgres",
    "boxlite-local-redis",
    "boxlite-local-minio",
    "boxlite-local-registry",
    "boxlite-local-dex",
    "boxlite-local-jaeger",
    "boxlite-local-pgadmin",
    "boxlite-local-registry-ui",
    "boxlite-local-otel",
    "boxlite-local-caddy",
]
_ONE_SHOT_SERVICES = ["boxlite-local-minio-init"]


@pytest.fixture
def tmp_config(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_11_service_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    pre = await ps(cfg)
    pre_names = [n for n, _, _ in pre]
    if pre_names:
        pytest.skip(
            f"refusing to run: pre-existing boxlite-local-* boxes would be destroyed "
            f"by cleanup ({pre_names}). Run `python -m boxlite_local down --wipe` first."
        )

    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        await up(cfg, SERVICES, skip_doctor=True)

        rows = await ps(cfg)
        names = {n for n, _, _ in rows}
        for daemon in _DAEMON_SERVICES:
            assert daemon in names, f"missing daemon: {daemon} (got {names})"
            status = next(s for n, s, _ in rows if n == daemon)
            assert status.lower() == "running", f"{daemon}: unexpected status {status}"
        for one_shot in _ONE_SHOT_SERVICES:
            assert one_shot not in names, \
                f"one-shot {one_shot} should be removed but still listed"

        assert cfg.data_dir.exists(), f"data_dir not created by up(): {cfg.data_dir}"

        # Reachability spot-checks from the host
        runtime = get_runtime()

        pg_box = await runtime.get("boxlite-local-postgres")
        rc, _o, _e = await exec_collect(
            pg_box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, "pg_isready failed inside pg box"

        redis_box = await runtime.get("boxlite-local-redis")
        rc, out, _e = await exec_collect(redis_box, "redis-cli", ["PING"])
        assert rc == 0 and "PONG" in out, f"redis PING failed: rc={rc} out={out!r}"

        for url, label in [
            (f"http://127.0.0.1:{cfg.minio_host_port}/minio/health/live", "minio"),
            (f"http://127.0.0.1:{cfg.registry_host_port}/v2/", "registry"),
            (f"http://127.0.0.1:{cfg.dex_host_port}/dex/.well-known/openid-configuration", "dex"),
            (f"http://127.0.0.1:{cfg.jaeger_host_port}/", "jaeger"),
            (f"http://127.0.0.1:{cfg.pgadmin_host_port}/misc/ping", "pgadmin"),
            (f"http://127.0.0.1:{cfg.registry_ui_host_port}/", "registry-ui"),
            (f"http://127.0.0.1:{cfg.otel_health_port}/", "otel"),
            (f"http://127.0.0.1:{cfg.caddy_http_port}/", "caddy-index"),
        ]:
            with urllib.request.urlopen(url, timeout=5) as resp:
                assert 200 <= resp.status < 300, f"{label} bad status: {resp.status} for {url}"

        # Caddy reverse proxy via HTTP (TLS is intentionally not enabled —
        # `tls internal` can't mint certs for raw IPs and we don't have
        # DNS hijack yet). Verify path routing works.
        for path, label in [
            ("/jaeger/", "caddy-via-jaeger"),
            ("/registry/v2/", "caddy-via-registry"),
        ]:
            url = f"http://127.0.0.1:{cfg.caddy_http_port}{path}"
            with urllib.request.urlopen(url, timeout=5) as resp:
                assert 200 <= resp.status < 300, f"{label} bad status: {resp.status} for {url}"

    finally:
        await down(cfg, SERVICES, wipe=True)

    rows = await ps(cfg)
    names = {n for n, _, _ in rows}
    for daemon in _DAEMON_SERVICES:
        assert daemon not in names
    assert not cfg.data_dir.exists()
