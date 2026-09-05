"""Shared bench harness: auth, HTTP helpers, stats, report schema.

All scenarios import from here. Auth follows the same pattern as
the E2E test suite (e2e_auth.py) — env vars or ~/.boxlite/credentials.toml.
"""
from __future__ import annotations

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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from e2e_auth import auth_context, E2EAuthContext

IMAGE = os.environ.get(
    "BOXLITE_E2E_IMAGE",
    "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3",
)


def ctx() -> E2EAuthContext:
    return auth_context()


def api(method: str, path: str, body=None, *, timeout: int = 60) -> tuple[int, dict | None]:
    c = ctx()
    headers = c.auth_headers(content_type=body is not None)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        c.url_for(c.v1(path)), method=method, headers=headers, data=data,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, {"_raw": raw.decode("utf-8", "replace")}


def create_box(image: str = IMAGE, **overrides) -> str:
    opts = {"image": image, "cpus": 1, "memory_mib": 256, "disk_size_gb": 4}
    opts.update(overrides)
    status, body = api("POST", "boxes", opts)
    if status not in (200, 201):
        raise RuntimeError(f"create_box failed: {status} {body}")
    return body["box_id"]


def delete_box(box_id: str):
    try:
        api("DELETE", f"boxes/{box_id}", timeout=15)
    except Exception:
        pass


def box_metrics(box_id: str) -> dict | None:
    try:
        status, body = api("GET", f"boxes/{box_id}/metrics", timeout=15)
        return body if status == 200 else None
    except Exception:
        return None


def stop_box(box_id: str, timeout: int = 30):
    status, body = api("POST", f"boxes/{box_id}/stop", timeout=timeout)
    if status >= 300:
        raise RuntimeError(f"stop_box failed: {status} {body}")
    return status, body


def start_box(box_id: str, timeout: int = 30):
    status, body = api("POST", f"boxes/{box_id}/start", timeout=timeout)
    if status >= 300:
        raise RuntimeError(f"start_box failed: {status} {body}")
    return status, body


def wait_box_status(box_id: str, target: str, timeout: int = 60, poll_interval: float = 1.0):
    """Poll until box reaches target status."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, body = api("GET", f"boxes/{box_id}", timeout=10)
        if status == 200 and body and body.get("status") == target:
            return
        time.sleep(poll_interval)
    raise RuntimeError(f"box {box_id} not '{target}' after {timeout}s")


def exec_command(box_id: str, command: str = "echo", args: list[str] | None = None, timeout: int = 30) -> tuple[int, dict | None]:
    payload = {"command": command}
    if args:
        payload["args"] = args
    status, body = api("POST", f"boxes/{box_id}/exec", payload, timeout=timeout)
    if status not in (200, 201):
        raise RuntimeError(f"exec failed: {status} {body}")
    return status, body


# ── Stats ──────────────────────────────────────────────────────────

def percentile(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * (p / 100.0)
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] * (c - k) + s[c] * (k - f)


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


def build_report(scenario: str, samples: list[dict], warmup: int, label: str | None = None) -> dict:
    active = [s for s in samples if not s.get("warmup", False)]
    metric_names: set[str] = set()
    for s in active:
        metric_names.update(s.get("metrics", {}).keys())

    aggregates = []
    for name in sorted(metric_names):
        values = [s["metrics"][name] for s in active if name in s.get("metrics", {})]
        if values:
            aggregates.append(aggregate(values, name))

    c = ctx()
    return {
        "schema_version": "1.0",
        "scenario": scenario,
        "metadata": {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "label": label or f"{c.url} ({IMAGE.split(':')[-1]})",
            "git_commit": git_commit(),
            "host": {
                "kernel": platform.platform(),
                "arch": platform.machine(),
                "target": c.url,
            },
        },
        "sample_count": len(active),
        "warmup_count": warmup,
        "samples": samples,
        "aggregates": aggregates,
    }


def print_aggregates(report: dict):
    print()
    print("=" * 70)
    print(f"Aggregates — {report['scenario']} ({report['sample_count']} samples)")
    print("=" * 70)
    for agg in report["aggregates"]:
        print(
            f"  {agg['name']:35s}  "
            f"p50={agg['p50']:8.1f}  "
            f"p90={agg['p90']:8.1f}  "
            f"p99={agg['p99']:8.1f}  "
            f"mean={agg['mean']:8.1f}  "
            f"stdev={agg['stdev']:7.1f}"
        )
