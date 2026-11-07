"""Exercise the real S3 client/signing/error parser against a local HTTP peer."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from compose.config import InfraConfig
from compose.storage import ensure_bucket


class StorageBootstrap(unittest.TestCase):
    def serve(self, responses):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def handle_request(self):
                requests.append((self.command, self.path, self.headers.get("Authorization", "")))
                status, code = responses.pop(0)
                body = f"<Error><Code>{code}</Code><Message>remote secret</Message></Error>".encode() if code else b""
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            do_HEAD = handle_request
            do_PUT = handle_request

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.addCleanup(cleanup)
        return InfraConfig(minio_host_port=server.server_port), requests

    def test_existing_bucket_only_checks_access(self):
        cfg, requests = self.serve([(200, None)])
        ensure_bucket(cfg)
        self.assertEqual([(verb, path) for verb, path, _ in requests], [("HEAD", "/boxlite")])
        self.assertTrue(requests[0][2].startswith("AWS4-HMAC-SHA256 "))

    def test_missing_bucket_is_created_then_verified(self):
        cfg, requests = self.serve([(404, None), (200, None), (200, None)])
        ensure_bucket(cfg)
        self.assertEqual([verb for verb, _, _ in requests], ["HEAD", "PUT", "HEAD"])

    def test_owned_create_race_is_rechecked(self):
        cfg, requests = self.serve([(404, None), (409, "BucketAlreadyOwnedByYou"), (200, None)])
        ensure_bucket(cfg)
        self.assertEqual(len(requests), 3)

    def test_forbidden_bucket_does_not_attempt_creation(self):
        cfg, requests = self.serve([(403, None)])
        with self.assertRaisesRegex(RuntimeError, "bootstrap failed") as failure:
            ensure_bucket(cfg)
        self.assertEqual(len(requests), 1)
        self.assertNotIn(cfg.minio_password, str(failure.exception))

    def test_foreign_create_conflict_is_not_success(self):
        cfg, requests = self.serve([(404, None), (409, "BucketAlreadyExists")])
        with self.assertRaisesRegex(RuntimeError, "bootstrap failed") as failure:
            ensure_bucket(cfg)
        self.assertEqual(len(requests), 2)
        self.assertNotIn("remote secret", str(failure.exception))

    def test_retry_exhaustion_is_a_failure(self):
        cfg, requests = self.serve([(503, "ServiceUnavailable"), (503, "ServiceUnavailable")])
        with self.assertRaisesRegex(RuntimeError, "bootstrap failed"):
            ensure_bucket(cfg)
        self.assertEqual(len(requests), 2)
