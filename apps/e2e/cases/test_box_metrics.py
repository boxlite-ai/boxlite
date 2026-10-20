"""Per-box metrics over REST.

Ported from E2B's cloud metrics test
(`packages/python-sdk/tests/async/sandbox_async/test_metrics.py:9-28`), which polls
`sbx.get_metrics()` until the platform has produced a sample and then asserts
the sample's fields. BoxLite's equivalent is `box.metrics()`, proxied straight
to the runner (apps/api/src/boxlite-rest/boxlite-proxy.controller.ts:201).

The counters are the part worth asserting: `commands_executed_total` is
produced inside the runner, so a value that tracks the execs this test ran is
proof the whole chain — client → API → runner → guest → back — is wired, not
just that the endpoint answers.
"""
from __future__ import annotations

import asyncio

import pytest

from conftest import drain
from e2e_auth import auth_context, request_json


EXEC_COUNT = 3


@pytest.mark.asyncio
@pytest.mark.smoke
async def test_box_metrics_count_the_execs_that_ran(box):
    for i in range(EXEC_COUNT):
        ex = await box.exec("sh", ["-c", f"echo metric-probe-{i}"], None)
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0, f"probe exec {i} failed: {rc.exit_code}"
        assert f"metric-probe-{i}" in out, f"probe exec {i} lost stdout: {out!r}"

    # The runner counts on its own clock, so give it a few samples' grace
    # rather than asserting on the first read.
    executed = -1
    for _ in range(20):
        metrics = await box.metrics()
        executed = metrics.commands_executed_total
        if executed >= EXEC_COUNT:
            break
        await asyncio.sleep(0.5)

    assert executed >= EXEC_COUNT, (
        f"box reported {executed} commands executed after {EXEC_COUNT} execs"
    )
    assert metrics.exec_errors_total == 0, (
        f"successful execs recorded as errors: {metrics.exec_errors_total}"
    )
    for name in ("memory_bytes", "cpu_percent"):
        value = getattr(metrics, name)
        assert value is None or value >= 0, f"{name} reported as {value!r}"


@pytest.mark.asyncio
async def test_metrics_for_unknown_box_is_not_found():
    # Same bogus id shape as test_error_code_mapping.py:134 — the lookup, not
    # the id syntax, is what must produce the 404.
    bogus_id = "00000000-0000-0000-0000-000000000000"
    status, body = request_json("GET", auth_context().v1(f"boxes/{bogus_id}/metrics"))
    assert status == 404, f"metrics on an unknown box returned {status}: {body}"
