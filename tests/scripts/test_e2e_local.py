"""Exercise the Compose launcher's pure configuration boundaries."""
import importlib.util
from pathlib import Path
import tempfile
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


    def test_owned_process_is_scoped_to_this_checkout(self):
        home = str(local.RUNTIME_HOME)
        self.assertTrue(local.owned_process([f"{home}/boxes/abc/bin/boxlite-shim"]))
        self.assertTrue(local.owned_process(["/usr/bin/bwrap", f"{home}/boxes/abc/tmp"]))
        self.assertFalse(local.owned_process(["/tmp/elsewhere/boxes/abc/bin/boxlite-shim"]))
        self.assertFalse(local.owned_process([f"{home}/boxes/abc/bin/python3"]))
        self.assertFalse(local.owned_process([]))

    def test_prune_box_dirs_removes_only_box_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            boxes = home / "boxes"
            (boxes / "a").mkdir(parents=True)
            (boxes / "b").mkdir()
            (boxes / "stray-file").write_text("keep")
            images = home / "images"
            images.mkdir()

            removed = local.prune_box_dirs(local.box_dirs(home))

            self.assertEqual(removed, 2)
            self.assertEqual([p.name for p in boxes.iterdir()], ["stray-file"])
            self.assertTrue(images.is_dir())
            self.assertEqual(local.prune_box_dirs(local.box_dirs(home)), 0)


if __name__ == "__main__":
    unittest.main()
