"""Exec latency on a warm box: N serial execs, measure per-exec wall time.

Creates one box, warms up, then runs N execs and records each.
"""
from __future__ import annotations
import time
from bench.harness import create_box, delete_box, exec_command

SCENARIO = "latency-exec"


def run_once(iteration: int) -> dict[str, float]:
    bid = create_box()
    try:
        time.sleep(2)
        # warm exec
        exec_command(bid, "echo", ["warmup"])

        t0 = time.monotonic()
        exec_command(bid, "echo", ["bench"])
        wall = (time.monotonic() - t0) * 1000

        return {"exec_wall_ms": wall}
    finally:
        delete_box(bid)
