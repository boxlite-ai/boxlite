"""Parallel exec throughput: fire N execs concurrently on one box."""
from __future__ import annotations
import concurrent.futures
import time
from bench.harness import create_box, delete_box, exec_command

SCENARIO = "throughput-exec-parallel"
CONCURRENCY = 10


def _do_exec(bid: str, idx: int) -> float:
    t = time.monotonic()
    exec_command(bid, "echo", [f"par-{idx}"])
    return (time.monotonic() - t) * 1000


def run_once(iteration: int) -> dict[str, float]:
    bid = create_box()
    try:
        time.sleep(2)
        exec_command(bid, "echo", ["warmup"])

        t0 = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futs = [pool.submit(_do_exec, bid, i) for i in range(CONCURRENCY)]
            per_exec = [f.result() for f in concurrent.futures.as_completed(futs)]
        wall = (time.monotonic() - t0) * 1000

        return {
            "batch_wall_ms": wall,
            "concurrency": float(CONCURRENCY),
            "per_exec_mean_ms": sum(per_exec) / len(per_exec),
            "per_exec_max_ms": max(per_exec),
        }
    finally:
        delete_box(bid)
