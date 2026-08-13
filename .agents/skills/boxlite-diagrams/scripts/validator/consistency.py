from __future__ import annotations

from .models import ValidationContext

VIEWS = ("architecture", "sequence", "call_graph")


def validate_consistency(ctx: ValidationContext) -> None:
    if ctx.parsed is None:
        ctx.add("consistency.cross_view", "fail", "cross-view consistency requires a parsed document")
        return
    errors: list[str] = []
    for state in ctx.state_map():
        for view in VIEWS:
            expected_nodes = {
                item["id"] for item in ctx.manifest.get("nodes", [])
                if state in item.get("states", []) and view in item.get("views", [])
            }
            expected_edges = {
                item["id"] for item in ctx.manifest.get("edges", [])
                if state in item.get("states", []) and view in item.get("views", [])
            }
            actual_nodes = _actual_node_ids(ctx, view, state)
            actual_edges = _actual_edge_ids(ctx, view, state)
            if actual_nodes != expected_nodes:
                errors.append(
                    f"{view}/{state} nodes disagree: missing={sorted(expected_nodes - actual_nodes)}, "
                    f"undeclared={sorted(actual_nodes - expected_nodes)}"
                )
            if actual_edges != expected_edges:
                errors.append(
                    f"{view}/{state} edges disagree: missing={sorted(expected_edges - actual_edges)}, "
                    f"undeclared={sorted(actual_edges - expected_edges)}"
                )
            _check_endpoints(ctx, view, state, errors)
            _check_labels(ctx, view, state, errors)
    _check_mermaid_annotations(ctx, errors)
    if errors:
        ctx.add("consistency.cross_view", "fail", "diagram views disagree with the evidence manifest", errors)
    else:
        ctx.add("consistency.cross_view", "pass", "canonical nodes and edges agree across all declared views")


def _actual_node_ids(ctx: ValidationContext, view: str, state: str) -> set[str]:
    values = {
        "architecture": ctx.parsed.architecture_nodes,
        "sequence": ctx.parsed.sequence_nodes,
        "call_graph": ctx.parsed.call_graph_nodes,
    }[view]
    return {item_id for (item_state, item_id) in values if item_state == state}


def _actual_edge_ids(ctx: ValidationContext, view: str, state: str) -> set[str]:
    values = {
        "architecture": ctx.parsed.architecture_edges,
        "sequence": ctx.parsed.sequence_edges,
        "call_graph": ctx.parsed.call_graph_edges,
    }[view]
    return {item_id for (item_state, item_id) in values if item_state == state}


def _check_endpoints(ctx: ValidationContext, view: str, state: str, errors: list[str]) -> None:
    actual = {
        "architecture": ctx.parsed.architecture_edges,
        "sequence": ctx.parsed.sequence_edges,
        "call_graph": ctx.parsed.call_graph_edges,
    }[view]
    manifest_edges = ctx.item_map("edge")
    for (item_state, edge_id), endpoints in actual.items():
        if item_state != state or edge_id not in manifest_edges:
            continue
        edge = manifest_edges[edge_id]
        if endpoints != (edge["from"], edge["to"]):
            errors.append(f"{view}/{state} edge {edge_id!r} endpoints {endpoints} disagree with manifest")


def _check_labels(ctx: ValidationContext, view: str, state: str, errors: list[str]) -> None:
    if view == "call_graph":
        return
    node_labels = ctx.parsed.architecture_nodes if view == "architecture" else ctx.parsed.sequence_nodes
    edge_labels = ctx.parsed.architecture_edge_labels if view == "architecture" else ctx.parsed.sequence_edge_labels
    for (item_state, item_id), label in node_labels.items():
        if item_state == state and item_id in ctx.item_map("node"):
            expected = ctx.item_map("node")[item_id]["label"]
            if expected.lower() not in label.lower():
                errors.append(f"{view}/{state} node {item_id!r} label does not contain {expected!r}")
    for (item_state, item_id), label in edge_labels.items():
        if item_state == state and item_id in ctx.item_map("edge"):
            expected = ctx.item_map("edge")[item_id]["label"]
            if expected.lower() not in label.lower():
                errors.append(f"{view}/{state} edge {item_id!r} label does not contain {expected!r}")


def _check_mermaid_annotations(ctx: ValidationContext, errors: list[str]) -> None:
    for annotation in ctx.manifest.get("annotations", []):
        item_type, item_id = annotation["target"].split(":", 1)
        item = ctx.item_map(item_type).get(item_id, {})
        marker = f"{annotation['kind']}: {annotation['text']}".lower()
        for view in ("architecture", "sequence"):
            if view not in item.get("views", []):
                continue
            labels = _labels_for(ctx, view, item_type)
            label = labels.get((annotation["state"], item_id), "")
            if marker not in label.lower():
                errors.append(
                    f"{view}/{annotation['state']} is missing {annotation['kind']}: "
                    f"{annotation['text']} on {annotation['target']}"
                )


def _labels_for(ctx: ValidationContext, view: str, item_type: str) -> dict[tuple[str, str], str]:
    if view == "architecture":
        return ctx.parsed.architecture_nodes if item_type == "node" else ctx.parsed.architecture_edge_labels
    return ctx.parsed.sequence_nodes if item_type == "node" else ctx.parsed.sequence_edge_labels
