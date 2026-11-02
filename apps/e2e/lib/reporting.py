"""Write flushed pytest evidence for the current E2E run."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

import pytest

_path: Path | None = None
_failed = False


def pytest_configure(config):
    global _path, _failed
    directory = os.environ.get("BOXLITE_E2E_RUN_DIR")
    _path = Path(directory) / "cases.jsonl" if directory else None
    _failed = False


def _emit(event):
    global _failed
    if _path is None or _failed:
        return
    try:
        with _path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event) + "\n")
            stream.flush()
    except (OSError, ValueError, TypeError) as exc:
        _failed = True
        print(f"E2E reporting failed ({_path}): {exc}; run evidence is incomplete", file=sys.stderr)


def pytest_collection_finish(session):
    _emit({"type": "collection", "nodeids": [item.nodeid for item in session.items]})


def pytest_deselected(items):
    _emit({"type": "deselected", "nodeids": [item.nodeid for item in items]})


def pytest_collectreport(report):
    if report.failed:
        _emit({"type": "collection_error", "nodeid": report.nodeid, "outcome": report.outcome})


def pytest_runtest_logreport(report):
    _emit({"type": "report", "nodeid": report.nodeid, "when": report.when,
           "outcome": report.outcome, "duration": report.duration,
           "wasxfail": getattr(report, "wasxfail", None),
           "strict_xpass": report.failed and str(getattr(report, "longrepr", "")).startswith("[XPASS(strict)]")})


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    _emit({"type": "sessionfinish", "exitstatus": int(exitstatus)})
    # Preserve the original failure; a successful test run cannot hide lost evidence.
    if _failed and session.exitstatus == 0:
        session.exitstatus = pytest.ExitCode.INTERNAL_ERROR
