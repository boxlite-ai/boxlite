"""Stability exec loop: many execs on one long-lived box, check for degradation."""
from __future__ import annotations
import time
from bench.harness import create_box, delete_box, exec_command

SCENARIO = "stability-exec-loop"
EXEC_COUNT = 50


def run_once(iteration: int) -> dict[str, float]:
    bid = create_box()
    try:
        time.sleep(2)
        exec_command(bid, "echo", ["warmup"])

        times = []
        for i in range(EXEC_COUNT):
            t = time.monotonic()
            exec_command(bid, "echo", [f"loop-{i}"])
            times.append((time.monotonic() - t) * 1000)

        first_10 = sum(times[:10]) / 10
        last_10 = sum(times[-10:]) / 10

        return {
            "total_wall_ms": sum(times),
            "exec_count": float(EXEC_COUNT),
            "mean_exec_ms": sum(times) / len(times),
            "max_exec_ms": max(times),
            "first_10_mean_ms": first_10,
            "last_10_mean_ms": last_10,
            "degradation_ms": last_10 - first_10,
        }
    finally:
        delete_box(bid)
