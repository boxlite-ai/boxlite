from __future__ import annotations

import re
import subprocess
from collections import defaultdict
from typing import Any

from .models import ValidationContext

CHANGE_CONTEXTS = {"pr", "commit", "branch", "working-tree-change"}
DIFF_KINDS = {"ADDED", "CHANGED", "REMOVED"}
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def validate_changes(ctx: ValidationContext) -> None:
    if any(check.name == "manifest.shape" and check.status == "fail" for check in ctx.checks):
        ctx.add("changes.alignment", "fail", "change alignment cannot be checked until the manifest is valid")
        return
    errors: list[str] = []
    context = ctx.manifest["context"]
    states = ctx.manifest["states"]
    labels = [state["label"] for state in states]
    kind = context["kind"]
    if kind == "overview" and labels != ["Current"]:
        errors.append("overview context requires exactly the Current state")
    elif kind == "issue" and labels != ["Current", "Expected (proposed)"]:
        errors.append("issue context requires Current and Expected (proposed) states")
    elif kind in CHANGE_CONTEXTS and labels != ["Before", "After"]:
        errors.append(f"{kind} context requires complete Before and After states")
    if kind in CHANGE_CONTEXTS and len(states) == 2:
        sources = context["sources"]
        if states[0]["revision"] != sources.get("base_revision"):
            errors.append("Before state revision must equal context.sources.base_revision")
        if states[1]["revision"] != sources.get("head_revision"):
            errors.append("After state revision must equal context.sources.head_revision")

    annotations = ctx.manifest["annotations"]
    state_by_id = ctx.state_map()
    for annotation in annotations:
        label = state_by_id[annotation["state"]]["label"]
        annotation_kind = annotation["kind"]
        if annotation_kind == "BUG" and label not in {"Before", "Current"}:
            errors.append("BUG is allowed only in Before or Current")
        if annotation_kind == "FIX" and label not in {"After", "Expected (proposed)"}:
            errors.append("FIX is allowed only in After or Expected (proposed)")
        if annotation_kind == "REMOVED" and label != "Before":
            errors.append("REMOVED must target Before")
        if annotation_kind in {"ADDED", "CHANGED"} and label != "After":
            errors.append(f"{annotation_kind} must target After")
        if annotation_kind in DIFF_KINDS and kind not in CHANGE_CONTEXTS:
            errors.append(f"{annotation_kind} requires a PR, commit, branch, or working-tree change context")

    if context["change_kind"] == "bug" and kind == "pr":
        issue_number = context["sources"].get("issue")
        if not isinstance(issue_number, int):
            errors.append("bug-fix PR requires context.sources.issue")
        elif ctx.parsed and not re.search(rf"(?im)^Fixes\s+#{issue_number}\s*$", ctx.parsed.text):
            errors.append(f"bug-fix PR document requires a standalone 'Fixes #{issue_number}' line")

    diff_annotations = [annotation for annotation in annotations if annotation["kind"] in DIFF_KINDS]
    if diff_annotations:
        diff = _load_diff(ctx, errors)
        if diff is not None:
            for annotation in diff_annotations:
                _validate_annotation_hunk(ctx, annotation, diff, errors)

    if errors:
        ctx.add("changes.alignment", "fail", "state or diff annotations are invalid", errors)
    else:
        ctx.add("changes.alignment", "pass", "state labels and change annotations align with their evidence")


def _load_diff(ctx: ValidationContext, errors: list[str]) -> dict[str, dict[str, list[tuple[int, int]]]] | None:
    sources = ctx.manifest["context"]["sources"]
    base = sources.get("base_revision")
    head = sources.get("head_revision")
    if not isinstance(base, str) or not isinstance(head, str):
        errors.append("diff annotations require context.sources.base_revision and head_revision")
        return None
    command = ["git", "diff", "--unified=0", "--no-ext-diff", base]
    if head != "WORKTREE":
        command.append(head)
    result = subprocess.run(command, cwd=ctx.repo, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        errors.append(f"cannot resolve diff {base}..{head}: {result.stderr.strip()}")
        return None
    return _parse_diff(result.stdout)


def _parse_diff(text: str) -> dict[str, dict[str, list[tuple[int, int]]]]:
    ranges: dict[str, dict[str, list[tuple[int, int]]]] = defaultdict(lambda: {"before": [], "after": []})
    path: str | None = None
    for line in text.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
            continue
        if line.startswith("--- a/") and path is None:
            path = line[6:]
            continue
        match = HUNK_RE.match(line)
        if not match or path is None:
            continue
        old_start, old_count, new_start, new_count = (int(value) if value else None for value in match.groups())
        old_count = 1 if old_count is None else old_count
        new_count = 1 if new_count is None else new_count
        if old_count:
            ranges[path]["before"].append((old_start, old_start + old_count - 1))
        if new_count:
            ranges[path]["after"].append((new_start, new_start + new_count - 1))
    return ranges


def _validate_annotation_hunk(
    ctx: ValidationContext,
    annotation: dict[str, Any],
    diff: dict[str, dict[str, list[tuple[int, int]]]],
    errors: list[str],
) -> None:
    item_type, item_id = annotation["target"].split(":", 1)
    item = ctx.item_map(item_type).get(item_id)
    if item is None:
        return
    state_id = annotation["state"]
    side = "before" if annotation["kind"] == "REMOVED" else "after"
    evidence = [
        value for value in item["evidence"]
        if value["type"] == "source" and value["state"] == state_id
    ]
    if not evidence:
        errors.append(f"{annotation['kind']} target {annotation['target']} lacks source evidence")
        return
    if not any(
        _intersects(value["line_start"], value["line_end"], start, end)
        for value in evidence
        for start, end in diff.get(value["path"], {}).get(side, [])
    ):
        errors.append(
            f"{annotation['kind']} target {annotation['target']} does not intersect a {side} diff hunk"
        )
    if annotation["kind"] == "CHANGED":
        before_states = [
            state["id"] for state in ctx.manifest["states"] if state["label"] == "Before"
        ]
        before_evidence = [
            value for value in item["evidence"]
            if value["type"] == "source" and value["state"] in before_states
        ]
        if not before_evidence or not any(
            _intersects(value["line_start"], value["line_end"], start, end)
            for value in before_evidence
            for start, end in diff.get(value["path"], {}).get("before", [])
        ):
            errors.append(f"CHANGED target {annotation['target']} must also intersect a Before diff hunk")


def _intersects(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start <= right_end and right_start <= left_end
