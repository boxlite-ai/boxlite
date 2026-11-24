"""Guest deadlines end native output streams across SDK consumers."""

import asyncio

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def collect_native_output(execution):
    async def collect(stream):
        return "".join([line async for line in stream])

    stdout, stderr, status = await asyncio.gather(
        collect(execution.stdout()), collect(execution.stderr()), execution.wait()
    )
    return stdout, stderr, status


async def test_guest_cutoff_ends_native_streams_with_escaped_descendant(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        execution = await box._box.exec(
            "sh",
            args=[
                "-c",
                (
                    'setsid sh -c \'trap "" TERM; echo $$ > /tmp/cutoff-child.pid; '
                    "echo started; echo error-started >&2; sleep 30' &"
                ),
            ],
            timeout_secs=1,
        )
        try:
            stdout, stderr, status = await asyncio.wait_for(
                collect_native_output(execution), timeout=7
            )
        except asyncio.TimeoutError:
            pytest.fail("Guest native output still waits for an escaped descendant")
        assert stdout == "started\n"
        assert stderr == "error-started\n"
        assert status.exit_code == 0
        probe = await box.exec(
            "sh", "-c", 'grep "^State:" /proc/$(cat /tmp/cutoff-child.pid)/status'
        )
        assert probe.exit_code == 0
        assert "\tZ" not in probe.stdout, (
            "the test must exercise cutoff with a live writer"
        )


@pytest.mark.parametrize("timeout", [None, 0])
async def test_native_output_without_deadline_waits_for_complete_data(
    shared_runtime, timeout
):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        execution = await box._box.exec(
            "sh",
            args=["-c", "sleep 1; echo complete; echo error-complete >&2"],
            timeout_secs=timeout,
        )
        stdout, stderr, status = await asyncio.wait_for(
            collect_native_output(execution), timeout=7
        )
        assert stdout == "complete\n"
        assert stderr == "error-complete\n"
        assert status.exit_code == 0
