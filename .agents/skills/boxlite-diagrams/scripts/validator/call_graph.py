from __future__ import annotations

import re

from .models import ValidationContext

HOP_RE = re.compile(
    r"^(?P<indent> +)(?:(?P<branch>[├└])─ )?"
    r"(?P<symbol>[^\s(]+) \((?P<type>[^·()]+?) · (?P<path>[^:()]+):(?P<line>[1-9][0-9]*)\) — (?P<role>.+)$"
)
MARKER_RE = re.compile(
    r"(?:^|\s)(?:(?P<arrow>←)\s*)?(?P<kind>ISSUE|BUG|FIX|PROPOSED|ADDED|CHANGED|REMOVED):\s*"
    r"(?P<text>.+?)(?=$|\s+←\s*[A-Z]+:)"
)


def validate_call_graph(ctx: ValidationContext) -> None:
    if ctx.parsed is None:
        ctx.add("call_graph.structure", "fail", "call graph cannot be checked until the document is parsed")
        return
    errors: list[str] = []
    for state in ctx.state_map():
        block = ctx.parsed.blocks.get(("call_graph", state))
        if block is None:
            continue
        stack: dict[int, str] = {}
        hop_count = 0
        for offset, line in enumerate(block.content.splitlines(), start=0):
            if not line.strip():
                continue
            match = HOP_RE.match(line)
            if not match:
                errors.append(
                    f"call_graph/{state} line {block.start_line + offset + 1} must match "
                    "symbol (Type · path/file.ext:line) — role"
                )
                continue
            hop_count += 1
            indent = len(match.group("indent"))
            if indent < 2 or indent % 2:
                errors.append(f"call_graph/{state} line {block.start_line + offset + 1} has invalid indentation")
                continue
            depth = indent // 2 - 1
            branch = match.group("branch")
            if depth == 0 and branch:
                errors.append(f"call_graph/{state} root hop must not use a tree branch")
            if depth > 0 and not branch:
                errors.append(f"call_graph/{state} child hop requires ├─ or └─")
            if depth > 0 and depth - 1 not in stack:
                errors.append(f"call_graph/{state} hop skips a parent depth")

            item_id = _match_node(ctx, state, match.groupdict(), errors)
            if item_id is None:
                continue
            key = (state, item_id)
            if key in ctx.parsed.call_graph_nodes:
                errors.append(f"call_graph/{state} duplicates node {item_id!r}")
            ctx.parsed.call_graph_nodes[key] = {
                "symbol": match.group("symbol"),
                "type": match.group("type").strip(),
                "path": match.group("path"),
                "line": int(match.group("line")),
                "role": match.group("role"),
                "raw": line,
            }
            if depth > 0 and depth - 1 in stack:
                parent = stack[depth - 1]
                edge_id = _match_edge(ctx, state, parent, item_id, errors)
                if edge_id:
                    edge_key = (state, edge_id)
                    if edge_key in ctx.parsed.call_graph_edges:
                        errors.append(f"call_graph/{state} duplicates relationship {edge_id!r}")
                    ctx.parsed.call_graph_edges[edge_key] = (parent, item_id)
            stack[depth] = item_id
            for old_depth in [value for value in stack if value > depth]:
                del stack[old_depth]
        if hop_count == 0:
            errors.append(f"call_graph/{state} must contain at least one actual hop line")

    _validate_markers(ctx, errors)
    if errors:
        ctx.add("call_graph.structure", "fail", "ASCII call graph structure or evidence is invalid", errors)
    else:
        ctx.add("call_graph.structure", "pass", "all call-graph hops and relationships map to source evidence")


def _match_node(
    ctx: ValidationContext, state: str, hop: dict[str, str | None], errors: list[str]
) -> str | None:
    line = int(hop["line"] or 0)
    candidates: list[str] = []
    for node in ctx.manifest.get("nodes", []):
        if state not in node.get("states", []) or "call_graph" not in node.get("views", []):
            continue
        for evidence in node.get("evidence", []):
            if evidence.get("type") != "source" or evidence.get("state") != state:
                continue
            if evidence.get("path") != hop["path"] or not evidence["line_start"] <= line <= evidence["line_end"]:
                continue
            if _leaf(evidence["symbol"]) == _leaf(hop["symbol"] or ""):
                candidates.append(node["id"])
                break
    if len(candidates) != 1:
        errors.append(
            f"call_graph/{state} hop {hop['symbol']} ({hop['path']}:{line}) maps to {len(candidates)} manifest nodes"
        )
        return None
    return candidates[0]


def _match_edge(
    ctx: ValidationContext, state: str, source: str, target: str, errors: list[str]
) -> str | None:
    candidates = [
        edge["id"] for edge in ctx.manifest.get("edges", [])
        if state in edge.get("states", [])
        and "call_graph" in edge.get("views", [])
        and edge.get("from") == source
        and edge.get("to") == target
    ]
    if len(candidates) != 1:
        errors.append(
            f"call_graph/{state} relationship {source}->{target} maps to {len(candidates)} manifest edges"
        )
        return None
    return candidates[0]


def _validate_markers(ctx: ValidationContext, errors: list[str]) -> None:
    annotations = ctx.manifest.get("annotations", [])
    expected = {(value["kind"], value["target"], value["state"]): value["text"] for value in annotations}
    seen: set[tuple[str, str, str]] = set()
    node_lookup = {(state, item_id): value for (state, item_id), value in ctx.parsed.call_graph_nodes.items()}
    child_edges = {
        (state, target): edge_id
        for (state, edge_id), (_source, target) in ctx.parsed.call_graph_edges.items()
    }
    for (state, item_id), hop in node_lookup.items():
        for marker in MARKER_RE.finditer(hop["role"]):
            kind = marker.group("kind")
            if kind == "BUG" and marker.group("arrow") is None:
                errors.append(f"call_graph/{state} BUG marker on node:{item_id} must use '← BUG:'")
            node_key = (kind, f"node:{item_id}", state)
            edge_id = child_edges.get((state, item_id))
            edge_key = (kind, f"edge:{edge_id}", state) if edge_id else None
            key = node_key if node_key in expected else edge_key
            if key is None or key not in expected:
                errors.append(f"call_graph/{state} has undeclared marker {kind} on node:{item_id}")
            elif expected[key] not in marker.group("text"):
                errors.append(f"call_graph/{state} marker text disagrees for node:{item_id}")
            else:
                seen.add(key)
    for key, text in expected.items():
        kind, target, state = key
        item_type, item_id = target.split(":", 1)
        if "call_graph" not in ctx.item_map(item_type).get(item_id, {}).get("views", []):
            continue
        if item_type == "node" and key not in seen:
            errors.append(f"call_graph/{state} is missing {kind}: {text} on {target}")
        if kind == "BUG" and item_type != "edge":
            errors.append("BUG must target the faulty call-graph edge, not a node or prose")
        if item_type == "edge":
            endpoints = ctx.parsed.call_graph_edges.get((state, item_id))
            if endpoints is None:
                continue
            child = node_lookup.get((state, endpoints[1]))
            if child is None:
                continue
            matches = list(MARKER_RE.finditer(child["role"]))
            if not any(match.group("kind") == kind and text in match.group("text") for match in matches):
                errors.append(f"call_graph/{state} is missing {kind}: {text} on child hop for {target}")
            else:
                seen.add(key)


def _leaf(symbol: str) -> str:
    return re.split(r"::|\.", symbol)[-1].strip("<> ")
