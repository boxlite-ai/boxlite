"""Verify what a local API passes to the public and Supervisor sides of an App."""

from pathlib import Path
import os
from tempfile import TemporaryDirectory
import unittest

from compose import cloud_apps


class CloudAppStartup(unittest.TestCase):
    def test_restart_reuses_local_identity_and_preserves_injected_settings(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / ".apps-local"
            first = cloud_apps.environment(state, 3011, {"BOXLITE_HOST_HUB": "guest-host"})
            again = cloud_apps.environment(state, 3011, {"CLOUD_APP_SOURCE_BUCKET": "supplied"})
            self.assertEqual(first["CLOUD_APP_PROCESS_ROLE"], "worker")
            self.assertEqual(first["CLOUD_APP_PUBLIC_URL"], "http://localhost:3011/api/internal/apps")
            self.assertEqual(first["CLOUD_APP_SUPERVISOR_URL"], "http://guest-host:3011/api/internal/apps")
            self.assertEqual(first["CLOUD_APP_SESSION_SECRET"], again["CLOUD_APP_SESSION_SECRET"])
            self.assertEqual(first["CLOUD_APP_IDENTITY_PRIVATE_KEY"], again["CLOUD_APP_IDENTITY_PRIVATE_KEY"])
            self.assertIn("BEGIN PRIVATE KEY", first["CLOUD_APP_IDENTITY_PRIVATE_KEY"])
            self.assertEqual(os.stat(state / "cloud-app-credentials.json").st_mode & 0o777, 0o600)
            self.assertNotIn("CLOUD_APP_SOURCE_BUCKET", again)
