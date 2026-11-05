"""Grow a running cloud Box through the SDK and CLI without replacing its VM."""

import asyncio
import json
import os

import boxlite
import pytest

from conftest import drain
from test_cli_entry import cli

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        os.environ.get("BOXLITE_E2E_RESIZE") != "1",
        reason="requires CLOUD_RESIZE_ENABLED=true and a Linux/KVM resize-capable runner",
    ),
]


async def guest_resources(box):
    execution = await box.exec(
        "sh",
        [
            "-c",
            "cat /proc/sys/kernel/random/boot_id; "
            "awk '{print $22}' /proc/1/stat; nproc; "
            "awk '/MemTotal/{print $2}' /proc/meminfo",
        ],
    )
    stdout, stderr = await drain(execution)
    assert (await execution.wait()).exit_code == 0, stderr
    boot, init_start, cpus, memory_kib = stdout.splitlines()
    return (boot, init_start), int(cpus), int(memory_kib)


async def cli_resize(binary, auth, box_id, *options):
    env = {**os.environ, "BOXLITE_API_KEY": auth.token}
    env.pop("BOXLITE_PROFILE", None)
    process = await asyncio.create_subprocess_exec(
        binary, "--url", auth.url, "--path-prefix", auth.path_prefix,
        "resize", box_id, *options,
        env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
        assert process.returncode == 0, stderr.decode().replace(auth.token, "[redacted]")
        return json.loads(stdout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_resize_preserves_guest_and_rejects_shrinking(rt, image, cli, e2e_auth):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image, cpus=1, memory_mib=1024,
            entrypoint=["sh", "-c"], cmd=["exec sleep 600"],
        ),
    )
    try:
        before, cpus_before, memory_before = await guest_resources(box)
        assert cpus_before == 1
        current = await box.resize()
        assert (current.cpus, current.memory_mib) == (1, 1024)
        assert current.max_cpus >= 2 and current.max_memory_mib >= 2048

        # Cloud requests round memory upward to whole GiB before dispatch.
        grown = await box.resize(cpus=2, memory_mib=1537)
        assert (grown.cpus, grown.memory_mib) == (2, 2048)
        after, cpus_after, memory_after = await guest_resources(box)
        assert after == before
        assert cpus_after == 2 and memory_after > memory_before

        repeated = await cli_resize(cli, e2e_auth, box.id, "--cpus", "2", "--memory", "2048")
        assert (repeated["cpus"], repeated["memory_mib"]) == (2, 2048)
        queried = await cli_resize(cli, e2e_auth, box.id)
        assert queried == repeated

        for request in ({"cpus": 1}, {"memory_mib": 1024}):
            with pytest.raises(boxlite.BoxliteError):
                await box.resize(**request)
        unchanged = await box.resize()
        assert (unchanged.cpus, unchanged.memory_mib) == (2, 2048)
        assert (await guest_resources(box))[0] == before
    finally:
        await rt.remove(box.id, force=True)
