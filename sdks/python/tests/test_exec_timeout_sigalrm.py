"""Regression test for exec timeout bypass via SIGALRM.

``box.exec(timeout=N)`` must terminate any process whose runtime exceeds N,
including one that installs ``signal.signal(SIGALRM, SIG_IGN)``. The guest's
timeout watcher must use SIGKILL (signal 9, uncatchable). If it sends SIGALRM
(signal 14, catchable/ignorable) the workload absorbs the signal, runs to
completion, and ``ExecResult.exit_code`` comes back as 0 — the deadline is
bypassed.

The Python SDK does NOT raise ``boxlite.TimeoutError`` on exec timeout; it
returns an ``ExecResult`` whose ``exit_code`` reflects how the process died
(non-zero / signal). The PoC at ``boxlite_poc/poc_sigalrm_bypass.py``
confirms this: it inspects ``exit_code`` and elapsed wall-time, never an
exception.

Requirements:
  - make dev:python  (build the Python SDK with native extension)
  - VM runtime for integration tests (libkrun + Hypervisor.framework)
"""

from __future__ import annotations

import time

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]

# Workload: install SIG_IGN for SIGALRM, then sleep WORKLOAD_S seconds.
# If the timeout watcher fires SIGALRM, the workload absorbs it and the
# loop completes (exit_code=0). If it fires SIGKILL, the process dies
# mid-loop (exit_code != 0, elapsed ~ TIMEOUT_S).
IGNORE_SIGALRM = """
import sys, time, signal
seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 8
signal.signal(signal.SIGALRM, signal.SIG_IGN)
for _ in range(seconds):
    time.sleep(1)
"""

TIMEOUT_S = 3.0
WORKLOAD_S = 8


async def test_exec_timeout_kills_sigalrm_ignoring_process():
    """A workload that ignores SIGALRM must still be killed at the timeout.

    Two-pronged assertion — both must hold:

    1) ``exit_code != 0`` — the workload must NOT have completed normally.
       With the SIGALRM bug, SIG_IGN absorbs the timeout signal, the loop
       finishes, and Python exits cleanly with 0.

    2) ``elapsed < TIMEOUT_S + 2.0`` — termination must happen near the
       configured deadline, not at the workload's natural end. Even if
       ``exit_code`` happens to be non-zero for some other reason, a long
       elapsed time means the watcher did not fire promptly.

    Fix is in ``src/guest/src/service/exec/timeout.rs``: send ``SIGKILL``
    (uncatchable) rather than ``SIGALRM``.
    """
    async with boxlite.SimpleBox(image="python:3-alpine") as box:
        t0 = time.time()
        result = await box.exec(
            "python3",
            "-c",
            IGNORE_SIGALRM,
            str(WORKLOAD_S),
            timeout=TIMEOUT_S,
        )
        elapsed = time.time() - t0

        assert result.exit_code != 0, (
            f"exec returned exit_code=0 after {elapsed:.2f}s — the {WORKLOAD_S}s "
            f"workload completed normally despite timeout={TIMEOUT_S}s. The "
            f"guest's timeout watcher is sending a catchable signal that the "
            f"workload absorbs via SIG_IGN; the kill must use SIGKILL."
        )
        assert elapsed < TIMEOUT_S + 2.0, (
            f"exec returned after {elapsed:.2f}s with exit_code={result.exit_code} "
            f"— expected termination near {TIMEOUT_S}s. The timeout watcher "
            f"is not killing the process promptly."
        )
