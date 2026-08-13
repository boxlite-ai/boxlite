from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "validate_diagrams.py"


class DiagramValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self._run("git", "init", "-q")
        self._run("git", "config", "user.email", "test@example.com")
        self._run("git", "config", "user.name", "Test")
        source = "def start():\n    return load()\n\ndef load():\n    return 'base'\n"
        (self.repo / "app.py").write_text(source, encoding="utf-8")
        self._run("git", "add", "app.py")
        self._run("git", "commit", "-q", "-m", "base")
        self.base = self._run("git", "rev-parse", "HEAD").stdout.strip()
        source = (
            "def start():\n    validate()\n    return load()\n\ndef validate():\n"
            "    return True\n\ndef load():\n    return 'head'\n"
        )
        (self.repo / "app.py").write_text(source, encoding="utf-8")
        self._run("git", "add", "app.py")
        self._run("git", "commit", "-q", "-m", "head")
        self.head = self._run("git", "rev-parse", "HEAD").stdout.strip()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self._write_fake_mmdc()
        self._write_fake_gh()
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin}:{self.env['PATH']}"
        self.env["BOXLITE_DIAGRAM_MMDC"] = str(self.bin / "fake-mmdc")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_valid_overview(self) -> None:
        result, report = self.validate(*overview_fixture(self.head))
        self.assertEqual(result.returncode, 0, result.stderr + json.dumps(report, indent=2))
        self.assertTrue(report["valid"])

    def test_valid_unimplemented_issue(self) -> None:
        document, manifest = issue_fixture(self.head)
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 0, json.dumps(report, indent=2))

    def test_valid_feature_pr(self) -> None:
        document, manifest = feature_pr_fixture(self.base, self.head)
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 0, json.dumps(report, indent=2))

    def test_valid_bug_fix_pr(self) -> None:
        document, manifest = bug_pr_fixture(self.base, self.head)
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 0, json.dumps(report, indent=2))

    def test_missing_call_graph_state_is_rejected(self) -> None:
        document, manifest = feature_pr_fixture(self.base, self.head)
        document = document.replace("### After\n\n```text\n  start", "### After\n\n  start", 1)
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "document.structure")

    def test_malformed_call_graph_hop_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        document = document.replace("start (Module ·", "start Module ·")
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "call_graph.structure")

    def test_fabricated_symbol_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        manifest["nodes"][0]["evidence"][0]["symbol"] = "fabricated"
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "source.evidence")

    def test_unknown_manifest_field_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        manifest["nodes"][0]["untrusted"] = "ignored"
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "manifest.shape")

    def test_stale_line_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        evidence = manifest["nodes"][0]["evidence"][0]
        evidence["line_start"] = 99
        evidence["line_end"] = 99
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "source.evidence")

    def test_real_symbols_with_unsupported_edge_are_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        edge = manifest["edges"][0]
        edge["evidence"][0]["line_start"] = 8
        edge["evidence"][0]["line_end"] = 9
        edge["evidence"][0]["symbol"] = "load"
        edge["evidence"][0]["tokens"] = ["def load"]
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "source.evidence")

    def test_bug_in_after_is_rejected(self) -> None:
        document, manifest = bug_pr_fixture(self.base, self.head)
        bug = next(value for value in manifest["annotations"] if value["kind"] == "BUG")
        bug["state"] = "after"
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "changes.alignment")

    def test_bug_marker_in_prose_is_rejected(self) -> None:
        document, manifest = bug_pr_fixture(self.base, self.head)
        document = document.replace(" — load result ← BUG: stale result", " — load result\nBUG: stale result")
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "call_graph.structure")

    def test_incorrect_diff_annotation_is_rejected(self) -> None:
        document, manifest = feature_pr_fixture(self.base, self.head)
        added = next(value for value in manifest["annotations"] if value["kind"] == "ADDED")
        added["target"] = "node:load"
        load = next(value for value in manifest["nodes"] if value["id"] == "load")
        after = next(value for value in load["evidence"] if value["state"] == "after")
        after["line_end"] = 8
        after["tokens"] = ["def load"]
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "changes.alignment")

    def test_cross_view_disagreement_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        document = document.replace("%% edge:start_load", "%% edge:other")
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "consistency.cross_view")

    def test_annotation_missing_from_mermaid_target_is_rejected(self) -> None:
        document, manifest = issue_fixture(self.head)
        document = document.replace("load PROPOSED: validation behavior", "load", 1)
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "consistency.cross_view")

    def test_state_order_mismatch_is_rejected(self) -> None:
        document, manifest = feature_pr_fixture(self.base, self.head)
        before_start = document.index("### Before")
        after_start = document.index("### After", before_start)
        section_end = document.index("## Sequence")
        before_block = document[before_start:after_start]
        after_block = document[after_start:section_end]
        document = document[:before_start] + after_block + before_block + document[section_end:]
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "document.structure")

    def test_pr_revision_mismatch_is_rejected(self) -> None:
        document, manifest = feature_pr_fixture(self.base, self.head)
        manifest["context"]["sources"]["head_revision"] = self.base
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "source.evidence")

    def test_broken_mermaid_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        document = document.replace("flowchart LR", "flowchart LR\n  BROKEN")
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "mermaid.render")

    def test_unsafe_mermaid_is_rejected(self) -> None:
        document, manifest = overview_fixture(self.head)
        document = document.replace("flowchart LR", "flowchart LR\n  click start href \"https://example.com\"")
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "mermaid.structure_security")

    def test_proposed_behavior_without_issue_evidence_is_rejected(self) -> None:
        document, manifest = issue_fixture(self.head)
        for item in manifest["nodes"] + manifest["edges"]:
            item["evidence"] = [value for value in item["evidence"] if value["type"] == "source"]
        result, report = self.validate(document, manifest)
        self.assertEqual(result.returncode, 1)
        self.assert_check_failed(report, "source.evidence")

    def test_missing_mermaid_tool_returns_two(self) -> None:
        document, manifest = overview_fixture(self.head)
        environment = self.env | {"PATH": f"{self.bin}:/usr/bin:/bin", "BOXLITE_DIAGRAM_MMDC": ""}
        result, report = self.validate(document, manifest, environment=environment)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(report["exit_code"], 2)

    @unittest.skipUnless(os.environ.get("BOXLITE_DIAGRAM_REAL_RENDER") == "1", "real renderer opt-in")
    def test_real_pinned_mermaid_render(self) -> None:
        document, manifest = overview_fixture(self.head)
        environment = self.env.copy()
        environment.pop("BOXLITE_DIAGRAM_MMDC", None)
        result, report = self.validate(document, manifest, environment=environment)
        self.assertEqual(result.returncode, 0, result.stderr + json.dumps(report, indent=2))
        render = next(check for check in report["checks"] if check["name"] == "mermaid.render")
        self.assertIn("@11.16.0", render["message"])

    def validate(
        self, document: str, manifest: dict[str, object], environment: dict[str, str] | None = None
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        case = self.root / f"case-{len(list(self.root.glob('case-*')))}"
        case.mkdir()
        document_path = case / "diagram.md"
        evidence_path = case / "evidence.json"
        report_path = case / "validation.json"
        document_path.write_text(document, encoding="utf-8")
        evidence_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.repo), "--document", str(document_path),
             "--evidence", str(evidence_path), "--report", str(report_path)],
            text=True, capture_output=True, check=False, env=environment or self.env,
        )
        return result, json.loads(report_path.read_text(encoding="utf-8"))

    def assert_check_failed(self, report: dict[str, object], name: str) -> None:
        checks = {value["name"]: value for value in report["checks"]}
        self.assertEqual(checks[name]["status"], "fail", json.dumps(checks.get(name), indent=2))

    def _run(self, *command: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(command, cwd=self.repo, text=True, capture_output=True, check=True)

    def _write_fake_mmdc(self) -> None:
        script = self.bin / "fake-mmdc"
        script.write_text(
            "#!/bin/sh\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  case \"$1\" in -i) input=$2; shift 2;; -o) output=$2; shift 2;; *) shift;; esac\n"
            "done\n"
            "if grep -q BROKEN \"$input\"; then echo 'Parse error' >&2; exit 1; fi\n"
            "{ printf '<svg><text>'; sed 's/&/\\&amp;/g; s/</\\&lt;/g; s/>/\\&gt;/g' \"$input\"; printf '</text></svg>'; } > \"$output\"\n",
            encoding="utf-8",
        )
        script.chmod(0o755)

    def _write_fake_gh(self) -> None:
        script = self.bin / "gh"
        script.write_text(
            "#!/bin/sh\n"
            f"if [ \"$1\" = pr ]; then printf '%s\\n' '{{\"number\":3,\"title\":\"Change flow\",\"body\":\"Fixes #7\",\"url\":\"https://example/pr/3\",\"baseRefOid\":\"{self.base}\",\"headRefOid\":\"{self.head}\"}}'; else printf '%s\\n' '{{\"number\":7,\"title\":\"Add validation\",\"body\":\"validation behavior stale result\",\"state\":\"OPEN\",\"url\":\"https://example/issues/7\"}}'; fi\n",
            encoding="utf-8",
        )
        script.chmod(0o755)


def source_evidence(state: str, revision: str, symbol: str, start: int, end: int, *tokens: str) -> dict[str, object]:
    return {"type": "source", "state": state, "revision": revision, "path": "app.py", "line_start": start,
            "line_end": end, "symbol": symbol, "tokens": list(tokens)}


def node(item_id: str, label: str, states: list[str], evidence: list[dict[str, object]]) -> dict[str, object]:
    return {"id": item_id, "label": label, "states": states,
            "views": ["architecture", "sequence", "call_graph"], "proposed": False, "evidence": evidence}


def edge(item_id: str, label: str, source: str, target: str, states: list[str], evidence: list[dict[str, object]]) -> dict[str, object]:
    return {"id": item_id, "label": label, "from": source, "to": target, "kind": "call", "states": states,
            "views": ["architecture", "sequence", "call_graph"], "proposed": False, "evidence": evidence}


def manifest(context: dict[str, object], states: list[dict[str, object]], nodes: list[dict[str, object]],
             edges: list[dict[str, object]], annotations: list[dict[str, object]] | None = None) -> dict[str, object]:
    return {"schema_version": 1, "context": context, "states": states, "nodes": nodes, "edges": edges,
            "annotations": annotations or []}


def diagrams(states: list[tuple[str, str]], state_hops: dict[str, list[str]], state_edges: dict[str, list[tuple[str, str, str, str]]],
             state_nodes: dict[str, list[tuple[str, str]]], footer: str = "") -> str:
    parts = ["# Diagram", "", "## Architecture", ""]
    for state_id, label in states:
        parts += [f"### {label}", "", "```mermaid", "flowchart LR"]
        parts += [f'  {item_id}["{item_label}"]' for item_id, item_label in state_nodes[state_id]]
        parts += [f'  {source} {edge_id}@-->|"{edge_label}"| {target}' for edge_id, source, target, edge_label in state_edges[state_id]]
        parts += ["```", ""]
    parts += ["## Sequence", ""]
    for state_id, label in states:
        parts += [f"### {label}", "", "```mermaid", "sequenceDiagram"]
        parts += [f"  participant {item_id} as {item_label}" for item_id, item_label in state_nodes[state_id]]
        for edge_id, source, target, edge_label in state_edges[state_id]:
            parts += [f"  %% edge:{edge_id}", f"  {source}->>{target}: {edge_label}"]
        parts += ["```", ""]
    parts += ["## Call graph", ""]
    for state_id, label in states:
        parts += [f"### {label}", "", "```text", *state_hops[state_id], "```", ""]
    if footer:
        parts += [footer, ""]
    return "\n".join(parts)


def overview_fixture(head: str) -> tuple[str, dict[str, object]]:
    states = [{"id": "current", "label": "Current", "revision": head, "proposed": False}]
    nodes = [
        node("start", "start", ["current"], [source_evidence("current", head, "start", 1, 3, "def start", "load()")]),
        node("load", "load", ["current"], [source_evidence("current", head, "load", 8, 9, "def load")]),
    ]
    edges = [edge("start_load", "load", "start", "load", ["current"],
                  [source_evidence("current", head, "start", 1, 3, "load()")])]
    doc = diagrams([("current", "Current")], {"current": [
        "  start (Module · app.py:1) — entry", "    └─ load (Module · app.py:8) — load result"]},
        {"current": [("start_load", "start", "load", "load")]},
        {"current": [("start", "start"), ("load", "load")]})
    return doc, manifest({"kind": "overview", "change_kind": "none", "sources": {"repository": "local"}}, states, nodes, edges)


def issue_fixture(head: str) -> tuple[str, dict[str, object]]:
    doc, data = overview_fixture(head)
    data = copy.deepcopy(data)
    data["context"] = {"kind": "issue", "change_kind": "feature", "sources": {"repository": "local", "issue": 7}}
    data["states"] = [
        {"id": "current", "label": "Current", "revision": head, "proposed": False},
        {"id": "expected", "label": "Expected (proposed)", "revision": head, "proposed": True},
    ]
    for item in data["nodes"] + data["edges"]:
        item["states"].append("expected")
        item["evidence"].append(copy.deepcopy(item["evidence"][0]) | {"state": "expected"})
        item["evidence"].append({"type": "issue", "state": "expected", "issue": 7, "tokens": ["validation"]})
    data["annotations"] = [{"kind": "PROPOSED", "target": "edge:start_load", "state": "expected", "text": "validation behavior"}]
    doc = diagrams(
        [("current", "Current"), ("expected", "Expected (proposed)")],
        {"current": ["  start (Module · app.py:1) — entry", "    └─ load (Module · app.py:8) — load result"],
         "expected": ["  start (Module · app.py:1) — entry", "    └─ load (Module · app.py:8) — load result ← PROPOSED: validation behavior"]},
        {"current": [("start_load", "start", "load", "load")],
         "expected": [("start_load", "start", "load", "load PROPOSED: validation behavior")]},
        {"current": [("start", "start"), ("load", "load")], "expected": [("start", "start"), ("load", "load")]},
    )
    return doc, data


def feature_pr_fixture(base: str, head: str) -> tuple[str, dict[str, object]]:
    states = [{"id": "before", "label": "Before", "revision": base, "proposed": False},
              {"id": "after", "label": "After", "revision": head, "proposed": False}]
    nodes = [
        node("start", "start", ["before", "after"], [source_evidence("before", base, "start", 1, 2, "def start"), source_evidence("after", head, "start", 1, 3, "def start")]),
        node("load", "load", ["before", "after"], [source_evidence("before", base, "load", 4, 5, "def load"), source_evidence("after", head, "load", 8, 9, "def load")]),
        node("validate", "validate ADDED: validate input", ["after"], [source_evidence("after", head, "validate", 5, 6, "def validate")]),
    ]
    edges = [
        edge("start_load", "load", "start", "load", ["before", "after"], [source_evidence("before", base, "start", 1, 2, "load()"), source_evidence("after", head, "start", 1, 3, "load()")]),
        edge("start_validate", "validate ADDED: validate input", "start", "validate", ["after"], [source_evidence("after", head, "start", 1, 3, "validate()")]),
    ]
    annotations = [{"kind": "ADDED", "target": "edge:start_validate", "state": "after", "text": "validate input"}]
    doc = diagrams(
        [("before", "Before"), ("after", "After")],
        {"before": ["  start (Module · app.py:1) — entry", "    └─ load (Module · app.py:4) — load result"],
         "after": ["  start (Module · app.py:1) — entry", "    ├─ validate (Module · app.py:5) — validate input ← ADDED: validate input", "    └─ load (Module · app.py:8) — load result"]},
        {"before": [("start_load", "start", "load", "load")],
         "after": [("start_validate", "start", "validate", "validate ADDED: validate input"), ("start_load", "start", "load", "load")]},
        {"before": [("start", "start"), ("load", "load")],
         "after": [("start", "start"), ("validate", "validate ADDED: validate input"), ("load", "load")]})
    context = {"kind": "pr", "change_kind": "feature", "sources": {"repository": "local", "pr": 3,
               "base_revision": base, "head_revision": head}}
    return doc, manifest(context, states, nodes, edges, annotations)


def bug_pr_fixture(base: str, head: str) -> tuple[str, dict[str, object]]:
    document, data = feature_pr_fixture(base, head)
    data["context"]["change_kind"] = "bug"
    data["context"]["sources"]["issue"] = 7
    data["annotations"] = [
        {"kind": "BUG", "target": "edge:start_load", "state": "before", "text": "stale result"},
        {"kind": "FIX", "target": "edge:start_validate", "state": "after", "text": "validate input"},
    ]
    next(value for value in data["nodes"] if value["id"] == "validate")["label"] = "validate FIX: validate input"
    next(value for value in data["edges"] if value["id"] == "start_validate")["label"] = "validate FIX: validate input"
    document = document.replace(" — load result\n", " — load result ← BUG: stale result\n", 1)
    document = document.replace('"load"| load', '"load BUG: stale result"| load', 1)
    document = document.replace("load->>load", "load->>load", 1)
    before_sequence = document.index("## Sequence")
    marker_position = document.index("start->>load: load", before_sequence)
    document = document[:marker_position] + document[marker_position:].replace(
        "start->>load: load", "start->>load: load BUG: stale result", 1
    )
    document = document.replace("← ADDED: validate input", "← FIX: validate input")
    document = document.replace("ADDED: validate input", "FIX: validate input")
    document += "\nFixes #7\n"
    return document, data


if __name__ == "__main__":
    unittest.main()
