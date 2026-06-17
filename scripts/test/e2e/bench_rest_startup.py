#!/usr/bin/env python3
"""REST API startup-time benchmark.

Measures box creation latency through the full REST path
(client → API → runner → VM) by:

  1. POST /v1/boxes  — wall-clock from client side
  2. GET /v1/boxes/:id/metrics — runner-reported create_duration_ms
     and boot_duration_ms (when available)
  3. exec "echo ok" — first-exec latency after boot

Runs N iterations, computes p50/p90/p99/mean/stdev, and emits a
JSON report compatible with the bench harness schema (PR #592).

Usage:
    .venv/bin/python3 scripts/test/e2e/bench_rest_startup.py [--runs N] [--warmup M]

Requires BOXLITE_E2E_API_URL + BOXLITE_E2E_API_KEY env vars or
a configured ~/.boxlite/credentials.toml profile.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "lib"))
from e2e_auth import auth_context

IMAGE = os.environ.get(
    "BOXLITE_E2E_IMAGE",
    "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
)


def api_request(ctx, method: str, path: str, body=None, timeout: int = 60):
    headers = ctx.auth_headers(content_type=body is not None)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        ctx.url_for(ctx.v1(path)), method=method, headers=headers, data=data,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read() or "null")


def run_one(ctx, iteration: int) -> dict[str, float]:
    metrics: dict[str, float] = {}

    # 1. Create box (wall clock)
    t0 = time.monotonic()
    _, body = api_request(ctx, "POST", "boxes", {
        "image": IMAGE, "cpus": 1, "memory_mib": 256, "disk_size_gb": 4,
    })
    t_create = time.monotonic() - t0
    bid = body["box_id"]
    metrics["api_create_wall_ms"] = t_create * 1000

    try:
        # 2. Wait briefly then fetch runner metrics
        time.sleep(2)
        try:
            _, runner_m = api_request(ctx, "GET", f"boxes/{bid}/metrics", timeout=15)
            if runner_m:
                if runner_m.get("create_duration_ms"):
                    metrics["runner_create_ms"] = float(runner_m["create_duration_ms"])
                if runner_m.get("boot_duration_ms"):
                    metrics["runner_boot_ms"] = float(runner_m["boot_duration_ms"])
        except Exception:
            pass

        # 3. First exec latency
        t1 = time.monotonic()
        try:
            _, exec_body = api_request(ctx, "POST", f"boxes/{bid}/exec", {
                "command": "echo", "args": ["bench-ok"],
            }, timeout=30)
            t_exec = time.monotonic() - t1
            metrics["first_exec_wall_ms"] = t_exec * 1000
        except Exception:
            pass

        # Total: create + first exec ready
        if "first_exec_wall_ms" in metrics:
            metrics["total_ready_wall_ms"] = metrics["api_create_wall_ms"] + 2000 + metrics["first_exec_wall_ms"]

    finally:
        try:
            api_request(ctx, "DELETE", f"boxes/{bid}", timeout=15)
        except Exception:
            pass

    return metrics


def percentile(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    sorted_data = sorted(data)
    k = (len(sorted_data) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_data[int(k)]
    return sorted_data[f] * (c - k) + sorted_data[c] * (k - f)


def aggregate(values: list[float], name: str, unit: str = "ms") -> dict:
    higher = name.endswith("_per_sec") or name.endswith("_rps")
    return {
        "name": name,
        "unit": unit,
        "higher_is_better": higher,
        "min": min(values),
        "p50": percentile(values, 50),
        "p90": percentile(values, 90),
        "p99": percentile(values, 99),
        "max": max(values),
        "mean": statistics.mean(values),
        "stdev": statistics.stdev(values) if len(values) > 1 else 0.0,
        "n": len(values),
    }


def git_commit() -> str:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def build_report(samples: list[dict], warmup: int) -> dict:
    active = [s for s in samples if not s.get("warmup", False)]

    metric_names: set[str] = set()
    for s in active:
        metric_names.update(s["metrics"].keys())

    aggregates = []
    for name in sorted(metric_names):
        values = [s["metrics"][name] for s in active if name in s["metrics"]]
        if values:
            aggregates.append(aggregate(values, name))

    return {
        "schema_version": "1.0",
        "scenario": "rest-api-cold-start",
        "metadata": {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "label": f"dev.boxlite.ai ({IMAGE.split(':')[-1]})",
            "git_commit": git_commit(),
            "host": {
                "kernel": platform.platform(),
                "arch": platform.machine(),
                "target": "dev.boxlite.ai (remote REST API)",
            },
        },
        "sample_count": len(active),
        "warmup_count": warmup,
        "samples": samples,
        "aggregates": aggregates,
    }


def main():
    parser = argparse.ArgumentParser(description="REST API startup benchmark")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--out", type=str, default=None)
    args = parser.parse_args()

    ctx = auth_context()
    print(f"Target: {ctx.url}")
    print(f"Image:  {IMAGE}")
    print(f"Runs:   {args.runs} (warmup: {args.warmup})")
    print()

    samples = []
    for i in range(1, args.runs + 1):
        is_warmup = i <= args.warmup
        tag = " (warmup)" if is_warmup else ""
        try:
            m = run_one(ctx, i)
            wall = m.get("api_create_wall_ms", 0)
            runner_create = m.get("runner_create_ms", 0)
            first_exec = m.get("first_exec_wall_ms", 0)
            print(
                f"  [{i:2d}/{args.runs}]{tag}  "
                f"api_wall={wall:.0f}ms  "
                f"runner_create={runner_create:.0f}ms  "
                f"first_exec={first_exec:.0f}ms"
            )
            samples.append({
                "iteration": i,
                "warmup": is_warmup,
                "wall_ms": wall,
                "metrics": m,
            })
        except Exception as e:
            print(f"  [{i:2d}/{args.runs}]{tag}  ERROR: {e}")
            samples.append({
                "iteration": i,
                "warmup": is_warmup,
                "wall_ms": 0,
                "metrics": {},
                "error": str(e),
            })

    report = build_report(samples, args.warmup)

    print()
    print("=" * 60)
    print("Aggregates (excluding warmup):")
    print("=" * 60)
    for agg in report["aggregates"]:
        print(
            f"  {agg['name']:30s}  "
            f"p50={agg['p50']:8.1f}  "
            f"p90={agg['p90']:8.1f}  "
            f"p99={agg['p99']:8.1f}  "
            f"mean={agg['mean']:8.1f}  "
            f"stdev={agg['stdev']:7.1f}  "
            f"n={agg['n']}"
        )

    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))
        print(f"\nReport written to {args.out}")
    else:
        print(f"\n{json.dumps(report, indent=2)}")


if __name__ == "__main__":
    main()
