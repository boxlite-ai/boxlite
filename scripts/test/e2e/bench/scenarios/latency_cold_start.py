"""Cold-start latency: POST /boxes wall clock + runner-reported create_duration_ms.

Per iteration: create box → fetch metrics → first exec → delete.
"""
from __future__ import annotations
import time
from bench.harness import api, create_box, delete_box, box_metrics, exec_command

SCENARIO = "latency-cold-start"


def run_once(iteration: int) -> dict[str, float]:
    metrics: dict[str, float] = {}

    t0 = time.monotonic()
    bid = create_box()
    metrics["api_create_wall_ms"] = (time.monotonic() - t0) * 1000

    try:
        time.sleep(2)
        rm = box_metrics(bid)
        if rm:
            if rm.get("create_duration_ms") is not None:
                metrics["runner_create_ms"] = float(rm["create_duration_ms"])
            if rm.get("boot_duration_ms") is not None:
                metrics["runner_boot_ms"] = float(rm["boot_duration_ms"])

        t1 = time.monotonic()
        exec_command(bid, "echo", ["ready"])
        metrics["first_exec_wall_ms"] = (time.monotonic() - t1) * 1000

        if "first_exec_wall_ms" in metrics:
            metrics["total_ready_wall_ms"] = (
                metrics["api_create_wall_ms"] + 2000 + metrics["first_exec_wall_ms"]
            )
    finally:
        delete_box(bid)

    return metrics
