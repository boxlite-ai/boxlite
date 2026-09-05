"""Full lifecycle latency: create → exec → delete, wall clock per stage."""
from __future__ import annotations
import time
from bench.harness import api, create_box, delete_box, exec_command

SCENARIO = "latency-lifecycle"


def run_once(iteration: int) -> dict[str, float]:
    metrics: dict[str, float] = {}

    t0 = time.monotonic()
    bid = create_box()
    metrics["create_ms"] = (time.monotonic() - t0) * 1000

    try:
        time.sleep(2)

        t1 = time.monotonic()
        exec_command(bid, "echo", ["lifecycle-ok"])
        metrics["exec_ms"] = (time.monotonic() - t1) * 1000

        t2 = time.monotonic()
        api("DELETE", f"boxes/{bid}", timeout=30)
        metrics["delete_ms"] = (time.monotonic() - t2) * 1000

        metrics["total_lifecycle_ms"] = (
            metrics["create_ms"] + 2000 + metrics["exec_ms"] + metrics["delete_ms"]
        )
    except Exception:
        delete_box(bid)
        raise

    return metrics
