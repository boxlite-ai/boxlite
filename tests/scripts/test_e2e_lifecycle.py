"""Exercise actual child processes and environment ownership boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("e2e_manage", ROOT / "apps/e2e/manage.py")
manage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manage)


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.settings = patch.dict(os.environ, {"BOXLITE_E2E_STATE_DIR": self.scratch.name})
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.environment = manage.Environment()
        self.environment.initialize("check")

    def test_failed_child_preserves_its_exit_and_diagnostic(self):
        with self.assertRaises(manage.Failure) as failure:
            self.environment.command([sys.executable, "-c", "import sys; print('child failure'); sys.exit(7)"])
        self.assertEqual(failure.exception.code, 7)
        self.assertIn("child failure", (self.environment.run_dir / "commands.log").read_text())

    def test_timeout_stops_real_child_and_preserves_evidence(self):
        marker = Path(self.scratch.name) / "child.pid"
        program = "import os,pathlib,time; pathlib.Path(__import__('sys').argv[1]).write_text(str(os.getpid())); time.sleep(30)"
        with self.assertRaises(manage.Failure) as failure:
            self.environment.command([sys.executable, "-c", program, str(marker)], timeout=0.5)
        self.assertEqual(failure.exception.code, 124)
        pid = int(marker.read_text())
        result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
        self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))

    def test_live_state_lock_refuses_second_owner(self):
        other = manage.Environment()
        with self.environment.locked():
            with self.assertRaises(manage.Failure) as failure:
                with other.locked():
                    self.fail("second environment acquired the lock")
        self.assertEqual(failure.exception.code, 2)
        with other.locked():
            pass

    def test_foreign_container_is_refused(self):
        with self.assertRaisesRegex(manage.Failure, "ownership conflict"):
            self.environment.assert_owner({"Name": "unrelated", "Config": {"Labels": {"boxlite.e2e.state": "/someone/else"}}})

    def test_dependency_cache_reinstalls_only_when_sentinel_missing(self):
        scratch = Path(self.scratch.name)
        self.environment.python = str(scratch / "missing-python")
        calls = []

        def fake_make(target):
            calls.append(target)
            sentinel = {"test:e2e:deps:apps": "apps/node_modules/.bin/ts-node",
                        "test:e2e:deps:node": "sdks/node/node_modules/.bin/napi"}.get(target)
            if sentinel:
                (scratch / sentinel).parent.mkdir(parents=True, exist_ok=True)
                (scratch / sentinel).write_text("")

        with patch.object(manage, "ROOT", scratch), \
                patch.object(self.environment, "fingerprint", side_effect=lambda prefixes: "id"), \
                patch.object(self.environment, "capture", side_effect=lambda argv, **kwargs: ""), \
                patch.object(self.environment, "make", side_effect=fake_make):
            self.environment.prepare_dependencies()
            self.assertEqual(calls, ["test:e2e:deps", "test:e2e:deps:apps", "test:e2e:deps:node"])
            calls.clear()
            self.environment.prepare_dependencies()
            self.assertEqual(calls, ["test:e2e:deps"])
            calls.clear()
            (scratch / "apps/node_modules/.bin/ts-node").unlink()
            (scratch / "sdks/node/node_modules/.bin/napi").unlink()
            self.environment.prepare_dependencies()
            self.assertEqual(calls, ["test:e2e:deps", "test:e2e:deps:apps", "test:e2e:deps:node"])

    def test_recipe_identity_tracks_recipes_flags_and_toolchain(self):
        scratch = Path(self.scratch.name)
        makefile = scratch / "make/build.mk"
        makefile.parent.mkdir(parents=True)
        makefile.write_text("cli:\n\tcargo build -p boxlite-cli\n")
        script = scratch / "scripts/build/build-runtime.sh"
        script.parent.mkdir(parents=True)
        script.write_text("echo build\n")
        tool_version = "1"

        def fake_capture(argv, **kwargs):
            if argv[:2] == ["git", "ls-files"]:
                return "make/build.mk\0scripts/build/build-runtime.sh\0"
            if argv[0] == "rustc" and argv[-1] == "--version":
                return "rustc 1.90.0"
            return f"{' '.join(argv)} v{tool_version}"

        with patch.object(manage, "ROOT", scratch), \
                patch.object(self.environment, "capture", side_effect=fake_capture), \
                patch.object(manage.shutil, "which", return_value="/usr/bin/tool"):
            first = self.environment.recipe_identity()
            makefile.write_text("cli:\n\tcargo build --release -p boxlite-cli\n")
            self.assertNotEqual(first, self.environment.recipe_identity())
            makefile.write_text("cli:\n\tcargo build -p boxlite-cli\n")
            self.environment.env["RUSTFLAGS"] = "-C target-cpu=native"
            self.assertNotEqual(first, self.environment.recipe_identity())
            self.environment.env.pop("RUSTFLAGS")
            self.assertEqual(first, self.environment.recipe_identity())
            tool_version = "2"
            self.assertNotEqual(first, self.environment.recipe_identity())

    def test_credential_identity_tracks_generation_and_dex_config(self):
        secrets = self.environment.state / "secrets.json"
        secrets.write_text(json.dumps({"generation": "one"}))
        first = self.environment.credential_identity("postgres")
        secrets.write_text(json.dumps({"generation": "two"}))
        self.assertNotEqual(first, self.environment.credential_identity("postgres"))
        config = self.environment.state / "dex.yaml"
        config.write_text("issuer: one\n")
        first = self.environment.credential_identity("dex")
        config.write_text("issuer: two\n")
        self.assertNotEqual(first, self.environment.credential_identity("dex"))

    def test_dependency_recreates_postgres_volume_when_credentials_change(self):
        self.environment.env["PGPASSWORD"] = "new-password"
        (self.environment.state / "secrets.json").write_text(json.dumps({"generation": "new"}))
        name = f"{self.environment.prefix}-postgres"
        stale = {
            "Name": f"/{name}",
            "State": {"Running": True},
            "Config": {"Labels": {
                "boxlite.e2e.state": str(self.environment.state),
                "boxlite.e2e.image": manage.IMAGES["postgres"],
                "boxlite.e2e.credentials": "stale",
            }},
            "HostConfig": {"PortBindings": {
                "5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.environment.ports["POSTGRES"])}],
            }},
        }
        calls = []

        def fake_capture(argv, **kwargs):
            if argv[:3] == ["docker", "container", "inspect"]:
                return subprocess.CompletedProcess(argv, 0, json.dumps([stale]), "")
            if argv[:3] == ["docker", "image", "inspect"]:
                return subprocess.CompletedProcess(argv, 0, json.dumps([{"Id": "sha256:image"}]), "")
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, "", "")

        with patch.object(self.environment, "capture", side_effect=fake_capture):
            self.environment.dependency("postgres")

        self.assertIn(["docker", "rm", "-f", name], calls)
        self.assertIn(["docker", "volume", "rm", "-f", name], calls)
        run = next(argv for argv in calls if argv[:2] == ["docker", "run"])
        self.assertIn(f"boxlite.e2e.credentials={self.environment.credential_identity('postgres')}", run)

    def test_status_rejects_a_foreign_container(self):
        foreign = {"Name": "/foreign", "State": {"Running": True},
                   "Config": {"Labels": {"boxlite.e2e.state": "/somewhere/else"}}}
        with patch.object(self.environment, "container", return_value=foreign):
            with self.assertRaisesRegex(manage.Failure, "ownership conflict"):
                self.environment.status()

    def test_non_venv_interpreter_is_rejected(self):
        root = Path(self.scratch.name) / "not-a-venv"
        (root / "bin").mkdir(parents=True)
        (root / "bin/python").symlink_to(sys.executable)
        with patch.dict(os.environ, {"E2E_PYTHON": str(root / "bin/python")}):
            with self.assertRaisesRegex(manage.Failure, "virtual environment"):
                manage.Environment()


if __name__ == "__main__":
    unittest.main()
