"""Exercise the Compose launcher's pure configuration boundaries."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("e2e_local", ROOT / "apps/e2e/local.py")
local = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local)


class LocalE2ETest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state"
        self.state.mkdir()
        self.patcher = patch.object(local, "STATE", self.state)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_compose_declares_all_dependency_services(self):
        compose = (local.E2E / "compose.yaml").read_text()
        for service in ("postgres", "redis", "registry", "dex", "minio"):
            self.assertIn(f"  {service}:", compose)

    def test_environment_has_persistent_unpredictable_credentials_and_loopback_binding(self):
        env = local.base_env()
        self.assertTrue(env["BOXLITE_E2E_API_URL"].startswith("http://127.0.0.1:"))
        self.assertEqual(env.get("BOXLITE_LISTEN_HOST"), "127.0.0.1")
        self.assertNotEqual(env["ADMIN_API_KEY"], "e2e-admin-key")
        self.assertEqual(env["ADMIN_API_KEY"], local.base_env()["ADMIN_API_KEY"])
        self.assertEqual(env["PGPASSWORD"], env["POSTGRES_PASSWORD"])
        self.assertEqual(env["S3_SECRET_KEY"], env["MINIO_PASSWORD"])
        self.assertEqual(env["BOXLITE_HOME"], str(local.STATE / "client-home"))
        with patch.object(local, "STATE", self.state / "other"):
            self.assertNotEqual(env["ADMIN_API_KEY"], local.base_env()["ADMIN_API_KEY"])

    def test_status_cannot_observe_truncated_pid_records(self):
        local.save_pids({"api": {"pid": 123, "starttime": "456"}})
        original = Path.write_text
        observations = []

        def observe(path, text, *args, **kwargs):
            result = original(path, text, *args, **kwargs)
            observations.append(local.load_pids())
            return result

        with patch.object(Path, "write_text", observe):
            local.save_pids({})
        self.assertEqual(observations, [{"api": {"pid": 123, "starttime": "456"}}])
        self.assertEqual(local.load_pids(), {})

    def test_startup_failure_unwinds_new_resources(self):
        events = []
        def fake_compose(args, env):
            events.append(tuple(args))
        with patch.object(local, "write_files"), patch.object(local, "build"), \
                patch.object(local, "compose", side_effect=fake_compose), \
                patch.object(local, "compose_services", create=True, return_value=set()), \
                patch.object(local, "wait_dependencies"), patch.object(local, "create_bucket"), \
                patch.object(local, "start", side_effect=local.Failure("readiness")), \
                patch.object(local, "stop_host") as stop, \
                patch.object(local, "stop_orphaned_boxes", return_value=[]), \
                patch.object(local, "prune_box_dirs"):
            with self.assertRaisesRegex(local.Failure, "readiness"):
                local.up({})
        self.assertIn(("down",), events)
        stop.assert_called()

    def test_build_failure_does_not_stop_existing_stack(self):
        with patch.object(local, "write_files"), \
                patch.object(local, "build", side_effect=local.Failure("build")), \
                patch.object(local, "stop_host") as stop, \
                patch.object(local, "compose") as compose:
            with self.assertRaisesRegex(local.Failure, "build"):
                local.up({})
        stop.assert_not_called()
        compose.assert_not_called()

    def test_foreign_state_is_rejected_before_teardown(self):
        coordination = self.state / "coordination"
        # Use the existing lock boundary; no production API adapter is needed.
        with local.stack_lock(coordination):
            local.write_files()
        with patch.object(local, "STATE", self.state / "other"):
            with self.assertRaises(local.Failure):
                with local.stack_lock(coordination):
                    pass

    def test_foreign_checkout_is_rejected_after_owner_command_exits(self):
        coordination = self.state / "coordination"
        with local.stack_lock(coordination):
            pass
        with patch.object(local, "ROOT", self.state / "checkout-b"):
            with self.assertRaises(local.Failure):
                with local.stack_lock(coordination):
                    pass

    def test_startup_interruption_preserves_existing_dependencies(self):
        events = []
        with patch.object(local, "write_files"), patch.object(local, "build"), \
                patch.object(local, "compose_services", create=True, return_value={"postgres"}), \
                patch.object(local, "compose", side_effect=lambda args, env: events.append(args)), \
                patch.object(local, "wait_dependencies", side_effect=KeyboardInterrupt), \
                patch.object(local, "stop_host"), \
                patch.object(local, "stop_orphaned_boxes", return_value=[]):
            with self.assertRaises(KeyboardInterrupt):
                local.up({})
        self.assertNotIn(["down"], events)
        removed = [args for args in events if args[:3] == ["rm", "-s", "-f"]]
        self.assertEqual(len(removed), 1)
        self.assertNotIn("postgres", removed[0])


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
            "python3": str(Path(subprocess.check_output(
                ["sh", "-c", "command -v python3"], text=True).strip()).absolute()),
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
        self.assertIn(f'{local.ROOT}/target/e2e-rel', out)
        out = self.run_make("-n", "test:e2e:build:proxies", "E2E_STATE_DIR=target/e2e-rel")
        self.assertIn(f'"{local.ROOT}/target/e2e-rel/bin/proxy"', out)
        self.assertIn(f'"{local.ROOT}/target/e2e-rel/bin/registry-proxy"', out)

    def test_command_line_state_dir_overrides_inherited_environment(self):
        env = dict(os.environ, BOXLITE_E2E_STATE_DIR="/stale/e2e-state")
        with tempfile.TemporaryDirectory() as tmp:
            helper = Path(tmp) / "helper.mk"
            helper.write_text("print-e2e-state:\n\t@echo V=$$BOXLITE_E2E_STATE_DIR\n")
            out = self.run_make(
                "-f", "Makefile", "-f", str(helper),
                "print-e2e-state", "E2E_STATE_DIR=target/e2e-rel", env=env)
        self.assertIn("V=target/e2e-rel", out)

    def fixture_project(self, root):
        (root / "apps/runner").mkdir(parents=True)
        (root / "apps/e2e").mkdir()
        for name in ("build_runner.py", "python_env.py"):
            source = local.E2E / name
            if source.exists():
                shutil.copyfile(source, root / "apps/e2e" / name)
        shutil.copyfile(local.E2E / "dependencies.json", root / "apps/e2e/dependencies.json")
        (root / "Makefile").write_text(
            f"PROJECT_ROOT := {root}\ninclude {ROOT / 'make/test.mk'}\n")

    def test_native_archive_changes_invalidate_runner_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture_project(root)
            archive = root / "target/debug/libboxlite.a"
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b"native-v1")
            tools = root / "tools"
            tools.mkdir()
            go = tools / "go"
            go.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GO_LOG\"\n")
            go.chmod(0o755)
            log = root / "go.log"
            env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}", GO_LOG=str(log))
            def build():
                result = subprocess.run(
                    ["make", "test:e2e:build:runner", f"E2E_STATE_DIR={root / 'state'}"],
                    cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return log.read_text().splitlines()[-1]
            first = build()
            unchanged = build()
            archive.write_bytes(b"native-v2")
            changed = build()
            self.assertIn(" -a ", f" {first} ")
            self.assertNotIn(" -a ", f" {unchanged} ")
            self.assertIn(" -a ", f" {changed} ")

    def test_bare_virtualenv_interpreter_works_through_make_command_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture_project(root)
            tools = root / "venv/bin"
            tools.mkdir(parents=True)
            (tools.parent / "pyvenv.cfg").write_text("test virtual environment")
            python = tools / "e2e-python"
            python.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PYTHON_LOG\"\n")
            python.chmod(0o755)
            log = root / "python.log"
            env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}", PYTHON_LOG=str(log))
            result = subprocess.run(
                ["make", "test:e2e:deps", "E2E_PYTHON=e2e-python"],
                cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("-m uv sync", log.read_text())

    @unittest.skipUnless(all(shutil.which(tool) for tool in ("go", "gcc", "ar")),
                         "real CGO link check requires go, gcc and ar")
    def test_runner_executes_changed_native_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture_project(root)
            main = root / "apps/runner/cmd/runner"
            main.mkdir(parents=True)
            (root / "apps/runner/go.mod").write_text("module e2e-link-check\n\ngo 1.24\n")
            (main / "main.go").write_text(
                'package main\n/*\n'
                '#cgo LDFLAGS: ${SRCDIR}/../../../../target/debug/libboxlite.a\n'
                'int native(void);\n*/\nimport "C"\nimport "fmt"\n'
                'func main() { fmt.Println(C.native()) }\n')
            native = root / "target/debug"
            native.mkdir(parents=True)
            env = dict(os.environ, GOWORK="off", GOPROXY="off")
            for value in (1, 2):
                source = native / "native.c"
                source.write_text(f"int native(void) {{ return {value}; }}\n")
                subprocess.run(["gcc", "-c", str(source), "-o", str(native / "native.o")],
                               env=env, check=True)
                subprocess.run(["ar", "rcs", str(native / "libboxlite.a"), str(native / "native.o")],
                               env=env, check=True)
                result = subprocess.run(
                    ["make", "test:e2e:build:runner", f"E2E_STATE_DIR={root / 'state'}"],
                    cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = subprocess.check_output([str(root / "state/bin/runner")], text=True)
                self.assertEqual(output.strip(), str(value),
                                 "Runner still executes the previous native archive")


if __name__ == "__main__":
    unittest.main()
