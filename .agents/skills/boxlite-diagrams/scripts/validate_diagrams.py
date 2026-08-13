#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from validator.call_graph import validate_call_graph
from validator.changes import validate_changes
from validator.consistency import validate_consistency
from validator.document import validate_document
from validator.mermaid import validate_mermaid
from validator.models import ValidationContext
from validator.source import validate_manifest, validate_source_evidence


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate source-grounded BoxLite diagrams")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--document", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo = args.repo.resolve()
    try:
        manifest = json.loads(args.evidence.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        report = {
            "valid": False,
            "exit_code": 1,
            "summary": {"pass": 0, "fail": 1, "error": 0},
            "checks": [{"name": "manifest.read", "status": "fail", "message": str(error), "evidence": []}],
            "artifacts": [],
        }
        _write_report(args.report, report)
        return 1
    ctx = ValidationContext(
        repo=repo,
        document_path=args.document.resolve(),
        evidence_path=args.evidence.resolve(),
        report_path=args.report.resolve(),
        manifest=manifest,
    )
    validate_manifest(ctx)
    validate_document(ctx)
    validate_source_evidence(ctx)
    validate_mermaid(ctx)
    validate_call_graph(ctx)
    validate_changes(ctx)
    validate_consistency(ctx)
    exit_code = 2 if ctx.has_tool_errors else (1 if ctx.has_failures else 0)
    summary = {status: sum(check.status == status for check in ctx.checks) for status in ("pass", "fail", "error")}
    report = {
        "valid": exit_code == 0,
        "exit_code": exit_code,
        "summary": summary,
        "checks": [check.to_dict() for check in ctx.checks],
        "artifacts": [str(path) for path in ctx.artifacts],
    }
    _write_report(args.report, report)
    return exit_code


def _write_report(path: Path, report: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    sys.exit(main())
