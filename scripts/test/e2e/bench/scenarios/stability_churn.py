"""Stability churn: N create+exec+delete cycles, track per-cycle latency drift."""
from __future__ import annotations
import time
from bench.harness import create_box, delete_box, exec_command

SCENARIO = "stability-churn"
CYCLES = 10


def run_once(iteration: int) -> dict[str, float]:
    cycle_times = []
    for i in range(CYCLES):
        t0 = time.monotonic()
        bid = create_box()
        try:
            time.sleep(2)
            exec_command(bid, "echo", [f"churn-{i}"])
        finally:
            delete_box(bid)
        cycle_times.append((time.monotonic() - t0) * 1000)

    return {
        "total_wall_ms": sum(cycle_times),
        "cycles": float(CYCLES),
        "first_cycle_ms": cycle_times[0],
        "last_cycle_ms": cycle_times[-1],
        "mean_cycle_ms": sum(cycle_times) / len(cycle_times),
        "max_cycle_ms": max(cycle_times),
        "drift_ms": cycle_times[-1] - cycle_times[0],
    }
