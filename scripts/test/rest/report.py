#!/usr/bin/env python3
"""Aggregate REST test artifacts into one Markdown report."""
from __future__ import annotations

from datetime import datetime, timezone
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


REPO = Path(__file__).resolve().parents[3]
REPORT_DIR = REPO / "target" / "rest-test-report"
OUT = REPORT_DIR / "rest-report.md"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def inventory_summary() -> list[str]:
    path = REPORT_DIR / "rest-inventory.json"
    if not path.exists():
        return ["- Static coverage inventory: missing; run `make test:rest:inventory` first"]

    rows = json.loads(path.read_text())
    total = len(rows)
    candidate = sum(1 for row in rows if row.get("status") == "candidate")
    unsupported = sum(1 for row in rows if row.get("status") == "unsupported")
    missing = sum(1 for row in rows if row.get("status") == "missing")
    active = total - unsupported
    lines = [
        f"- Static coverage inventory: {total} spec operations; {active} active REST operations",
        f"- Candidate coverage: {candidate}/{active} active operations have candidate coverage; {missing} active operations are missing candidates",
        f"- Non-current cloud REST surface: {unsupported} operations marked unsupported / stale spec",
        f"- Coverage inventory Markdown: `{rel(REPORT_DIR / 'rest-inventory.md')}`",
    ]
    if missing:
        missing_ops = [
            f"{row.get('method')} {row.get('path')} ({row.get('operationId')})"
            for row in rows
            if row.get("status") == "missing"
        ][:10]
        lines.append("- Active operations missing candidate coverage:")
        lines.extend(f"  - {op}" for op in missing_ops)
    return lines


def cli_matrix_summary() -> list[str]:
    summaries = sorted(REPORT_DIR.glob("cli-matrix-*.md"))
    if not summaries:
        return ["- CLI matrix: missing; run `make test:rest:cli AUTH=<api-key|oidc>`"]

    lines = []
    for summary in summaries:
        status = "unknown"
        auth = "unknown"
        scope = "unknown"
        for line in summary.read_text().splitlines():
            if line.startswith("- status:"):
                status = line.split("`", 2)[1]
            elif line.startswith("- auth:"):
                auth = line.split("`", 2)[1]
            elif line.startswith("- scope:"):
                scope = line.split("`", 2)[1]
        lines.append(f"- CLI matrix `{auth}`/`{scope}`: {status} (`{rel(summary)}`)")
    return lines


def artifact_summary() -> list[str]:
    if not REPORT_DIR.exists():
        return ["- Artifact directory does not exist yet"]
    files = sorted(
        path for path in REPORT_DIR.iterdir()
        if path.is_file() and path.name != OUT.name
    )
    if not files:
        return ["- No artifacts yet"]
    return [f"- `{rel(path)}`" for path in files]


def read_jsonl(path: Path, problems: list[str]) -> list[dict]:
    rows = []
    try:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("expected an object")
                if path.name == "cases.jsonl":
                    kind = row.get("type")
                    if kind in ("collection", "deselected"):
                        if not isinstance(row.get("nodeids"), list) or not all(isinstance(item, str) for item in row["nodeids"]):
                            raise ValueError("nodeids must be a list of strings")
                    elif kind == "report":
                        if not isinstance(row.get("nodeid"), str) or row.get("when") not in ("setup", "call", "teardown") or row.get("outcome") not in ("passed", "failed", "skipped"):
                            raise ValueError("invalid pytest phase report")
                        if not isinstance(row.get("duration"), (int, float)) or row["duration"] < 0:
                            raise ValueError("invalid pytest duration")
                    elif kind not in ("sessionfinish", "collection_error"):
                        raise ValueError("unknown event type")
                rows.append(row)
            except (ValueError, TypeError) as exc:
                problems.append(f"{path.name}:{number}: {exc}")
    except (OSError, UnicodeError) as exc:
        problems.append(f"{path.name}: {exc}")
    return rows


def case_outcome(reports: list[dict]) -> str:
    if any(row.get("outcome") == "failed" and row.get("when") != "call" for row in reports):
        return "error"
    call = next((row for row in reports if row.get("when") == "call"), None)
    if call and call.get("outcome") == "failed":
        return "xpass" if call.get("wasxfail") is not None or call.get("strict_xpass") else "failed"
    skipped = next((row for row in reports if row.get("outcome") == "skipped"), None)
    if skipped:
        return "xfail" if skipped.get("wasxfail") is not None else "skip"
    if call and call.get("outcome") == "passed":
        return "xpass" if call.get("wasxfail") is not None else "passed"
    return "incomplete"


def junit_identity(nodeid: str) -> tuple[str, str]:
    # Match pytest.junitxml.mangle_test_address without splitting parameter IDs.
    path, bracket, parameters = nodeid.partition("[")
    names = path.split("::")
    names[0] = names[0].replace("/", ".").removesuffix(".py")
    names[-1] += bracket + parameters
    return ".".join(names[:-1]), names[-1]


def junit_results(reports: list[dict]) -> list[tuple[str, ...]]:
    results = []
    current = []
    call_failed = any(row["when"] == "call" and row["outcome"] == "failed" for row in reports)
    for row in reports:
        if row["outcome"] == "failed":
            if row["when"] == "teardown" and call_failed:
                # pytest emits a second testcase for call failure + teardown error.
                results.append(tuple(sorted(current)))
                current = []
            if row["when"] != "call":
                current.append("error")
            else:
                current.append("skip" if row.get("wasxfail") is not None else "failure")
        elif row["outcome"] == "skipped":
            current.append("xfail" if row.get("wasxfail") is not None else "skip")
    results.append(tuple(sorted(current)))
    return results


def summarize_run(directory: Path) -> tuple[list[str], bool]:
    problems: list[str] = []
    try:
        metadata = json.loads((directory / "run.json").read_text())
        if not isinstance(metadata, dict):
            raise ValueError("expected an object")
    except (OSError, ValueError, UnicodeError) as exc:
        metadata = {}
        problems.append(f"run.json: {exc}")
    if not metadata.get("complete") or metadata.get("ended_at") is None:
        problems.append("operation did not complete")
    if metadata.get("command") in ("doctor", "setup", "up", "down", "status", "exec", "report"):
        timings = read_jsonl(directory / "timings.jsonl", problems)
        lines = [f"# E2E operation {directory.name}", "", "- Scope: environment operation; no suite coverage claimed",
                 f"- Evidence: {'incomplete' if problems else 'complete'}"]
        lines.extend(f"- {key}: `{metadata.get(key, 'unknown')}`" for key in ("command", "started_at", "ended_at", "exit_code"))
        lines.extend(f"- {row.get('stage', '?')}: {row.get('elapsed_ms', '?')} ms; status={row.get('status', '?')}; cache_hit={row.get('cache_hit', '?')}" for row in timings)
        lines.extend(f"- {problem}" for problem in problems)
        (directory / "summary.md").write_text("\n".join(lines) + "\n")
        return lines, bool(problems)
    events = read_jsonl(directory / "cases.jsonl", problems)
    timings = read_jsonl(directory / "timings.jsonl", problems)
    if not any(row.get("type") == "sessionfinish" for row in events):
        problems.append("pytest sessionfinish is missing")
    if any(row.get("type") == "sessionfinish" and row.get("exitstatus") in (2, 3, 4) for row in events):
        problems.append("pytest session was interrupted or encountered an internal/usage error")
    if any(row.get("type") == "collection_error" for row in events):
        problems.append("pytest collection failed")
    try:
        root = ET.parse(directory / "junit.xml").getroot()
        if root.tag not in ("testsuite", "testsuites"):
            raise ValueError(f"unexpected root {root.tag}")
        xml_cases = list(root.iter("testcase"))
        if any(int(suite.get("errors", "0")) for suite in root.iter("testsuite")):
            # Setup/teardown errors are complete results; collection errors are not.
            if any(case.get("name") in ("", "collection") for case in xml_cases):
                problems.append("JUnit records a collection error")
    except (OSError, ET.ParseError, ValueError) as exc:
        xml_cases = []
        problems.append(f"junit.xml: {exc}")
    collected = [nodeid for row in events if row.get("type") == "collection" for nodeid in row.get("nodeids", [])]
    deselected = [nodeid for row in events if row.get("type") == "deselected" for nodeid in row.get("nodeids", [])]
    reports: dict[str, list[dict]] = {nodeid: [] for nodeid in collected}
    for row in events:
        if row.get("type") == "report" and isinstance(row.get("nodeid"), str):
            reports.setdefault(row["nodeid"], []).append(row)
    counts = {"E2E": Counter(), "Offline harness": Counter()}
    details = []
    for nodeid, phases in reports.items():
        outcome = case_outcome(phases)
        phases_by_name = {row["when"]: row for row in phases}
        required = {"setup", "teardown"}
        if phases_by_name.get("setup", {}).get("outcome") == "passed":
            required.add("call")
        for phase in sorted(required - phases_by_name.keys()):
            problems.append(f"missing {phase} phase: {nodeid}")
        if outcome == "incomplete":
            problems.append(f"incomplete outcome: {nodeid}")
        group = "Offline harness" if "test_harness_guards.py::" in nodeid else "E2E"
        counts[group][outcome] += 1
        duration = sum(float(row.get("duration", 0)) for row in phases)
        details.append(f"| `{nodeid}` | {group} | {outcome} | {duration:.3f} |")
    if not any(row.get("type") == "collection" for row in events):
        problems.append("pytest collection inventory is missing")
    # Compare each item's result types, including pytest's two records for a
    # failed call followed by a teardown error. Counters preserve duplicate IDs.
    expected_xml = Counter()
    for nodeid, phases in reports.items():
        if phases:
            identity = junit_identity(nodeid)
            expected_xml.update((identity, result) for result in junit_results(phases))
    actual_xml = Counter()
    for case in xml_cases:
        result = []
        for child in case:
            if child.tag in ("failure", "error"):
                result.append(child.tag)
            elif child.tag == "skipped":
                result.append("xfail" if child.get("type") == "pytest.xfail" else "skip")
        actual_xml[((case.get("classname", ""), case.get("name", "")), tuple(sorted(result)))] += 1
    if actual_xml != expected_xml:
        problems.append("JUnit testcase identities or result types differ from pytest item evidence")
    lines = [f"# E2E run {directory.name}", "", f"- Evidence: {'incomplete' if problems else 'complete'}"]
    for key in ("command", "auth", "selector", "source_sha", "started_at", "ended_at", "exit_code"):
        lines.append(f"- {key}: `{metadata.get(key, 'unknown')}`")
    lines.extend([f"- Deselected: {len(deselected)}", "", "## Outcomes", ""])
    lines.append(f"- Not run: {sum(not phases for phases in reports.values())}")
    labels = ("passed", "failed", "error", "skip", "xfail", "xpass", "incomplete")
    lines.extend(f"- {group}: " + ", ".join(f"{label}={counter[label]}" for label in labels) for group, counter in counts.items())
    if problems:
        lines.extend(["", "## Incomplete evidence", "", *[f"- {problem}" for problem in dict.fromkeys(problems)]])
    lines.extend(["", "## Stage timings", "", "| Stage | Elapsed ms | Status | Cache hit |", "| --- | ---: | --- | --- |"])
    lines.extend(f"| {row.get('stage', '?')} | {row.get('elapsed_ms', '?')} | {row.get('status', '?')} | {row.get('cache_hit', '?')} |" for row in timings)
    try:
        wall = (datetime.fromisoformat(metadata["ended_at"].replace("Z", "+00:00")) - datetime.fromisoformat(metadata["started_at"].replace("Z", "+00:00"))).total_seconds()
        lines.append(f"\n- Wall total: {wall:.3f} seconds")
    except (KeyError, TypeError, ValueError, AttributeError):
        lines.append("\n- Wall total: unavailable")
    phase_ms = sum(row["elapsed_ms"] for row in timings if isinstance(row.get("elapsed_ms"), (int, float)))
    lines.append(f"- Recorded phase sum: {phase_ms:.3f} ms (overlapping stages are not wall time)")
    lines.extend(["", "## Cases", "", "| Node ID | Scope | Outcome | Seconds (all phases) |", "| --- | --- | --- | ---: |", *details, ""])
    (directory / "summary.md").write_text("\n".join(lines))
    return lines, bool(problems)


def run_summary(state_dir: Path) -> tuple[list[str], int]:
    directories = sorted(path for path in (state_dir / "runs").glob("*") if path.is_dir())
    if not directories:
        return ["- No recorded E2E runs; no execution coverage claimed."], 0
    lines = []
    incomplete_runs = 0
    for directory in directories:
        _, incomplete = summarize_run(directory)
        incomplete_runs += int(incomplete)
        print(directory / "summary.md")
        lines.append(f"- `{directory.name}`: {'incomplete' if incomplete else 'complete'} evidence — `{rel(directory / 'summary.md')}`")
    return lines, incomplete_runs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path(os.environ.get("BOXLITE_E2E_STATE_DIR", REPO / "target" / "e2e")))
    parser.add_argument("--allow-incomplete", action="store_true",
                        help="report incomplete evidence without failing")
    args = parser.parse_args()
    state_dir = args.state_dir if args.state_dir.is_absolute() else REPO / args.state_dir
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    runs, incomplete = run_summary(state_dir)
    lines = [
        "# REST API Test Report",
        "",
        f"Generated at: `{generated}`",
        "",
        "## Summary",
        "",
        *inventory_summary(),
        "",
        "## CLI Matrix",
        "",
        *cli_matrix_summary(),
        "",
        "## Recorded E2E Runs",
        "",
        *runs,
        "",
        "## Artifacts",
        "",
        *artifact_summary(),
        "",
    ]
    OUT.write_text("\n".join(lines))
    print(OUT)
    if incomplete and not args.allow_incomplete:
        print(f"{incomplete} recorded run(s) have incomplete evidence; "
              "inspect them or pass --allow-incomplete", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
