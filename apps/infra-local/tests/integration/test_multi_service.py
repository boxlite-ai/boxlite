"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1 because it pulls 4 OCI images and boots
real microVMs (~90s on cold cache).
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


_DAEMON_SERVICES = ["boxlite-local-postgres", "boxlite-local-redis",
                    "boxlite-local-minio", "boxlite-local-registry"]
_ONE_SHOT_SERVICES = ["boxlite-local-minio-init"]


@pytest.fixture
def tmp_config(monkeypatch):
    """Isolate test data dir per run; do not clobber developer state."""
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_5_service_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    # 0. Guard: refuse to run if any boxlite-local-* box already exists.
    pre = await ps(cfg)
    pre_names = [n for n, _, _ in pre]
    if pre_names:
        pytest.skip(
            f"refusing to run: pre-existing boxlite-local-* boxes would be destroyed "
            f"by cleanup ({pre_names}). Run `python -m boxlite_local down --wipe` first."
        )

    # 1. doctor clean on this machine
    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        # 2. up brings 4 daemons healthy + runs minio-init one-shot
        await up(cfg, SERVICES, skip_doctor=True)

        # 3. ps shows the 4 daemons RUNNING and minio-init absent
        rows = await ps(cfg)
        names = {n for n, _, _ in rows}
        for daemon in _DAEMON_SERVICES:
            assert daemon in names, f"missing daemon: {daemon} (got {names})"
            status = next(s for n, s, _ in rows if n == daemon)
            assert status.lower() == "running", f"{daemon}: unexpected status {status}"
        for one_shot in _ONE_SHOT_SERVICES:
            assert one_shot not in names, \
                f"one-shot service {one_shot} should have been removed but is still listed"

        # 4. data_dir was created by up()
        assert cfg.data_dir.exists(), f"data_dir not created by up(): {cfg.data_dir}"

        # 5. Reachability spot-checks from the host
        runtime = get_runtime()

        # 5a. pg_isready inside pg box
        pg_box = await runtime.get("boxlite-local-postgres")
        rc, _o, _e = await exec_collect(
            pg_box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, "pg_isready failed inside pg box"

        # 5b. redis-cli PING inside redis box
        redis_box = await runtime.get("boxlite-local-redis")
        rc, out, _e = await exec_collect(redis_box, "redis-cli", ["PING"])
        assert rc == 0 and "PONG" in out, f"redis PING failed: rc={rc} out={out!r}"

        # 5c. minio health endpoint reachable from host
        with urllib.request.urlopen(
            f"http://127.0.0.1:{cfg.minio_host_port}/minio/health/live", timeout=3
        ) as resp:
            assert 200 <= resp.status < 300, f"minio health bad status: {resp.status}"

        # 5d. registry v2 endpoint reachable from host
        with urllib.request.urlopen(
            f"http://127.0.0.1:{cfg.registry_host_port}/v2/", timeout=3
        ) as resp:
            assert 200 <= resp.status < 300, f"registry v2 bad status: {resp.status}"

    finally:
        # 6. down --wipe removes everything
        await down(cfg, SERVICES, wipe=True)

    # 7. ps clean + data_dir gone
    rows = await ps(cfg)
    names = {n for n, _, _ in rows}
    for daemon in _DAEMON_SERVICES:
        assert daemon not in names
    assert not cfg.data_dir.exists()
