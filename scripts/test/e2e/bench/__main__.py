#!/usr/bin/env python3
"""REST API benchmark runner.

Usage:
    python -m bench list
    python -m bench run <scenario> [--runs N] [--warmup M] [--out PATH]
    python -m bench run all [--runs N] [--warmup M] [--out-dir DIR]
    python -m bench compare <baseline.json> <current.json> [--on p99] [--threshold 0.20]

Requires: BOXLITE_E2E_API_URL + BOXLITE_E2E_API_KEY env vars,
or a configured ~/.boxlite/credentials.toml profile.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from bench.harness import build_report, print_aggregates, ctx
from bench.scenarios import latency_cold_start
from bench.scenarios import latency_exec
from bench.scenarios import latency_lifecycle
from bench.scenarios import latency_restart
from bench.scenarios import throughput_exec_serial
from bench.scenarios import throughput_exec_parallel
from bench.scenarios import density_parallel_create
from bench.scenarios import stability_churn
from bench.scenarios import stability_exec_loop

SCENARIOS = {
    latency_cold_start.SCENARIO: latency_cold_start,
    latency_exec.SCENARIO: latency_exec,
    latency_lifecycle.SCENARIO: latency_lifecycle,
    latency_restart.SCENARIO: latency_restart,
    throughput_exec_serial.SCENARIO: throughput_exec_serial,
    throughput_exec_parallel.SCENARIO: throughput_exec_parallel,
    density_parallel_create.SCENARIO: density_parallel_create,
    stability_churn.SCENARIO: stability_churn,
    stability_exec_loop.SCENARIO: stability_exec_loop,
}


def cmd_list():
    print("Available scenarios:\n")
    for name in sorted(SCENARIOS):
        mod = SCENARIOS[name]
        doc = (mod.__doc__ or "").strip().split("\n")[0]
        print(f"  {name:35s}  {doc}")
    print()


def run_scenario(name: str, runs: int, warmup: int) -> dict:
    mod = SCENARIOS[name]
    print(f"Scenario: {name}")
    print(f"Runs: {runs} (warmup: {warmup})")
    print()

    samples = []
    for i in range(1, runs + 1):
        is_warmup = i <= warmup
        tag = " (warmup)" if is_warmup else ""
        try:
            m = mod.run_once(i)
            headline = "  ".join(f"{k}={v:.0f}" for k, v in list(m.items())[:4])
            print(f"  [{i:2d}/{runs}]{tag}  {headline}")
            samples.append({
                "iteration": i,
                "warmup": is_warmup,
                "wall_ms": m.get(list(m.keys())[0], 0) if m else 0,
                "metrics": m,
            })
        except Exception as e:
            print(f"  [{i:2d}/{runs}]{tag}  ERROR: {e}")
            samples.append({
                "iteration": i,
                "warmup": is_warmup,
                "wall_ms": 0,
                "metrics": {},
                "error": str(e),
            })

    return build_report(name, samples, warmup)


def cmd_run(args):
    c = ctx()
    print(f"Target: {c.url}\n")

    if args.scenario == "all":
        reports = {}
        for name in sorted(SCENARIOS):
            report = run_scenario(name, args.runs, args.warmup)
            print_aggregates(report)
            print()
            if args.out_dir:
                out = Path(args.out_dir) / f"{name}.json"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(json.dumps(report, indent=2))
                print(f"  → {out}")
            reports[name] = report
        return reports

    if args.scenario not in SCENARIOS:
        print(f"Unknown scenario: {args.scenario}")
        print(f"Available: {', '.join(sorted(SCENARIOS))}")
        sys.exit(1)

    report = run_scenario(args.scenario, args.runs, args.warmup)
    print_aggregates(report)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2))
        print(f"\nReport: {args.out}")
    else:
        print(f"\n{json.dumps(report, indent=2)}")

    return report


def cmd_compare(args):
    baseline = json.loads(Path(args.baseline).read_text())
    current = json.loads(Path(args.current).read_text())

    if baseline["schema_version"] != current["schema_version"]:
        print(f"Schema mismatch: {baseline['schema_version']} vs {current['schema_version']}")
        sys.exit(1)
    if baseline["scenario"] != current["scenario"]:
        print(f"Scenario mismatch: {baseline['scenario']} vs {current['scenario']}")
        sys.exit(1)

    field = args.on
    threshold = args.threshold
    regressions = []

    base_aggs = {a["name"]: a for a in baseline["aggregates"]}
    curr_aggs = {a["name"]: a for a in current["aggregates"]}

    print(f"Comparing {baseline['scenario']}: {field}, threshold={threshold:.0%}")
    print(f"  Baseline: {baseline['metadata'].get('label', '?')} ({baseline['sample_count']} samples)")
    print(f"  Current:  {current['metadata'].get('label', '?')} ({current['sample_count']} samples)")
    print()

    all_names = sorted(set(base_aggs) | set(curr_aggs))
    compared = 0
    for name in all_names:
        ba = base_aggs.get(name)
        ca = curr_aggs.get(name)
        if not ba or not ca:
            status = "NEW" if ca else "REMOVED"
            print(f"  {name:35s}  {status}")
            continue

        if field not in ba or field not in ca:
            print(f"  {name:35s}  SKIP: missing '{field}'")
            continue
        bv = float(ba[field])
        cv = float(ca[field])
        compared += 1
        higher = ba.get("higher_is_better", False)

        if bv == 0:
            ratio = 0.0
        elif higher:
            ratio = (bv - cv) / bv
        else:
            ratio = (cv - bv) / bv

        regressed = ratio > threshold
        marker = " ← REGRESSION" if regressed else ""
        direction = "→" if cv == bv else ("↑" if cv > bv else "↓")
        print(f"  {name:35s}  {bv:10.1f} → {cv:10.1f}  {direction} {ratio:+.1%}{marker}")
        if regressed:
            regressions.append(name)

    if compared == 0:
        print(f"\nERROR: no metrics compared — check that '{field}' exists in both reports")
        sys.exit(1)

    if regressions:
        print(f"\nFAIL: {len(regressions)} regression(s) exceed {threshold:.0%} threshold")
        sys.exit(1)
    else:
        print("\nPASS: no regressions")


def main():
    parser = argparse.ArgumentParser(description="BoxLite REST API benchmark")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list", help="List available scenarios")

    run_p = sub.add_parser("run", help="Run a scenario")
    run_p.add_argument("scenario", help="Scenario name, or 'all'")
    run_p.add_argument("--runs", type=int, default=5)
    run_p.add_argument("--warmup", type=int, default=1)
    run_p.add_argument("--out", type=str, default=None)
    run_p.add_argument("--out-dir", type=str, default=None)

    cmp_p = sub.add_parser("compare", help="Compare two reports")
    cmp_p.add_argument("baseline")
    cmp_p.add_argument("current")
    cmp_p.add_argument("--on", default="p99")
    cmp_p.add_argument("--threshold", type=float, default=0.20)

    args = parser.parse_args()
    if args.command == "list":
        cmd_list()
    elif args.command == "run":
        cmd_run(args)
    elif args.command == "compare":
        cmd_compare(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
