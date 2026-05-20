"""End-to-end smoke test against real BoxLite.

Gated on BOXLITE_INTEGRATION=1 because it pulls postgres:16-alpine and
boots a real microVM (~60s on a cold cache).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
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


@pytest.fixture
def tmp_config(monkeypatch):
    """Isolate test data dir per run so we don't clobber a developer's local state."""
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-local-itest-"))
    monkeypatch.setenv("BOXLITE_DATA_DIR", str(tmp))
    cfg = InfraConfig.load()
    yield cfg
    shutil.rmtree(tmp, ignore_errors=True)


def test_walking_skeleton_round_trip(tmp_config: InfraConfig):
    asyncio.run(_round_trip(tmp_config))


async def _round_trip(cfg: InfraConfig) -> None:
    # 1. doctor passes on a clean machine
    report = await doctor(cfg, SERVICES, strict=False)
    assert not report.any_fail(), f"doctor failed before up: {report.checks!r}"

    try:
        # 2. up brings pg to RUNNING + healthy
        # skip_doctor=True because we already asserted doctor in step 1
        await up(cfg, SERVICES, skip_doctor=True)

        # 3. ps shows boxlite-local-postgres RUNNING
        rows = await ps(cfg)
        names = {name for name, _status, _image in rows}
        assert "boxlite-local-postgres" in names
        status = next(s for n, s, _ in rows if n == "boxlite-local-postgres")
        assert status.lower() == "running", f"unexpected status: {status}"

        # 4. pg_isready inside the box confirms server is up
        runtime = get_runtime()
        box = await runtime.get("boxlite-local-postgres")
        rc, out, err = await exec_collect(
            box, "pg_isready", ["-U", "boxlite", "-d", "boxlite", "-t", "1"]
        )
        assert rc == 0, f"pg_isready failed: rc={rc} out={out!r} err={err!r}"

        # Confirm data_dir was actually created by up() — makes the post-down assertion meaningful
        assert cfg.data_dir.exists(), f"data_dir not created by up(): {cfg.data_dir}"
    finally:
        # 5. down --wipe removes box and data
        await down(cfg, SERVICES, wipe=True)

    # 6. ps shows no boxlite-local-* boxes
    rows = await ps(cfg)
    names = {name for name, _, _ in rows}
    assert "boxlite-local-postgres" not in names
    assert not cfg.data_dir.exists()
