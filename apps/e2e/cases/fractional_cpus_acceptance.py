"""Opt-in CPU acceptance against the managed local Cloud/Runner stack.

Run explicitly: make test:e2e E2E_ARGS=cases/fractional_cpus_acceptance.py.
Host cgroups are required, so this file is outside default remote-stage discovery.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sqlite3
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import boxlite
import pytest

from conftest import drain
from e2e_auth import auth_context
from network_fixtures import state

MIN_CPUS = (
    json.loads(
        (Path(__file__).resolve().parents[3] / "openapi/cpu-resources.json").read_text()
    )["minimum_millicpus"]
    / 1000
)


def runner_pid(box_id: str) -> int:
    # This acceptance requires the managed local Runner's actual runtime home.
    # A missing home is a setup failure, never a skipped enforcement assertion.
    home = Path(os.environ["BOXLITE_HOME_DIR"])
    database = home / "db" / "boxlite.db"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
        row = db.execute(
            "SELECT s.pid FROM box_config c JOIN box_state s ON c.id=s.id WHERE c.name=?",
            (box_id,),
        ).fetchone()
    assert row and row[0], f"no running Runner VM for {box_id}"
    return row[0]


def assert_host_quota(box_id: str, cpus: float) -> None:
    membership = Path(f"/proc/{runner_pid(box_id)}/cgroup").read_text()
    relative = next(
        line[3:] for line in membership.splitlines() if line.startswith("0::")
    )
    quota = (
        (Path("/sys/fs/cgroup") / relative.lstrip("/") / "cpu.max").read_text().strip()
    )
    assert quota == f"{round(cpus * 100_000)} 100000", quota


@pytest.mark.asyncio
@pytest.mark.parametrize("cpus", [MIN_CPUS - 0.001, MIN_CPUS + 0.0001])
async def test_fractional_cpus_cloud_rejects_invalid_http(cpus):
    ctx = auth_context()

    def send():
        request = Request(
            ctx.url_for(ctx.v1("boxes")),
            data=json.dumps({"image": "alpine:3.21", "cpus": cpus}).encode(),
            headers={
                "Authorization": "Bearer " + ctx.token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with pytest.raises(HTTPError) as error:
            urlopen(request, timeout=30)
        assert error.value.code == 400
        assert b"cpu" in error.value.read().lower()

    await asyncio.to_thread(send)


@pytest.mark.asyncio
@pytest.mark.parametrize("cpus", [MIN_CPUS, 0.5, 1.5])
async def test_fractional_cpus_cloud_create_restart(rt, cpus):
    image = "alpine:3.21"
    box = await rt.create(boxlite.BoxOptions(image=image, cpus=cpus, memory_mib=1024))
    try:
        assert (await box.info()).cpus == cpus
        assert (await rt.get_info(box.id)).cpus == cpus
        assert (
            next(info for info in await rt.list_info() if info.id == box.id).cpus
            == cpus
        )
        execution = await box.exec("nproc", [])
        stdout, _ = await drain(execution)
        assert int(stdout.strip()) == math.ceil(cpus)
        assert_host_quota(box.id, cpus)
        await box.stop()
        await state(rt, box.id, "stopped")
        reopened = await rt.get(box.id)
        assert (await reopened.info()).cpus == cpus
        await reopened.start()
        await state(rt, box.id, "running")
        assert_host_quota(box.id, cpus)
    finally:
        await remove_settled(rt, box.id)


async def remove_settled(rt, box_id: str) -> None:
    deadline = asyncio.get_running_loop().time() + 60
    while True:
        try:
            await rt.remove(box_id, force=True)
            return
        except boxlite.InvalidArgumentError as error:
            if "state change in progress" not in str(error).lower():
                raise
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(0.2)


async def runner_post(path: str, body: dict) -> None:
    def send():
        request = Request(
            os.environ["DEFAULT_RUNNER_API_URL"] + path,
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + os.environ["BOXLITE_RUNNER_TOKEN"],
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlopen(request, timeout=120) as response:
            assert response.status in (200, 201, 204)

    await asyncio.to_thread(send)


@pytest.mark.asyncio
async def test_fractional_cpus_runner_v0_create_and_recover(rt):
    image = "alpine:3.21"
    # Keep a real Cloud row so Runner reconciliation recognizes this VM while
    # the legacy HTTP entry points recreate it with the same allocation.
    box = await rt.create(
        boxlite.BoxOptions(image=image, cpus=MIN_CPUS, memory_mib=1024)
    )
    body = {
        "id": box.id,
        "image": image,
        "osUser": "root",
        "cpuQuota": MIN_CPUS,
        "memoryQuota": 1,
        "storageQuota": 1,
        "outboundEnabled": True,
    }
    try:
        await runner_post(f"/boxes/{box.id}/destroy", {})
        await runner_post("/boxes", body)
        assert_host_quota(box.id, MIN_CPUS)
        pid = runner_pid(box.id)
        for invalid in (0, MIN_CPUS - 0.001, MIN_CPUS + 0.0001):
            with pytest.raises(HTTPError) as error:
                await runner_post(
                    f"/boxes/{box.id}/recover",
                    {
                        **body,
                        "cpuQuota": invalid,
                        "errorReason": "acceptance",
                    },
                )
            assert error.value.code == 400
            assert runner_pid(box.id) == pid
            assert_host_quota(box.id, MIN_CPUS)
        await runner_post(
            f"/boxes/{box.id}/recover", {**body, "errorReason": "acceptance"}
        )
        assert_host_quota(box.id, MIN_CPUS)
        assert (await rt.get_info(box.id)).cpus == MIN_CPUS
    finally:
        await remove_settled(rt, box.id)
