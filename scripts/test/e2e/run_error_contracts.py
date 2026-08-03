#!/usr/bin/env python3

from __future__ import annotations

import pytest


CASES = [
    "cases/test_errors.py",
    "cases/test_error_code_mapping.py",
    "cases/test_cli_comprehensive.py::test_cli_exit_code",
    "cases/test_cli_comprehensive.py::test_cli_nonexistent_command",
    "cases/test_node_coverage.py::test_node_errors",
    "cases/test_go_coverage.py::test_go_errors",
    "cases/test_c_coverage.py::test_c_errors",
]


class SkipGate:
    def __init__(self) -> None:
        self.skipped: list[str] = []

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if report.skipped and not hasattr(report, "wasxfail"):
            self.skipped.append(report.nodeid)


def main() -> int:
    gate = SkipGate()
    result = pytest.main(["-v", *CASES], plugins=[gate])
    if gate.skipped:
        print("\nRelease error-contract validation skipped required SDK coverage:")
        for nodeid in gate.skipped:
            print(f"- {nodeid}")
        return 1
    return int(result)


if __name__ == "__main__":
    raise SystemExit(main())
