from __future__ import annotations

import re
from collections import Counter

from .models import ParsedDocument, StateBlock, ValidationContext

VIEW_HEADINGS = {
    "Architecture": "architecture",
    "Sequence": "sequence",
    "Call graph": "call_graph",
}
VIEW_ORDER = ["architecture", "sequence", "call_graph"]
EXPECTED_LANGUAGES = {
    "architecture": "mermaid",
    "sequence": "mermaid",
    "call_graph": "text",
}

H2_RE = re.compile(r"^##\s+(.+?)\s*$")
H3_RE = re.compile(r"^###\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^```([A-Za-z0-9_-]*)\s*$")


def validate_document(ctx: ValidationContext) -> None:
    try:
        text = ctx.document_path.read_text(encoding="utf-8")
    except OSError as error:
        ctx.add("document.read", "fail", f"cannot read diagram document: {error}")
        return

    parsed = ParsedDocument(text=text)
    ctx.parsed = parsed
    states = ctx.manifest.get("states", [])
    state_by_label = {state.get("label"): state.get("id") for state in states}
    expected_pairs = {
        (view, state.get("id")) for view in VIEW_ORDER for state in states if state.get("id")
    }

    lines = text.splitlines()
    current_view: str | None = None
    current_state: str | None = None
    current_label: str | None = None
    view_order: list[str] = []
    view_counts: Counter[str] = Counter()
    fence: tuple[str, int, list[str]] | None = None
    seen_pairs: Counter[tuple[str, str]] = Counter()
    state_order_by_view: dict[str, list[str]] = {view: [] for view in VIEW_ORDER}
    errors: list[str] = []

    for line_number, line in enumerate(lines, start=1):
        if fence is not None:
            language, start_line, content = fence
            if line.rstrip() == "```":
                if current_view is None or current_state is None or current_label is None:
                    errors.append(f"line {start_line}: fenced block is outside a view/state section")
                else:
                    pair = (current_view, current_state)
                    seen_pairs[pair] += 1
                    if pair not in parsed.blocks:
                        parsed.blocks[pair] = StateBlock(
                            view=current_view,
                            state=current_state,
                            label=current_label,
                            language=language,
                            content="\n".join(content).strip("\n") + "\n",
                            start_line=start_line,
                        )
                fence = None
            else:
                content.append(line)
            continue

        fence_match = FENCE_RE.match(line)
        if fence_match:
            fence = (fence_match.group(1), line_number, [])
            continue

        h2_match = H2_RE.match(line)
        if h2_match:
            heading = h2_match.group(1)
            if heading not in VIEW_HEADINGS:
                errors.append(f"line {line_number}: unexpected level-two heading {heading!r}")
                current_view = None
                current_state = None
                current_label = None
                continue
            current_view = VIEW_HEADINGS[heading]
            current_state = None
            current_label = None
            view_counts[current_view] += 1
            view_order.append(current_view)
            continue

        h3_match = H3_RE.match(line)
        if h3_match and current_view is not None:
            label = h3_match.group(1)
            state_id = state_by_label.get(label)
            if state_id is None:
                errors.append(f"line {line_number}: unknown state heading {label!r}")
                current_state = None
                current_label = None
            else:
                current_state = state_id
                current_label = label
                state_order_by_view[current_view].append(state_id)

    if fence is not None:
        errors.append(f"line {fence[1]}: unterminated fenced block")

    if view_order != VIEW_ORDER:
        errors.append(f"view order must be {VIEW_ORDER}; found {view_order}")
    for view in VIEW_ORDER:
        if view_counts[view] != 1:
            errors.append(f"view {view!r} must occur exactly once; found {view_counts[view]}")
        expected_state_order = [state.get("id") for state in states if state.get("id")]
        if state_order_by_view[view] != expected_state_order:
            errors.append(
                f"view {view!r} state order must be {expected_state_order}; found {state_order_by_view[view]}"
            )
    for pair in sorted(expected_pairs):
        if seen_pairs[pair] != 1:
            errors.append(f"{pair[0]}/{pair[1]} must contain exactly one fenced block; found {seen_pairs[pair]}")
        block = parsed.blocks.get(pair)
        if block and block.language != EXPECTED_LANGUAGES[pair[0]]:
            errors.append(
                f"{pair[0]}/{pair[1]} must use a {EXPECTED_LANGUAGES[pair[0]]!r} fence; "
                f"found {block.language!r}"
            )

    unexpected = set(parsed.blocks) - expected_pairs
    for pair in sorted(unexpected):
        errors.append(f"unexpected view/state block {pair[0]}/{pair[1]}")

    if errors:
        ctx.add("document.structure", "fail", "diagram document structure is invalid", errors)
    else:
        ctx.add(
            "document.structure",
            "pass",
            "all required views and states have exactly one correctly typed block",
            [f"{view}/{state}" for view, state in sorted(expected_pairs)],
        )

    _validate_diagram_kinds(ctx)


def _validate_diagram_kinds(ctx: ValidationContext) -> None:
    if ctx.parsed is None:
        return
    errors: list[str] = []
    for (view, state), block in ctx.parsed.blocks.items():
        first = next((line.strip() for line in block.content.splitlines() if line.strip()), "")
        if view == "architecture" and not re.match(r"^(flowchart|graph)\s+(LR|RL|TB|TD|BT)\b", first):
            errors.append(f"architecture/{state} must begin with a directed flowchart or graph declaration")
        if view == "sequence" and first != "sequenceDiagram":
            errors.append(f"sequence/{state} must begin with 'sequenceDiagram'")
    if errors:
        ctx.add("document.diagram_kinds", "fail", "unsupported Mermaid diagram kind", errors)
    else:
        ctx.add("document.diagram_kinds", "pass", "architecture and sequence diagram kinds are supported")
