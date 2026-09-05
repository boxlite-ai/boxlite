"""Serial exec throughput: run N execs on one box, report execs/sec."""
from __future__ import annotations
import time
from bench.harness import create_box, delete_box, exec_command

SCENARIO = "throughput-exec-serial"
EXEC_COUNT = 20


def run_once(iteration: int) -> dict[str, float]:
    bid = create_box()
    try:
        time.sleep(2)
        exec_command(bid, "echo", ["warmup"])

        t0 = time.monotonic()
        for i in range(EXEC_COUNT):
            exec_command(bid, "echo", [f"iter-{i}"])
        elapsed = time.monotonic() - t0

        return {
            "total_wall_ms": elapsed * 1000,
            "exec_count": float(EXEC_COUNT),
            "execs_per_sec": EXEC_COUNT / elapsed if elapsed > 0 else 0,
            "avg_exec_ms": (elapsed * 1000) / EXEC_COUNT,
        }
    finally:
        delete_box(bid)
