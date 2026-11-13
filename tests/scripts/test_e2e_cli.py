"""Exercise E2E callers through the real CLI and its HTTP boundary, without VMs."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


class CliE2EInvocationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cli = os.environ.get("BOXLITE_E2E_CLI", str(ROOT / "target/debug/boxlite"))
        if not Path(cls.cli).is_file():
            raise unittest.SkipTest("build the CLI or set BOXLITE_E2E_CLI")
        try:
            import boxlite  # noqa: F401
            import pytest
            import pytest_asyncio  # noqa: F401
        except ImportError as error:
            raise unittest.SkipTest(f"E2E Python dependencies required: {error}")
        cls.pytest = pytest
        paths = list(sys.path)
        cls.addClassCleanup(lambda: sys.path.__setitem__(slice(None), paths))
        sys.path.insert(0, str(ROOT / "apps/e2e/cases"))
        cls.comprehensive, cls.detach, cls.entry = [
            importlib.import_module(name) for name in (
                "test_cli_comprehensive", "test_cli_detach_recovery", "test_cli_entry"
            )
        ]
        cls.modules = (cls.comprehensive, cls.detach, cls.entry)

    def setUp(self):
        self.requests = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(("POST", self.path, body))
                self.respond(400, "create rejected by regression endpoint")

            def do_GET(self):
                requests.append(("GET", self.path, None))
                self.respond(404, "box not found")

            def do_DELETE(self):
                requests.append(("DELETE", self.path, None))
                self.respond(404, "box not found")

            def respond(self, status, message):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {
                    "code": "NOT_FOUND" if status == 404 else "INVALID_ARGUMENT",
                    "message": message,
                }}).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        home = self.enterContext(tempfile.TemporaryDirectory())
        environment = {k: v for k, v in os.environ.items() if not k.startswith("BOXLITE_")}
        environment.update(
            BOXLITE_HOME=home,
            BOXLITE_API_KEY="local-regression-key",
            BOXLITE_REST_URL=f"http://127.0.0.1:{server.server_port}",
        )
        self.enterContext(patch.dict(os.environ, environment, clear=True))

    def test_detached_callers_send_sleep_as_the_executable(self):
        callers = [
            (lambda cli: next(self.comprehensive.detached_box.__wrapped__(cli)), "600"),
            (self.comprehensive.test_cli_run_with_name, "300"),
            (self.detach.test_detached_box_survives_cli_exit_and_is_reusable, "300"),
            (self.detach.test_detached_box_exec_propagates_exit_code_on_fresh_cli, "300"),
            (self.entry.test_cli_run_exec_chain, "300"),
            (self.entry.test_cli_exec_exit_code_propagates, "300"),
        ]
        for caller, duration in callers:
            with self.subTest(caller=caller.__name__):
                self.requests.clear()
                with self.assertRaises((AssertionError, subprocess.CalledProcessError,
                                        self.pytest.skip.Exception)):
                    caller(self.cli)
                creates = [body for method, _, body in self.requests if method == "POST"]
                self.assertEqual(len(creates), 1)
                self.assertEqual(creates[0]["cmd"], ["sleep", duration])

    def test_checked_failures_expose_the_real_cli_diagnostic(self):
        for module in self.modules:
            with self.subTest(module=module.__name__):
                unchecked = module.run(self.cli, "--e2e-invalid-option", check=False)
                self.assertEqual(unchecked.returncode, 2)
                self.assertIn("unexpected argument", unchecked.stderr)
                with self.assertRaises((AssertionError, subprocess.CalledProcessError)) as failure:
                    module.run(self.cli, "--e2e-invalid-option")
                self.assertIn(unchecked.stderr, str(failure.exception))
                self.assertIn("stdout:", str(failure.exception))

    def test_success_keeps_stdout(self):
        for module in self.modules:
            with self.subTest(module=module.__name__):
                result = module.run(self.cli, "--help")
                self.assertEqual(result.returncode, 0)
                self.assertIn("Usage:", result.stdout)

    def test_named_creation_failure_is_not_skipped_and_cleans_up_by_name(self):
        names = []
        for _ in range(2):
            self.requests.clear()
            try:
                self.comprehensive.test_cli_run_with_name(self.cli)
            except (AssertionError, subprocess.CalledProcessError, self.pytest.skip.Exception) as error:
                self.assertNotIsInstance(error, self.pytest.skip.Exception)
                self.assertIn("create rejected by regression endpoint", str(error))
            else:
                self.fail("rejected creation must fail the case")
            name = self.requests[0][2]["name"]
            names.append(name)
            self.assertTrue(any(name in path for method, path, _ in self.requests
                                if method in ("GET", "DELETE")))
        self.assertNotEqual(*names)
