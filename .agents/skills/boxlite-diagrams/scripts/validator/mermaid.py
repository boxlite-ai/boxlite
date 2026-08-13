from __future__ import annotations

import html
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from .models import StateBlock, ValidationContext

VERSION = "11.16.0"
UNSAFE_PATTERNS = [
    (re.compile(r"%%\{"), "initialization directives"),
    (re.compile(r"(?im)^\s*click\s+"), "click directives"),
    (re.compile(r"(?i)javascript\s*:"), "javascript URLs"),
    (re.compile(r"(?i)https?://|\bhref\s*="), "external links"),
    (re.compile(r"<\s*/?\s*[A-Za-z][^>]*>"), "raw HTML"),
]
NODE_RE = re.compile(r'^\s*([a-z][a-z0-9_]*)\s*(?:\[\[|\[\(|\[|\(\(|\(|\{\{\{|\{\{|\{|>)\s*["\']?(.+?)["\']?\s*(?:\]\]|\)\]|\]|\)\)|\)|\}\}\}|\}\}|\}|\])\s*$')
EDGE_RE = re.compile(
    r'^\s*([a-z][a-z0-9_]*)\s+([a-z][a-z0-9_]*)@(?:-->|---|-.->|==>|--o|--x|o--o|x--x|<-->|<-.->|<==>)'
    r'(?:\|["\']?([^|]+?)["\']?\|)?\s*([a-z][a-z0-9_]*)\s*$'
)
PARTICIPANT_RE = re.compile(r"^\s*(?:participant|actor)\s+([a-z][a-z0-9_]*)\s+as\s+(.+?)\s*$")
EDGE_COMMENT_RE = re.compile(r"^\s*%%\s*edge:([a-z][a-z0-9_]*)\s*$")
MESSAGE_RE = re.compile(
    r"^\s*([a-z][a-z0-9_]*)\s*(?:-->>|->>|-->|->|-x|--x|-\)|--\))\s*([a-z][a-z0-9_]*)\s*:\s*(.+?)\s*$"
)


def validate_mermaid(ctx: ValidationContext) -> None:
    if ctx.parsed is None:
        ctx.add("mermaid.syntax", "fail", "Mermaid cannot be checked until the document is parsed")
        return
    errors: list[str] = []
    for (view, state), block in ctx.parsed.blocks.items():
        if view not in {"architecture", "sequence"}:
            continue
        for pattern, description in UNSAFE_PATTERNS:
            if pattern.search(block.content):
                errors.append(f"{view}/{state} contains forbidden {description}")
        if view == "architecture":
            _parse_architecture(ctx, state, block, errors)
        else:
            _parse_sequence(ctx, state, block, errors)
    if errors:
        ctx.add("mermaid.structure_security", "fail", "Mermaid structure or security checks failed", errors)
    else:
        ctx.add("mermaid.structure_security", "pass", "Mermaid IDs, edges, and security rules are valid")
    _render_all(ctx)


def _parse_architecture(ctx: ValidationContext, state: str, block: StateBlock, errors: list[str]) -> None:
    for offset, line in enumerate(block.content.splitlines()[1:], start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("%%") or stripped.startswith(("subgraph ", "end", "direction ", "classDef ", "class ")):
            continue
        edge = EDGE_RE.match(line)
        if edge:
            source, edge_id, label, target = edge.groups()
            key = (state, edge_id)
            if key in ctx.parsed.architecture_edges:
                errors.append(f"architecture/{state} duplicates edge ID {edge_id!r}")
            ctx.parsed.architecture_edges[key] = (source, target)
            ctx.parsed.architecture_edge_labels[key] = _clean_label(label or "")
            continue
        node = NODE_RE.match(line)
        if node:
            node_id, label = node.groups()
            key = (state, node_id)
            if key in ctx.parsed.architecture_nodes:
                errors.append(f"architecture/{state} duplicates node ID {node_id!r}")
            ctx.parsed.architecture_nodes[key] = _clean_label(label)
            continue
        if re.search(r"(?:-->|---|-.->|==>|--o|--x)", line):
            errors.append(f"architecture/{state} line {block.start_line + offset} has an arrow without a canonical edge ID")


def _parse_sequence(ctx: ValidationContext, state: str, block: StateBlock, errors: list[str]) -> None:
    pending_edge: str | None = None
    for offset, line in enumerate(block.content.splitlines()[1:], start=1):
        stripped = line.strip()
        if not stripped:
            continue
        edge_comment = EDGE_COMMENT_RE.match(line)
        if edge_comment:
            if pending_edge is not None:
                errors.append(f"sequence/{state} edge {pending_edge!r} is not followed by a message")
            pending_edge = edge_comment.group(1)
            continue
        participant = PARTICIPANT_RE.match(line)
        if participant:
            if pending_edge is not None:
                errors.append(f"sequence/{state} edge {pending_edge!r} is not immediately before a message")
                pending_edge = None
            node_id, label = participant.groups()
            key = (state, node_id)
            if key in ctx.parsed.sequence_nodes:
                errors.append(f"sequence/{state} duplicates participant ID {node_id!r}")
            ctx.parsed.sequence_nodes[key] = _clean_label(label)
            continue
        message = MESSAGE_RE.match(line)
        if message:
            source, target, label = message.groups()
            if pending_edge is None:
                errors.append(f"sequence/{state} line {block.start_line + offset} has a message without %% edge:<id>")
            else:
                key = (state, pending_edge)
                if key in ctx.parsed.sequence_edges:
                    errors.append(f"sequence/{state} duplicates edge ID {pending_edge!r}")
                ctx.parsed.sequence_edges[key] = (source, target)
                ctx.parsed.sequence_edge_labels[key] = _clean_label(label)
            pending_edge = None
            continue
        if pending_edge is not None:
            errors.append(f"sequence/{state} edge {pending_edge!r} is not immediately before a message")
            pending_edge = None
    if pending_edge is not None:
        errors.append(f"sequence/{state} edge {pending_edge!r} is not followed by a message")


def _render_all(ctx: ValidationContext) -> None:
    if shutil.which("npx") is None:
        ctx.add("tool.mermaid_cli", "error", "npx is required to fetch pinned Mermaid CLI")
        return
    if ctx.parsed is None:
        return
    artifacts_dir = ctx.report_path.parent / f"{ctx.report_path.stem}-artifacts"
    try:
        artifacts_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        ctx.add("mermaid.render", "fail", f"cannot create render directory: {error}")
        return
    errors: list[str] = []
    tool_errors: list[str] = []
    rendered: list[str] = []
    for (view, state), block in ctx.parsed.blocks.items():
        if view not in {"architecture", "sequence"}:
            continue
        input_path = artifacts_dir / f"{view}-{state}.mmd"
        output_path = artifacts_dir / f"{view}-{state}.svg"
        input_path.write_text(block.content, encoding="utf-8")
        result = _run_mmdc(input_path, output_path, artifacts_dir)
        if result is None:
            ctx.add("tool.mermaid_cli", "error", "pinned Mermaid CLI could not be launched")
            return
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            if _looks_like_tool_failure(detail):
                tool_errors.append(f"{view}/{state}: {detail}")
            else:
                errors.append(f"{view}/{state}: {detail}")
            continue
        try:
            svg = output_path.read_text(encoding="utf-8")
        except OSError as error:
            errors.append(f"{view}/{state}: rendered SVG is missing: {error}")
            continue
        if "<svg" not in svg or output_path.stat().st_size == 0:
            errors.append(f"{view}/{state}: rendered SVG is empty")
            continue
        expected_labels = _expected_labels(ctx, view, state)
        visible = _visible_svg_text(svg)
        missing = [label for label in expected_labels if _normalize(label) not in visible]
        if missing:
            errors.append(f"{view}/{state}: SVG is missing manifest labels {missing}")
            continue
        ctx.parsed.rendered_svgs[(view, state)] = output_path
        ctx.artifacts.extend([input_path, output_path])
        rendered.append(str(output_path))
    if tool_errors:
        ctx.add("tool.mermaid_cli", "error", "pinned Mermaid CLI is unavailable", tool_errors)
    elif errors:
        ctx.add("mermaid.render", "fail", "one or more Mermaid diagrams did not render correctly", errors)
    else:
        ctx.add("mermaid.render", "pass", f"rendered with @mermaid-js/mermaid-cli@{VERSION}", rendered)


def _run_mmdc(input_path: Path, output_path: Path, artifacts_dir: Path) -> subprocess.CompletedProcess[str] | None:
    override = os.environ.get("BOXLITE_DIAGRAM_MMDC")
    if override:
        command = [*shlex.split(override), "-i", str(input_path), "-o", str(output_path), "-q"]
        try:
            return subprocess.run(command, text=True, capture_output=True, check=False)
        except OSError:
            return None
    mermaid_config = artifacts_dir / "mermaid-config.json"
    mermaid_config.write_text(json.dumps({"securityLevel": "strict", "htmlLabels": False}), encoding="utf-8")
    command = [
        "npx", "--yes", f"--package=@mermaid-js/mermaid-cli@{VERSION}", "mmdc",
        "-i", str(input_path), "-o", str(output_path), "-c", str(mermaid_config), "-q",
    ]
    environment = os.environ.copy()
    chrome = _find_chrome()
    if chrome:
        puppeteer_config = artifacts_dir / "puppeteer-config.json"
        puppeteer_config.write_text(
            json.dumps({"executablePath": chrome, "args": ["--no-sandbox", "--disable-setuid-sandbox"]}),
            encoding="utf-8",
        )
        command.extend(["-p", str(puppeteer_config)])
        environment["PUPPETEER_SKIP_DOWNLOAD"] = "true"
    try:
        return subprocess.run(command, text=True, capture_output=True, check=False, env=environment)
    except OSError:
        return None


def _find_chrome() -> str | None:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    return next((candidate for candidate in candidates if Path(candidate).is_file()), None)


def _looks_like_tool_failure(detail: str) -> bool:
    lowered = detail.lower()
    return any(
        marker in lowered
        for marker in (
            "eai_again",
            "enotfound",
            "network request",
            "could not resolve",
            "unable to download",
            "failed to launch the browser",
            "could not find chrome",
            "command not found",
        )
    )


def _expected_labels(ctx: ValidationContext, view: str, state: str) -> list[str]:
    labels: list[str] = []
    for _item_type, item in ctx.items():
        if view in item.get("views", []) and state in item.get("states", []):
            labels.append(item["label"])
    return labels


def _visible_svg_text(svg: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", svg)
    return _normalize(html.unescape(without_tags))


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def _clean_label(value: str) -> str:
    return value.strip().strip('"\'').strip()
