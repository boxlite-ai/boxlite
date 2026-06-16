#!/usr/bin/env python3
"""把 REST 测试产物聚合成一份 Markdown 中文报告。"""
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
        return ["- 静态覆盖盘点：缺失，请先运行 `make test:rest:inventory`"]

    rows = json.loads(path.read_text())
    total = len(rows)
    candidate = sum(1 for row in rows if row.get("status") == "candidate")
    missing = total - candidate
    lines = [
        f"- 静态覆盖盘点：{candidate}/{total} 个 operation 有候选覆盖，{missing} 个缺失",
        f"- 覆盖盘点 Markdown：`{rel(REPORT_DIR / 'rest-inventory.md')}`",
    ]
    if missing:
        missing_ops = [
            f"{row.get('method')} {row.get('path')} ({row.get('operationId')})"
            for row in rows
            if row.get("status") == "missing"
        ][:10]
        lines.append("- 前 10 个缺失候选覆盖的 operation：")
        lines.extend(f"  - {op}" for op in missing_ops)
    return lines


def cli_matrix_summary() -> list[str]:
    summaries = sorted(REPORT_DIR.glob("cli-matrix-*.md"))
    if not summaries:
        return ["- CLI 矩阵：缺失，请运行 `make test:rest:cli AUTH=<api-key|oidc>`"]

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
        lines.append(f"- CLI 矩阵 `{auth}`/`{scope}`：{status}（`{rel(summary)}`）")
    return lines


def artifact_summary() -> list[str]:
    if not REPORT_DIR.exists():
        return ["- 还没有产物目录"]
    files = sorted(
        path for path in REPORT_DIR.iterdir()
        if path.is_file() and path.name != OUT.name
    )
    if not files:
        return ["- 还没有产物"]
    return [f"- `{rel(path)}`" for path in files]


def main() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# REST API 测试报告",
        "",
        f"生成时间：`{generated}`",
        "",
        "## 摘要",
        "",
        *inventory_summary(),
        "",
        "## CLI 矩阵",
        "",
        *cli_matrix_summary(),
        "",
        "## REST E2E 认证矩阵",
        "",
        "- API-key E2E：`make test:rest:e2e AUTH=api-key`",
        "- OIDC E2E：`make test:rest:e2e AUTH=oidc`",
        "- OIDC 需要 `BOXLITE_E2E_OIDC_TOKEN`，或一个包含 access token 的 OIDC profile。",
        "",
        "## 产物",
        "",
        *artifact_summary(),
        "",
    ]
    OUT.write_text("\n".join(lines))
    print(OUT)


if __name__ == "__main__":
    main()
