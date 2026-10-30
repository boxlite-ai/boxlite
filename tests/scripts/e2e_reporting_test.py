"""Exercise real report artifacts and pytest event persistence."""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, REPO / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def report():
    return load("e2e_report", "scripts/test/rest/report.py")


def write_run(path, events, xml="<testsuites><testsuite><testcase classname='cases.test_one' name='test_one'/></testsuite></testsuites>"):
    (path / "run.json").write_text(json.dumps({"complete": True, "ended_at": "2026-10-29T00:00:01Z", "exit_code": 0}))
    (path / "timings.jsonl").write_text('{"stage":"tests","elapsed_ms":100,"status":"ok","cache_hit":false}\n')
    (path / "cases.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    (path / "junit.xml").write_text(xml)


def events(nodeid="cases/test_one.py::test_one", outcome="passed", wasxfail=None):
    return [
        {"type": "collection", "nodeids": [nodeid]},
        *[{"type": "report", "nodeid": nodeid, "when": phase, "outcome": outcome if phase == "call" else "passed", "duration": 0.1, "wasxfail": wasxfail if phase == "call" else None} for phase in ("setup", "call", "teardown")],
        {"type": "sessionfinish", "exitstatus": 0},
    ]


def test_actual_xfail_is_separate_from_skip_and_offline_coverage(report, tmp_path):
    write_run(tmp_path, events("cases/test_harness_guards.py::test_one", "skipped", "known defect"), '<testsuites><testsuite><testcase classname="cases.test_harness_guards" name="test_one"><skipped type="pytest.xfail"/></testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    offline = next(line for line in lines if line.startswith("- Offline harness:"))
    assert "xfail=1" in offline and "skip=0" in offline
    assert (tmp_path / "summary.md").exists()


@pytest.mark.parametrize("damage", ["missing_xml", "broken_xml", "no_finish", "broken_jsonl"])
def test_damaged_evidence_is_incomplete(report, tmp_path, damage):
    rows = events()
    write_run(tmp_path, rows[:-1] if damage == "no_finish" else rows)
    if damage == "missing_xml":
        (tmp_path / "junit.xml").unlink()
    elif damage == "broken_xml":
        (tmp_path / "junit.xml").write_text("<testsuites>")
    elif damage == "broken_jsonl":
        with (tmp_path / "cases.jsonl").open("a") as stream:
            stream.write('{"type":')
    lines, incomplete = report.summarize_run(tmp_path)
    assert incomplete
    assert "- Evidence: incomplete" in lines


def test_plugin_flushes_events_and_preserves_failed_exit(tmp_path, monkeypatch, capsys):
    plugin = load("e2e_plugin", "apps/e2e/lib/reporting.py")
    monkeypatch.setenv("BOXLITE_E2E_RUN_DIR", str(tmp_path))
    plugin.pytest_configure(None)
    session = SimpleNamespace(items=[SimpleNamespace(nodeid="case::test")], exitstatus=0)
    plugin.pytest_collection_finish(session)
    assert json.loads((tmp_path / "cases.jsonl").read_text())["nodeids"] == ["case::test"]
    (tmp_path / "cases.jsonl").unlink()
    (tmp_path / "cases.jsonl").mkdir()
    plugin.pytest_sessionfinish(session, 0)
    assert session.exitstatus == pytest.ExitCode.INTERNAL_ERROR
    assert "run evidence is incomplete" in capsys.readouterr().err
    session.exitstatus = 1
    plugin.pytest_sessionfinish(session, 1)
    assert session.exitstatus == 1


def test_setup_error_and_strict_xpass_are_distinct(report, tmp_path):
    rows = events(outcome="failed")
    rows[2]["strict_xpass"] = True
    write_run(tmp_path, rows, '<testsuites><testsuite><testcase classname="cases.test_one" name="test_one"><failure message="[XPASS(strict)]"/></testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    assert any("xpass=1" in line for line in lines)
    rows[1]["outcome"] = "failed"
    rows.pop(2)  # A setup error prevents the call phase.
    write_run(tmp_path, rows, '<testsuites><testsuite><testcase classname="cases.test_one" name="test_one"><error message="failed on setup"/></testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    assert any("error=1" in line for line in lines)


def test_environment_operation_needs_no_pytest_artifacts(report, tmp_path):
    (tmp_path / "run.json").write_text(json.dumps({"command": "doctor", "complete": True, "ended_at": "2026-10-29T00:00:01Z", "exit_code": 0}))
    (tmp_path / "timings.jsonl").write_text("")
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    assert "- Scope: environment operation; no suite coverage claimed" in lines


def test_invalid_event_shape_does_not_hide_other_runs(report, tmp_path):
    write_run(tmp_path, [{"type": "collection", "nodeids": 42}, *events()])
    lines, incomplete = report.summarize_run(tmp_path)
    assert incomplete
    assert any("nodeids must be a list of strings" in line for line in lines)


@pytest.mark.parametrize("phase", ["setup", "call", "teardown"])
def test_missing_required_phase_is_incomplete(report, tmp_path, phase):
    rows = [row for row in events() if row.get("when") != phase]
    write_run(tmp_path, rows)
    lines, incomplete = report.summarize_run(tmp_path)
    assert incomplete
    assert any(phase in line and "cases/test_one.py::test_one" in line for line in lines if line.startswith("- "))


@pytest.mark.parametrize("outcome, expected, result", [
    ("skipped", "xfail", '<skipped type="pytest.xfail" message=""/>'),
    ("passed", "xpass", ""),
])
def test_empty_xfail_reason_preserves_expected_failure_status(report, tmp_path, outcome, expected, result):
    write_run(tmp_path, events(outcome=outcome, wasxfail=""), f'<testsuites><testsuite><testcase classname="cases.test_one" name="test_one">{result}</testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    assert f"| `cases/test_one.py::test_one` | E2E | {expected} | 0.300 |" in lines


@pytest.mark.parametrize("outcome, wasxfail, xml_result", [
    ("passed", None, "<failure/>"),
    ("failed", None, ""),
    ("skipped", None, '<skipped type="pytest.xfail"/>'),
    ("skipped", "expected defect", '<skipped type="pytest.skip"/>'),
])
def test_junit_result_conflicts_are_incomplete(report, tmp_path, outcome, wasxfail, xml_result):
    write_run(tmp_path, events(outcome=outcome, wasxfail=wasxfail), f'<testsuites><testsuite><testcase classname="cases.test_one" name="test_one">{xml_result}</testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert incomplete
    assert any("JUnit" in line for line in lines if line.startswith("- "))


def test_junit_results_must_match_each_item(report, tmp_path):
    first, second = events(), events("cases/test_one.py::test_two", outcome="failed")
    rows = [{"type": "collection", "nodeids": [first[0]["nodeids"][0], second[0]["nodeids"][0]]}, *first[1:-1], *second[1:]]
    write_run(tmp_path, rows, '<testsuites><testsuite><testcase classname="cases.test_one" name="test_one"><failure/></testcase><testcase classname="cases.test_one" name="test_two"/></testsuite></testsuites>')
    _, incomplete = report.summarize_run(tmp_path)
    assert incomplete


def test_parameterized_junit_identity_matches_pytest_mapping(report, tmp_path):
    nodeid = "cases/test_one.py::TestNested::test_one[value.py::nested/path[part]]"
    write_run(tmp_path, events(nodeid), '<testsuites><testsuite><testcase classname="cases.test_one.TestNested" name="test_one[value.py::nested/path[part]]"/></testsuite></testsuites>')
    _, incomplete = report.summarize_run(tmp_path)
    assert not incomplete


def test_call_failure_and_teardown_error_are_complete_error_evidence(report, tmp_path):
    rows = events(outcome="failed")
    rows[3]["outcome"] = "failed"
    write_run(tmp_path, rows, '<testsuites><testsuite><testcase classname="cases.test_one" name="test_one"><failure/></testcase><testcase classname="cases.test_one" name="test_one"><error message="failed on teardown"/></testcase></testsuite></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert not incomplete
    assert "| `cases/test_one.py::test_one` | E2E | error | 0.300 |" in lines


@pytest.mark.parametrize("setup_outcome, marker, result", [
    ("skipped", None, '<skipped type="pytest.skip"/>'),
    ("skipped", "", '<skipped type="pytest.xfail"/>'),
    ("failed", None, "<error/>"),
])
def test_unsuccessful_setup_needs_no_call(report, tmp_path, setup_outcome, marker, result):
    rows = [row for row in events() if row.get("when") != "call"]
    rows[1].update(outcome=setup_outcome, wasxfail=marker)
    write_run(tmp_path, rows, f'<testsuites><testsuite><testcase classname="cases.test_one" name="test_one">{result}</testcase></testsuite></testsuites>')
    _, incomplete = report.summarize_run(tmp_path)
    assert not incomplete


def test_unreported_collected_item_is_incomplete(report, tmp_path):
    write_run(tmp_path, [{"type": "collection", "nodeids": ["cases/test_one.py::test_one"]}, {"type": "sessionfinish", "exitstatus": 0}], '<testsuites><testsuite/></testsuites>')
    lines, incomplete = report.summarize_run(tmp_path)
    assert incomplete
    assert any("incomplete=1" in line for line in lines)


def test_report_fails_on_incomplete_evidence(report, tmp_path, monkeypatch, capsys):
    run = tmp_path / "runs" / "20260101T000000Z-1"
    run.mkdir(parents=True)
    write_run(run, events())
    (run / "run.json").write_text(json.dumps({"complete": False, "ended_at": None}))
    report_dir = tmp_path / "report"
    monkeypatch.setattr(report, "REPORT_DIR", report_dir)
    monkeypatch.setattr(report, "OUT", report_dir / "rest-report.md")
    monkeypatch.setattr(sys, "argv", ["report.py", "--state-dir", str(tmp_path)])
    with pytest.raises(SystemExit) as failure:
        report.main()
    assert failure.value.code == 1
    assert "incomplete evidence" in capsys.readouterr().err


def test_report_allows_incomplete_evidence_on_request(report, tmp_path, monkeypatch):
    run = tmp_path / "runs" / "20260101T000000Z-1"
    run.mkdir(parents=True)
    write_run(run, events())
    (run / "run.json").write_text(json.dumps({"complete": False, "ended_at": None}))
    report_dir = tmp_path / "report"
    monkeypatch.setattr(report, "REPORT_DIR", report_dir)
    monkeypatch.setattr(report, "OUT", report_dir / "rest-report.md")
    monkeypatch.setattr(sys, "argv", ["report.py", "--state-dir", str(tmp_path), "--allow-incomplete"])
    report.main()
    assert (report_dir / "rest-report.md").exists()
