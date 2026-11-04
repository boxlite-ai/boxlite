"""Exercise the Compose launcher's pure configuration boundaries."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
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

    def test_stack_lock_is_exclusive_and_released_on_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with local.stack_lock(home):
                with self.assertRaises(local.Failure):
                    with local.stack_lock(home):
                        pass
            with local.stack_lock(home):
                pass

    def test_python_env_resolves_relative_paths_against_the_repo_root(self):
        script = (
            "import importlib.util, sys;"
            "spec = importlib.util.spec_from_file_location('e2e_local', sys.argv[1]);"
            "module = importlib.util.module_from_spec(spec);"
            "spec.loader.exec_module(module);"
            "print(module.PYTHON)")
        cases = {
            None: str(local.ROOT / ".venv-e2e/bin/python"),
            "python3.11": "python3.11",
            "/opt/venv/bin/python": "/opt/venv/bin/python",
            "tools/venv/bin/python": str(local.ROOT / "tools/venv/bin/python"),
        }
        for raw, expected in cases.items():
            env = dict(os.environ)
            env.pop("E2E_PYTHON", None)
            if raw is not None:
                env["E2E_PYTHON"] = raw
            printed = subprocess.run(
                [sys.executable, "-c", script, str(local.E2E / "local.py")],
                env=env, cwd=local.ROOT, capture_output=True, text=True,
                check=True).stdout.strip()
            self.assertEqual(printed, expected, f"E2E_PYTHON={raw!r}")


class E2EMakefileTest(unittest.TestCase):
    """Regressions for the make wiring consumed by apps/e2e/local.py."""

    def run_make(self, *argv, env=None):
        return subprocess.run(
            ["make", "--no-print-directory", *argv], cwd=local.ROOT,
            env=env, capture_output=True, text=True, check=True).stdout

    def test_relative_state_dir_builds_into_repo_root_paths(self):
        out = self.run_make("-n", "test:e2e:build:runner", "E2E_STATE_DIR=target/e2e-rel")
        self.assertIn(f'"{local.ROOT}/target/e2e-rel/bin/runner"', out)
        out = self.run_make("-n", "test:e2e:build:proxies", "E2E_STATE_DIR=target/e2e-rel")
        self.assertIn(f'"{local.ROOT}/target/e2e-rel/bin/proxy"', out)
        self.assertIn(f'"{local.ROOT}/target/e2e-rel/bin/registry-proxy"', out)

    def test_command_line_state_dir_overrides_inherited_environment(self):
        env = dict(os.environ, BOXLITE_E2E_STATE_DIR="/stale/e2e-state")
        out = self.run_make(
            "--eval", "print-e2e-state:\n\t@echo V=$$BOXLITE_E2E_STATE_DIR",
            "print-e2e-state", "E2E_STATE_DIR=target/e2e-rel", env=env)
        self.assertIn("V=target/e2e-rel", out)


if __name__ == "__main__":
    unittest.main()
