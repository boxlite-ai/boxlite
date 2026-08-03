"""P0-6 — regression test for the exec-stdout drop race.

Original issue (2026-06-02 MVP cohort): a short command's stdout is
silently dropped on the REST attach path. Symptom: exit 0 with empty
stdout for `cat /etc/os-release` on alpine.

Root cause is at the runner FFI layer (see #563): C SDK pushes the Wait
/ Exit event before draining stream pumps, so stdout frames that land
after Wait are racing against the SDK's terminal-event handling — which
returns immediately. SDK never sees them.

The fix is in `sdks/c/src/exec/execution.rs` (drain barrier on
`streams_pending`). This test will FAIL against a stock 0.9.5 runner
and PASS against a runner rebuilt with #563 applied.

Loss-rate threshold (`MAX_LOSS_RATE`) is set deliberately tight so a
regression on either side of the race window deterministically trips it.
Stock 0.9.5: ~90% loss. With fix: 0% loss.
"""
from __future__ import annotations

import asyncio
import os

import boxlite
import pytest
import pytest_asyncio

from conftest import drain, stdout_line_count

ROUNDS = int(os.environ.get("BOXLITE_E2E_P06_ROUNDS", "5"))
MAX_LOSS_RATE = float(os.environ.get("BOXLITE_E2E_P06_MAX_LOSS", "0.05"))


async def _run_one(box, cmd: str, args: list[str]) -> int:
    ex = await box.exec(cmd, args, None)
    out, _ = await drain(ex)
    await asyncio.wait_for(ex.wait(), timeout=60)
    return stdout_line_count(out)


@pytest.mark.asyncio
async def test_short_command_stdout_not_dropped(rt, image):
    """ROUNDS new boxes × 2 execs each (direct cat + shell cat); count
    execs that returned 0 stdout lines and assert below MAX_LOSS_RATE.

    The two slots (direct vs shell) are kept from the original repro
    because empirically both slots can lose, not just the first."""
    losses = 0
    execs = 0
    histogram: dict[int, int] = {}

    for _ in range(ROUNDS):
        box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
        try:
            s1 = await _run_one(box, "cat", ["/etc/os-release"])
            s2 = await _run_one(box, "sh", ["-c", "cat /etc/os-release"])
        finally:
            try:
                await rt.remove(box.id, force=True)
            except Exception:
                pass

        for slot in (s1, s2):
            execs += 1
            histogram[slot] = histogram.get(slot, 0) + 1
            if slot == 0:
                losses += 1

    loss_rate = losses / execs if execs else 1.0
    print(f"\nP0-6: execs={execs} losses={losses} "
          f"rate={loss_rate:.1%} histogram={dict(sorted(histogram.items()))}")
    assert loss_rate <= MAX_LOSS_RATE, (
        f"stdout silently dropped on {losses}/{execs} execs (rate={loss_rate:.1%}); "
        f"this is the #563 regression — see PR for the FFI drain-barrier fix"
    )
