from __future__ import annotations

import re
from typing import Any

from .models import ValidationContext

SOURCE_LABEL_RE = re.compile(
    r"^(?P<action>.+?)<br/>"
    r"File: (?P<path>[^<]+)<br/>"
    r"Namespace: (?P<namespace>[^<]+)<br/>"
    r"Class: (?P<class_name>[^<]+)<br/>"
    r"Function: (?P<function>[^<]+)<br/>"
    r"LOC: L(?P<line_start>[1-9][0-9]*)-L(?P<line_end>[1-9][0-9]*)$"
)
SOURCE_FIELD_MARKERS = ("File:", "Namespace:", "Class:", "Function:", "LOC:")


def validate_sequence_source_labels(ctx: ValidationContext) -> None:
    if ctx.parsed is None:
        ctx.add("sequence.source_labels", "fail", "sequence labels require a parsed document")
        return

    errors: list[str] = []
    edge_map = ctx.item_map("edge")
    node_map = ctx.item_map("node")
    states = ctx.state_map()

    for (state_id, edge_id), label in ctx.parsed.sequence_edge_labels.items():
        edge = edge_map.get(edge_id)
        if edge is None:
            continue

        match = SOURCE_LABEL_RE.fullmatch(label)
        has_source_field = any(marker in label for marker in SOURCE_FIELD_MARKERS)
        state = states.get(state_id, {})
        requires_source_block = (
            edge.get("kind") == "call"
            and not edge.get("proposed", False)
            and not state.get("proposed", False)
        )

        if match is None:
            if requires_source_block or has_source_field:
                errors.append(
                    f"sequence/{state_id} edge {edge_id!r} must include complete "
                    "File, Namespace, Class, Function, and LOC fields"
                )
            continue

        target = node_map.get(edge.get("to"), {})
        candidates = [
            evidence
            for evidence in target.get("evidence", [])
            if evidence.get("type") == "source" and evidence.get("state") == state_id
        ]
        if not candidates:
            if requires_source_block:
                errors.append(
                    f"sequence/{state_id} edge {edge_id!r} has no target source evidence for its label"
                )
            continue

        if not any(_matches_evidence(match.groupdict(), evidence) for evidence in candidates):
            expected = [_source_label_description(evidence) for evidence in candidates]
            errors.append(
                f"sequence/{state_id} edge {edge_id!r} source fields do not match target "
                f"node:{edge.get('to')} evidence; expected one of {expected}"
            )

    if errors:
        ctx.add("sequence.source_labels", "fail", "sequence source labels are incomplete or stale", errors)
    else:
        ctx.add(
            "sequence.source_labels",
            "pass",
            "sequence call messages expose complete source fields matching target evidence",
        )


def _matches_evidence(fields: dict[str, str], evidence: dict[str, Any]) -> bool:
    namespace, class_name, function = _symbol_fields(evidence["symbol"])
    return (
        fields["path"] == evidence["path"]
        and fields["namespace"] == namespace
        and fields["class_name"] == class_name
        and fields["function"] == function
        and int(fields["line_start"]) == evidence["line_start"]
        and int(fields["line_end"]) == evidence["line_end"]
    )


def _source_label_description(evidence: dict[str, Any]) -> str:
    namespace, class_name, function = _symbol_fields(evidence["symbol"])
    return (
        f"File: {evidence['path']}; Namespace: {namespace}; Class: {class_name}; "
        f"Function: {function}; LOC: L{evidence['line_start']}-L{evidence['line_end']}"
    )


def _symbol_fields(symbol: str) -> tuple[str, str, str]:
    separator = "::" if "::" in symbol else "."
    parts = [part for part in symbol.split(separator) if part]
    if len(parts) == 1:
        return "—", "—", parts[0]
    if len(parts) == 2:
        return "—", parts[0], parts[1]
    return separator.join(parts[:-2]), parts[-2], parts[-1]
