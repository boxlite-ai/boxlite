"""Cloud credential setup crosses the metadata and credential-file boundaries."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import tomllib
import unittest
from unittest.mock import patch
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps/e2e"))
import configure_cloud_profiles as cloud
from lib import e2e_auth


class CloudProfilesTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.destination = Path(self.scratch.name) / "boxlite/credentials.toml"
        self.environment = {
            "BOXLITE_DEV_API_KEY": "key-one",
            "BOXLITE_DEV_P2_API_KEY": 'key-two"quoted',
            "BOXLITE_DEV_P2_READONLY_API_KEY": "key-readonly",
            "BOXLITE_PROD_API_KEY": "key-prod",
        }
        self.metadata = {
            "key-one": ("org-one", ["write:boxes", "delete:boxes"]),
            'key-two"quoted': ("org-two", ["write:boxes", "delete:boxes"]),
            "key-readonly": ("org-two", ["read:images"]),
            "key-prod": ("org-prod", ["write:boxes", "delete:boxes"]),
        }
        self.requests = []
        self.output = io.StringIO()

    def open_metadata(self, request, *, timeout):
        self.assertEqual(timeout, 15)
        key = request.get_header("Authorization").removeprefix("Bearer ")
        self.requests.append((request.full_url, key))
        org, permissions = self.metadata[key]
        body = {"path_prefix": org} if request.full_url.endswith("/v1/me") else {"permissions": permissions}
        return io.BytesIO(json.dumps(body).encode())

    def configure(self, stage="dev", url="https://api.example/api/"):
        with patch.object(e2e_auth.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = self.open_metadata
            with redirect_stdout(self.output):
                cloud.configure(stage, url, self.environment, self.destination)

    def test_dev_profiles_are_private_and_serialize_credentials_safely(self):
        self.configure()
        profiles = tomllib.loads(self.destination.read_text())["profiles"]
        self.assertEqual(set(profiles), {"p1", "p2", "p2_readonly"})
        self.assertEqual(profiles["p2"]["api_key"], self.environment["BOXLITE_DEV_P2_API_KEY"])
        self.assertEqual(profiles["p2_readonly"]["path_prefix"], "org-two")
        self.assertEqual(profiles["p1"]["url"], "https://api.example/api")
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.destination.parent.stat().st_mode & 0o777, 0o700)
        for key in self.environment.values():
            self.assertNotIn(key, self.output.getvalue())

    def test_prod_never_uses_dev_credentials(self):
        self.environment = {"BOXLITE_PROD_API_KEY": "key-prod"}
        self.configure("prod")
        self.assertEqual(set(tomllib.loads(self.destination.read_text())["profiles"]), {"p1"})
        self.assertEqual({key for _, key in self.requests}, {"key-prod"})

    def test_each_missing_dev_secret_fails_before_network_or_file_writes(self):
        for name in list(self.environment):
            if not name.startswith("BOXLITE_DEV"):
                continue
            with self.subTest(secret=name):
                key = self.environment.pop(name)
                try:
                    with self.assertRaisesRegex(RuntimeError, name):
                        self.configure()
                    self.assertEqual(self.requests, [])
                    self.assertFalse(self.destination.exists())
                finally:
                    self.environment[name] = key

    def test_invalid_targets_are_rejected_before_credentials_are_sent(self):
        for stage, url in [("typo", "https://api.example"), ("dev", "http://api.example"),
                           ("dev", "https://user:password@api.example"), ("dev", "https://api.example?x=1")]:
            with self.subTest(stage=stage, url=url), self.assertRaises(RuntimeError):
                self.configure(stage, url)
        self.assertEqual(self.requests, [])

    def test_identity_errors_preserve_existing_file(self):
        self.destination.parent.mkdir()
        self.destination.write_text("existing profiles")
        failures = [
            ("key-one", ("org-two", ["write:boxes", "delete:boxes"]), "different organizations"),
            ("key-readonly", ("org-other", []), "same organization"),
            ("key-readonly", ("org-two", ["write:boxes"]), "only read permissions"),
            ("key-one", ("org-one", ["write:boxes"]), "delete:boxes"),
            ("key-one", ("", []), "nonempty organization"),
            ("key-one", ("org-one", None), "invalid permissions"),
        ]
        for key, value, reason in failures:
            with self.subTest(reason=reason), patch.dict(self.metadata, {key: value}):
                with self.assertRaisesRegex(RuntimeError, reason):
                    self.configure()
                self.assertEqual(self.destination.read_text(), "existing profiles")
                self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_atomic_replace_failure_keeps_old_profiles_and_removes_temporary_key_copy(self):
        self.destination.parent.mkdir()
        self.destination.write_text("existing profiles")
        with patch.object(cloud.os, "replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.configure()
        self.assertEqual(self.destination.read_text(), "existing profiles")
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_http_error_does_not_echo_secret_response_body(self):
        error = urllib.error.HTTPError("https://api.example", 401, "Unauthorized", {}, io.BytesIO(b"secret"))
        with patch.object(e2e_auth.urllib.request, "build_opener") as build, \
                patch.object(e2e_auth.urllib.request, "urlopen", side_effect=error):
            build.return_value.open.side_effect = error
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as raised:
                e2e_auth.discover_path_prefix("https://api.example", "secret")
        self.assertNotIn("secret", str(raised.exception))

    def test_metadata_redirect_does_not_forward_credentials(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/stolen")
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            with patch.object(e2e_auth.urllib.request, "_opener", None):
                with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
                    e2e_auth.discover_path_prefix(f"http://127.0.0.1:{server.server_port}", "secret")
            self.assertEqual(requests, ["/v1/me"])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
