#!/usr/bin/env python3
"""release-plan CLI — dry-run all pre-apply gates and print a verdict.

Read-only: never mutates anything. In CI the evidence flags are produced by
`sst diff` / a DB query / a DNS list; locally pass fixture files for a dry-run.

    python3 scripts/release/release_plan.py \
        --manifest release.yaml \
        --sst-diff /tmp/sst.diff \
        --migrations /tmp/migrations.json --baseline /tmp/baseline.json

Exit 0 if can_apply, 1 if blocked, 2 on bad usage.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cicd import manifest as m  # noqa: E402
from cicd.release_plan import plan  # noqa: E402


def _read_text(p):
    return Path(p).read_text() if p else ""


def _read_json(p):
    return json.loads(Path(p).read_text()) if p else None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Dry-run release pre-apply gates")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--artifact-manifest")
    ap.add_argument("--sst-diff", help="file containing `sst diff` output")
    ap.add_argument("--migrations", help="json list of migrations in the DB")
    ap.add_argument("--baseline", help="json list of expected baseline migrations")
    ap.add_argument("--dns-planned", help="json list of {fqdn} records to create")
    ap.add_argument("--dns-owned", help="json map fqdn->stage of existing ownership")
    ap.add_argument("--stage")
    ap.add_argument("--allow-infra-change", action="store_true")
    ap.add_argument("--out", help="write plan-report.json here")
    args = ap.parse_args(argv[1:])

    report = plan(
        m.load(args.manifest),
        artifact_manifest_data=_read_json(args.artifact_manifest),
        sst_diff_text=_read_text(args.sst_diff),
        migrations_in_db=_read_json(args.migrations),
        expected_baseline=_read_json(args.baseline),
        planned_dns=_read_json(args.dns_planned),
        owned_dns=_read_json(args.dns_owned),
        stage=args.stage,
        allow_infra_change=args.allow_infra_change,
    )

    print(f"trains:    {', '.join(report['trains']) or '(none)'}")
    print(f"can_apply: {report['can_apply']}")
    for w in report["warnings"]:
        print(f"  ⚠️  {w}")
    for b in report["blocked_by"]:
        print(f"  ⛔ {b}")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False))

    return 0 if report["can_apply"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
