"""Timed commands must clean up descendants and return collected output."""

import asyncio

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


@pytest.mark.parametrize(
    "command",
    [
        "sleep 30 & echo $!",
        """sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait""",
    ],
    ids=["leader-exits", "descendant-ignores-sigterm"],
)
async def test_timed_exec_terminates_descendants(shared_runtime, command):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        try:
            result = await asyncio.wait_for(
                box.exec("sh", "-c", command, timeout=1),
                timeout=8,
            )
        except asyncio.TimeoutError:
            pytest.fail("timed exec did not return while a descendant held its output")
        descendant = int(result.stdout.strip())
        probe = await box.exec(
            "sh",
            "-c",
            'if test -r "/proc/$1/status"; then grep "^State:" "/proc/$1/status"; fi',
            "probe",
            str(descendant),
        )
        assert probe.exit_code == 0
        assert not probe.stdout or "\tZ" in probe.stdout, (
            f"timed execution left descendant {descendant} alive: {probe.stdout}"
        )
