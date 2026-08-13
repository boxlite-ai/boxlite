from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

Status = Literal["pass", "fail", "error"]


@dataclass(frozen=True)
class Check:
    name: str
    status: Status
    message: str
    evidence: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "evidence": list(self.evidence),
        }


@dataclass
class StateBlock:
    view: str
    state: str
    label: str
    language: str
    content: str
    start_line: int


@dataclass
class ParsedDocument:
    text: str
    blocks: dict[tuple[str, str], StateBlock] = field(default_factory=dict)
    architecture_nodes: dict[tuple[str, str], str] = field(default_factory=dict)
    architecture_edges: dict[tuple[str, str], tuple[str, str]] = field(default_factory=dict)
    architecture_edge_labels: dict[tuple[str, str], str] = field(default_factory=dict)
    sequence_nodes: dict[tuple[str, str], str] = field(default_factory=dict)
    sequence_edges: dict[tuple[str, str], tuple[str, str]] = field(default_factory=dict)
    sequence_edge_labels: dict[tuple[str, str], str] = field(default_factory=dict)
    call_graph_nodes: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    call_graph_edges: dict[tuple[str, str], tuple[str, str]] = field(default_factory=dict)
    rendered_svgs: dict[tuple[str, str], Path] = field(default_factory=dict)


@dataclass
class ValidationContext:
    repo: Path
    document_path: Path
    evidence_path: Path
    report_path: Path
    manifest: Any
    checks: list[Check] = field(default_factory=list)
    parsed: ParsedDocument | None = None
    source_windows: dict[tuple[str, str, int, int], str] = field(default_factory=dict)
    remote_issues: dict[int, dict[str, Any]] = field(default_factory=dict)
    remote_prs: dict[int, dict[str, Any]] = field(default_factory=dict)
    artifacts: list[Path] = field(default_factory=list)

    def add(
        self,
        name: str,
        status: Status,
        message: str,
        evidence: list[str] | tuple[str, ...] = (),
    ) -> None:
        self.checks.append(Check(name, status, message, tuple(evidence)))

    @property
    def has_failures(self) -> bool:
        return any(check.status == "fail" for check in self.checks)

    @property
    def has_tool_errors(self) -> bool:
        return any(check.status == "error" for check in self.checks)

    def items(self) -> list[tuple[str, dict[str, Any]]]:
        if not isinstance(self.manifest, dict):
            return []
        return [
            ("node", item) for item in self.manifest.get("nodes", [])
        ] + [("edge", item) for item in self.manifest.get("edges", [])]

    def item_map(self, item_type: str) -> dict[str, dict[str, Any]]:
        if item_type not in {"node", "edge"} or not isinstance(self.manifest, dict):
            return {}
        key = "nodes" if item_type == "node" else "edges"
        return {item["id"]: item for item in self.manifest.get(key, []) if "id" in item}

    def state_map(self) -> dict[str, dict[str, Any]]:
        if not isinstance(self.manifest, dict):
            return {}
        return {state["id"]: state for state in self.manifest.get("states", []) if "id" in state}
