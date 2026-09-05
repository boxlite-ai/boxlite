"""Restart latency: stop a running box and start it again, measure restart wall time."""
from __future__ import annotations
import time
from bench.harness import create_box, delete_box, exec_command, stop_box, start_box, wait_box_status

SCENARIO = "latency-restart"


def run_once(iteration: int) -> dict[str, float]:
    bid = create_box()
    try:
        time.sleep(2)
        exec_command(bid, "echo", ["pre-stop"])

        t0 = time.monotonic()
        stop_box(bid)
        wait_box_status(bid, "stopped", timeout=30)
        stop_wall = (time.monotonic() - t0) * 1000

        t1 = time.monotonic()
        start_box(bid)
        wait_box_status(bid, "running", timeout=30)
        start_wall = (time.monotonic() - t1) * 1000

        t2 = time.monotonic()
        exec_command(bid, "echo", ["post-restart"])
        first_exec_wall = (time.monotonic() - t2) * 1000

        return {
            "stop_wall_ms": stop_wall,
            "start_wall_ms": start_wall,
            "first_exec_after_restart_ms": first_exec_wall,
            "total_restart_ms": stop_wall + start_wall + first_exec_wall,
        }
    finally:
        delete_box(bid)
