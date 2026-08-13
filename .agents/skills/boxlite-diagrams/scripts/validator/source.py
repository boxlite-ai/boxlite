from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

from .models import ValidationContext

ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
KINDS = {"overview", "issue", "pr", "commit", "branch", "working-tree-change"}
CHANGE_KINDS = {"none", "bug", "feature", "refactor", "docs"}
VIEWS = {"architecture", "sequence", "call_graph"}
EDGE_KINDS = {"call", "rpc", "dispatch", "spawn", "data", "state-transition", "proposed"}
ANNOTATIONS = {"ISSUE", "BUG", "FIX", "PROPOSED", "ADDED", "CHANGED", "REMOVED"}
ROOT_KEYS = {"schema_version", "context", "states", "nodes", "edges", "annotations"}
CONTEXT_KEYS = {"kind", "change_kind", "sources"}
SOURCE_KEYS = {"repository", "issue", "pr", "base_revision", "head_revision"}
STATE_KEYS = {"id", "label", "revision", "proposed"}
ITEM_KEYS = {"id", "label", "states", "views", "proposed", "evidence"}
EDGE_KEYS = ITEM_KEYS | {"from", "to", "kind"}
SOURCE_EVIDENCE_KEYS = {"type", "state", "revision", "path", "line_start", "line_end", "symbol", "tokens"}
ISSUE_EVIDENCE_KEYS = {"type", "state", "issue", "tokens"}
ANNOTATION_KEYS = {"kind", "target", "state", "text"}


def validate_manifest(ctx: ValidationContext) -> None:
    errors: list[str] = []
    manifest = ctx.manifest
    if not isinstance(manifest, dict):
        ctx.add("manifest.shape", "fail", "evidence root must be a JSON object")
        return
    if manifest.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    _reject_extra_keys(manifest, ROOT_KEYS, "manifest", errors)

    context = manifest.get("context")
    if not isinstance(context, dict):
        errors.append("context must be an object")
        context = {}
    if context.get("kind") not in KINDS:
        errors.append(f"context.kind must be one of {sorted(KINDS)}")
    if context.get("change_kind") not in CHANGE_KINDS:
        errors.append(f"context.change_kind must be one of {sorted(CHANGE_KINDS)}")
    _reject_extra_keys(context, CONTEXT_KEYS, "context", errors)
    sources = context.get("sources")
    if not isinstance(sources, dict):
        errors.append("context.sources must be an object")
    else:
        _reject_extra_keys(sources, SOURCE_KEYS, "context.sources", errors)
        for key in ("repository", "base_revision", "head_revision"):
            if key in sources and not _valid_non_option_string(sources[key]):
                errors.append(f"context.sources.{key} must be a non-empty, non-option string")
        for key in ("issue", "pr"):
            if key in sources and not _positive_integer(sources[key]):
                errors.append(f"context.sources.{key} must be a positive integer")

    states = manifest.get("states")
    if not isinstance(states, list) or not 1 <= len(states) <= 2:
        errors.append("states must contain one or two entries")
        states = []
    state_ids: list[str] = []
    state_labels: list[str] = []
    for index, state in enumerate(states):
        where = f"states[{index}]"
        if not isinstance(state, dict):
            errors.append(f"{where} must be an object")
            continue
        _reject_extra_keys(state, STATE_KEYS, where, errors)
        state_id = state.get("id")
        label = state.get("label")
        if not isinstance(state_id, str) or not ID_RE.fullmatch(state_id):
            errors.append(f"{where}.id must be lowercase snake case")
        else:
            state_ids.append(state_id)
        if not isinstance(label, str) or not label.strip():
            errors.append(f"{where}.label must be non-empty")
        else:
            state_labels.append(label)
        if not _valid_non_option_string(state.get("revision")):
            errors.append(f"{where}.revision must be a non-empty, non-option string")
        if not isinstance(state.get("proposed"), bool):
            errors.append(f"{where}.proposed must be boolean")
    if len(state_ids) != len(set(state_ids)):
        errors.append("state IDs must be unique")
    if len(state_labels) != len(set(state_labels)):
        errors.append("state labels must be unique")

    seen_item_ids: dict[str, str] = {}
    node_ids: set[str] = set()
    edge_ids: set[str] = set()
    for collection, item_type in (("nodes", "node"), ("edges", "edge")):
        values = manifest.get(collection)
        minimum = 1 if collection == "nodes" else 0
        if not isinstance(values, list) or len(values) < minimum:
            errors.append(f"{collection} must be an array with at least {minimum} entries")
            continue
        for index, item in enumerate(values):
            where = f"{collection}[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{where} must be an object")
                continue
            _reject_extra_keys(item, EDGE_KEYS if item_type == "edge" else ITEM_KEYS, where, errors)
            item_id = item.get("id")
            if not isinstance(item_id, str) or not ID_RE.fullmatch(item_id):
                errors.append(f"{where}.id must be lowercase snake case")
                continue
            if item_id in seen_item_ids:
                errors.append(f"canonical ID {item_id!r} is reused by a {seen_item_ids[item_id]} and {item_type}")
            seen_item_ids[item_id] = item_type
            (node_ids if item_type == "node" else edge_ids).add(item_id)
            if not isinstance(item.get("label"), str) or not item.get("label"):
                errors.append(f"{where}.label must be non-empty")
            item_states = item.get("states")
            if not _unique_nonempty_subset(item_states, set(state_ids)):
                errors.append(f"{where}.states must be a non-empty unique subset of declared states")
                item_states = []
            views = item.get("views")
            if not _unique_nonempty_subset(views, VIEWS):
                errors.append(f"{where}.views must be a non-empty unique subset of {sorted(VIEWS)}")
            if not isinstance(item.get("proposed"), bool):
                errors.append(f"{where}.proposed must be boolean")
            elif item["proposed"]:
                non_proposed_states = [
                    state_id for state_id in item_states
                    if not next((state["proposed"] for state in states if state.get("id") == state_id), False)
                ]
                if non_proposed_states:
                    errors.append(f"{where} is proposed but belongs to implemented states {non_proposed_states}")
            evidence = item.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                errors.append(f"{where}.evidence must be a non-empty array")
                continue
            evidence_states: set[str] = set()
            for evidence_index, entry in enumerate(evidence):
                evidence_where = f"{where}.evidence[{evidence_index}]"
                _validate_evidence_shape(entry, evidence_where, set(state_ids), errors)
                if isinstance(entry, dict) and isinstance(entry.get("state"), str):
                    evidence_states.add(entry["state"])
            for state_id in item_states:
                if state_id not in evidence_states:
                    errors.append(f"{where} has no evidence for state {state_id!r}")
            if item_type == "edge":
                if item.get("from") not in node_ids and item.get("from") not in {
                    node.get("id") for node in manifest.get("nodes", []) if isinstance(node, dict)
                }:
                    errors.append(f"{where}.from must reference a declared node")
                if item.get("to") not in {
                    node.get("id") for node in manifest.get("nodes", []) if isinstance(node, dict)
                }:
                    errors.append(f"{where}.to must reference a declared node")
                if item.get("kind") not in EDGE_KINDS:
                    errors.append(f"{where}.kind must be one of {sorted(EDGE_KINDS)}")

    annotations = manifest.get("annotations")
    if not isinstance(annotations, list):
        errors.append("annotations must be an array")
        annotations = []
    valid_targets = {f"node:{item_id}" for item_id in node_ids} | {f"edge:{item_id}" for item_id in edge_ids}
    for index, annotation in enumerate(annotations):
        where = f"annotations[{index}]"
        if not isinstance(annotation, dict):
            errors.append(f"{where} must be an object")
            continue
        _reject_extra_keys(annotation, ANNOTATION_KEYS, where, errors)
        if annotation.get("kind") not in ANNOTATIONS:
            errors.append(f"{where}.kind must be one of {sorted(ANNOTATIONS)}")
        if annotation.get("target") not in valid_targets:
            errors.append(f"{where}.target must reference a declared item")
        if annotation.get("state") not in state_ids:
            errors.append(f"{where}.state must reference a declared state")
        elif annotation.get("target") in valid_targets:
            item_type, item_id = annotation["target"].split(":", 1)
            target = next(
                (item for item in manifest[f"{item_type}s"] if item.get("id") == item_id),
                None,
            )
            if target is not None and annotation["state"] not in target.get("states", []):
                errors.append(f"{where}.state is not a state of {annotation['target']}")
        if not isinstance(annotation.get("text"), str) or not annotation.get("text"):
            errors.append(f"{where}.text must be non-empty")

    if errors:
        ctx.add("manifest.shape", "fail", "evidence manifest is invalid", errors)
    else:
        ctx.add("manifest.shape", "pass", "evidence manifest has valid IDs, memberships, and references")


def validate_source_evidence(ctx: ValidationContext) -> None:
    if any(check.name == "manifest.shape" and check.status == "fail" for check in ctx.checks):
        ctx.add("source.evidence", "fail", "source evidence cannot be checked until the manifest is valid")
        return

    errors: list[str] = []
    for item_type, item in ctx.items():
        for entry in item.get("evidence", []):
            if entry["type"] == "source":
                state = ctx.state_map()[entry["state"]]
                if entry["revision"] != state["revision"]:
                    errors.append(
                        f"{item_type}:{item['id']} evidence revision {entry['revision']!r} does not match "
                        f"state {entry['state']!r} revision {state['revision']!r}"
                    )
                    continue
                window = _read_source_window(ctx, entry, errors)
                if window is None:
                    continue
                symbol_leaf = _symbol_leaf(entry["symbol"])
                if not re.search(rf"\b{re.escape(symbol_leaf)}\b", window):
                    errors.append(
                        f"{item_type}:{item['id']} symbol {entry['symbol']!r} does not occur in "
                        f"{entry['revision']}:{entry['path']}:{entry['line_start']}-{entry['line_end']}"
                    )
                for token in entry["tokens"]:
                    if token not in window:
                        errors.append(
                            f"{item_type}:{item['id']} token {token!r} is absent from "
                            f"{entry['revision']}:{entry['path']}:{entry['line_start']}-{entry['line_end']}"
                        )
                if item_type == "edge" and item.get("kind") == "call":
                    caller = ctx.item_map("node").get(item["from"], {})
                    caller_symbols = {
                        value["symbol"] for value in caller.get("evidence", [])
                        if value.get("type") == "source" and value.get("state") == entry["state"]
                    }
                    if entry["symbol"] not in caller_symbols:
                        errors.append(
                            f"edge:{item['id']} direct-call evidence must be anchored to caller node:{item['from']}"
                        )
                    callee = ctx.item_map("node").get(item["to"], {})
                    callee_evidence = [
                        value for value in callee.get("evidence", [])
                        if value.get("type") == "source" and value.get("state") == entry["state"]
                    ]
                    if callee_evidence:
                        callee_leaf = _symbol_leaf(callee_evidence[0]["symbol"])
                        if not _has_call_expression(window, callee_leaf):
                            errors.append(
                                f"edge:{item['id']} direct-call evidence does not contain callee {callee_leaf!r}"
                            )
            elif entry["type"] == "issue":
                issue = _load_issue(ctx, entry["issue"], errors)
                if issue is None:
                    continue
                searchable = f"{issue.get('title', '')}\n{issue.get('body', '')}".lower()
                for token in entry["tokens"]:
                    if token.lower() not in searchable:
                        errors.append(f"{item_type}:{item['id']} issue #{entry['issue']} lacks token {token!r}")

        for state_id in item["states"]:
            state = ctx.state_map()[state_id]
            state_evidence = [value for value in item["evidence"] if value["state"] == state_id]
            if state["proposed"] or item["proposed"]:
                if not any(value["type"] == "issue" for value in state_evidence):
                    errors.append(f"{item_type}:{item['id']} proposed state {state_id!r} requires issue evidence")
            elif not any(value["type"] == "source" for value in state_evidence):
                errors.append(f"{item_type}:{item['id']} implemented state {state_id!r} requires source evidence")

    _validate_remote_context(ctx, errors)
    if errors:
        ctx.add("source.evidence", "fail", "source or remote evidence is invalid", errors)
    else:
        ctx.add("source.evidence", "pass", "all source anchors, symbols, tokens, and remote evidence resolve")


def _unique_nonempty_subset(value: Any, allowed: set[str]) -> bool:
    return (
        isinstance(value, list)
        and bool(value)
        and all(isinstance(item, str) and item in allowed for item in value)
        and len(value) == len(set(value))
    )


def _validate_evidence_shape(entry: Any, where: str, states: set[str], errors: list[str]) -> None:
    if not isinstance(entry, dict):
        errors.append(f"{where} must be an object")
        return
    if entry.get("state") not in states:
        errors.append(f"{where}.state must reference a declared state")
    tokens = entry.get("tokens")
    if not isinstance(tokens, list) or not tokens or not all(isinstance(token, str) and token for token in tokens):
        errors.append(f"{where}.tokens must be a non-empty string array")
    if entry.get("type") == "source":
        _reject_extra_keys(entry, SOURCE_EVIDENCE_KEYS, where, errors)
        for key in ("path", "symbol"):
            if not isinstance(entry.get(key), str) or not entry.get(key):
                errors.append(f"{where}.{key} must be non-empty")
        if not _valid_non_option_string(entry.get("revision")):
            errors.append(f"{where}.revision must be a non-empty, non-option string")
        for key in ("line_start", "line_end"):
            if not isinstance(entry.get(key), int) or entry.get(key, 0) < 1:
                errors.append(f"{where}.{key} must be a positive integer")
        if isinstance(entry.get("line_start"), int) and isinstance(entry.get("line_end"), int):
            if entry["line_start"] > entry["line_end"]:
                errors.append(f"{where}.line_start must not exceed line_end")
        path = entry.get("path")
        if isinstance(path, str) and (PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts):
            errors.append(f"{where}.path must be a safe repository-relative path")
    elif entry.get("type") == "issue":
        _reject_extra_keys(entry, ISSUE_EVIDENCE_KEYS, where, errors)
        if not _positive_integer(entry.get("issue")):
            errors.append(f"{where}.issue must be a positive integer")
    else:
        errors.append(f"{where}.type must be 'source' or 'issue'")


def _read_source_window(ctx: ValidationContext, entry: dict[str, Any], errors: list[str]) -> str | None:
    key = (entry["revision"], entry["path"], entry["line_start"], entry["line_end"])
    if key in ctx.source_windows:
        return ctx.source_windows[key]
    revision = entry["revision"]
    path = entry["path"]
    if revision == "WORKTREE":
        source_path = (ctx.repo / path).resolve()
        try:
            source_path.relative_to(ctx.repo.resolve())
        except ValueError:
            errors.append(f"WORKTREE:{path} escapes the repository")
            return None
        try:
            source = source_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            errors.append(f"cannot read WORKTREE:{path}: {error}")
            return None
    else:
        result = _run(ctx.repo, ["git", "show", "--end-of-options", f"{revision}:{path}"])
        if result.returncode != 0:
            errors.append(f"cannot resolve {revision}:{path}: {result.stderr.strip()}")
            return None
        source = result.stdout
    lines = source.splitlines()
    if entry["line_end"] > len(lines):
        errors.append(
            f"{revision}:{path}:{entry['line_start']}-{entry['line_end']} exceeds file length {len(lines)}"
        )
        return None
    window = "\n".join(lines[entry["line_start"] - 1 : entry["line_end"]])
    ctx.source_windows[key] = window
    return window


def _load_issue(ctx: ValidationContext, number: int, errors: list[str]) -> dict[str, Any] | None:
    if number in ctx.remote_issues:
        return ctx.remote_issues[number]
    if shutil.which("gh") is None:
        ctx.add("tool.gh", "error", "gh is required for issue or PR evidence")
        return None
    result = _run(ctx.repo, ["gh", "issue", "view", str(number), "--json", "number,title,body,state,url"])
    if result.returncode == 124:
        ctx.add("tool.gh", "error", result.stderr.strip())
        return None
    if result.returncode != 0:
        errors.append(f"cannot load issue #{number}: {result.stderr.strip()}")
        return None
    try:
        issue = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        errors.append(f"gh returned invalid JSON for issue #{number}: {error}")
        return None
    ctx.remote_issues[number] = issue
    return issue


def _validate_remote_context(ctx: ValidationContext, errors: list[str]) -> None:
    context = ctx.manifest["context"]
    sources = context["sources"]
    if context["kind"] == "issue":
        if not isinstance(sources.get("issue"), int):
            errors.append("issue context requires context.sources.issue")
        else:
            _load_issue(ctx, sources["issue"], errors)
    if context["kind"] == "pr":
        number = sources.get("pr")
        if not isinstance(number, int):
            errors.append("PR context requires context.sources.pr")
        elif shutil.which("gh") is None:
            ctx.add("tool.gh", "error", "gh is required for issue or PR evidence")
        else:
            result = _run(ctx.repo, ["gh", "pr", "view", str(number), "--json", "number,title,body,url,baseRefOid,headRefOid"])
            if result.returncode == 124:
                ctx.add("tool.gh", "error", result.stderr.strip())
                return
            if result.returncode != 0:
                errors.append(f"cannot load PR #{number}: {result.stderr.strip()}")
            else:
                try:
                    pr = json.loads(result.stdout)
                    ctx.remote_prs[number] = pr
                    base = sources.get("base_revision")
                    head = sources.get("head_revision")
                    if base != pr.get("baseRefOid"):
                        errors.append(
                            f"PR #{number} base revision is {pr.get('baseRefOid')}, not declared {base}"
                        )
                    if head != pr.get("headRefOid"):
                        errors.append(
                            f"PR #{number} head revision is {pr.get('headRefOid')}, not declared {head}"
                        )
                except json.JSONDecodeError as error:
                    errors.append(f"gh returned invalid JSON for PR #{number}: {error}")
        issue_number = sources.get("issue")
        if issue_number is not None:
            if not isinstance(issue_number, int):
                errors.append("context.sources.issue must be a positive integer")
            else:
                _load_issue(ctx, issue_number, errors)


def _symbol_leaf(symbol: str) -> str:
    return re.split(r"::|\.", symbol)[-1].strip("<> ")


def _has_call_expression(window: str, symbol: str) -> bool:
    pattern = re.compile(rf"\b{re.escape(symbol)}\s*\(")
    for line in _strip_non_code(window).splitlines():
        if not pattern.search(line):
            continue
        if re.search(rf"\b(?:def|fn|function|class)\s+{re.escape(symbol)}\s*\(", line):
            continue
        return True
    return False


def _run(repo: Path, command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command, cwd=repo, text=True, capture_output=True, check=False, timeout=_command_timeout()
        )
    except subprocess.TimeoutExpired as error:
        executable = Path(command[0]).name
        message = f"{executable} exceeded {_command_timeout():g} seconds: {error}"
        return subprocess.CompletedProcess(command, 124, "", message)


def _strip_non_code(source: str) -> str:
    output: list[str] = []
    index = 0
    quote: str | None = None
    block_comment = False
    while index < len(source):
        current = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if block_comment:
            if current == "*" and following == "/":
                output.extend("  ")
                index += 2
                block_comment = False
            else:
                output.append("\n" if current == "\n" else " ")
                index += 1
            continue
        if quote is not None:
            if current == "\\" and index + 1 < len(source):
                output.extend("  ")
                index += 2
            elif current == quote:
                output.append(" ")
                index += 1
                quote = None
            else:
                output.append("\n" if current == "\n" else " ")
                index += 1
            continue
        if current == "/" and following == "*":
            output.extend("  ")
            index += 2
            block_comment = True
        elif current == "/" and following == "/":
            newline = source.find("\n", index)
            if newline < 0:
                output.extend(" " * (len(source) - index))
                break
            output.extend(" " * (newline - index))
            index = newline
        elif current == "#":
            newline = source.find("\n", index)
            if newline < 0:
                output.extend(" " * (len(source) - index))
                break
            output.extend(" " * (newline - index))
            index = newline
        elif current in {'"', "'", "`"}:
            quote = current
            output.append(" ")
            index += 1
        else:
            output.append(current)
            index += 1
    return "".join(output)


def _valid_non_option_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not value.startswith("-")


def _positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _command_timeout() -> float:
    raw = os.environ.get("BOXLITE_DIAGRAM_COMMAND_TIMEOUT", "120")
    try:
        value = float(raw)
    except ValueError:
        return 120.0
    return value if value > 0 else 120.0


def _reject_extra_keys(value: dict[str, Any], allowed: set[str], where: str, errors: list[str]) -> None:
    extras = sorted(set(value) - allowed)
    if extras:
        errors.append(f"{where} contains unsupported fields {extras}")
