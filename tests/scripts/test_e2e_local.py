"""Exercise the Compose launcher's pure configuration boundaries."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("e2e_local", ROOT / "apps/e2e/local.py")
local = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local)


class LocalE2ETest(unittest.TestCase):
    def test_compose_declares_all_dependency_services(self):
        compose = (local.E2E / "compose.yaml").read_text()
        for service in ("postgres", "redis", "registry", "dex", "minio"):
            self.assertIn(f"  {service}:", compose)

    def test_environment_is_loopback_and_uses_the_fixed_local_credentials(self):
        env = local.base_env()
        self.assertTrue(env["BOXLITE_E2E_API_URL"].startswith("http://127.0.0.1:"))
        self.assertEqual(env["PGPASSWORD"], local.POSTGRES_PASSWORD)
        self.assertEqual(env["POSTGRES_PASSWORD"], local.POSTGRES_PASSWORD)
        self.assertEqual(env["MINIO_PASSWORD"], local.MINIO_PASSWORD)
        self.assertEqual(env["S3_SECRET_KEY"], local.MINIO_PASSWORD)
        self.assertEqual(env["BOXLITE_HOME"], str(local.STATE / "client-home"))


if __name__ == "__main__":
    unittest.main()
