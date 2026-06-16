#!/usr/bin/env python3
"""Aggregate REST test artifacts into one Markdown report."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path


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


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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
        "## REST E2E Auth Matrix",
        "",
        "- API-key E2E: `make test:rest:e2e AUTH=api-key`",
        "- OIDC E2E: `make test:rest:e2e AUTH=oidc`",
        "- OIDC requires `BOXLITE_E2E_OIDC_TOKEN` or an OIDC profile with an access token.",
        "",
        "## Artifacts",
        "",
        *artifact_summary(),
        "",
    ]
    OUT.write_text("\n".join(lines))
    print(OUT)


if __name__ == "__main__":
    main()
