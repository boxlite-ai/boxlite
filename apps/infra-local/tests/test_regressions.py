"""Startup regressions at the SDK, process, and make boundaries; no VMs."""

import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from compose import _local_arm64, native, orchestrator, services
from compose.config import InfraConfig


def info(name, status):
    return SimpleNamespace(name=f"boxlite-local-{name}", state=SimpleNamespace(status=status))


class StartupRegressions(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.cfg = InfraConfig(repo_root=root, data_dir=root / "data", boxlite_home=root / "home")

    async def test_failed_postgres_does_not_skip_l1_reconciliation(self):
        runtime = SimpleNamespace(list_info=AsyncMock(return_value=[info("postgres", "failed")]))
        with patch.object(orchestrator, "get_runtime", return_value=runtime), patch.object(
            orchestrator, "up", new=AsyncMock(return_value=True)
        ) as up:
            self.assertTrue(await native._ensure_l1_async(self.cfg))
        up.assert_awaited_once_with(self.cfg, services.SERVICES)

    async def test_running_postgres_does_not_hide_missing_dependencies(self):
        runtime = SimpleNamespace(list_info=AsyncMock(return_value=[info("postgres", "running")]))
        with patch.object(orchestrator, "get_runtime", return_value=runtime), patch.object(
            orchestrator, "up", new=AsyncMock(return_value=True)
        ) as up:
            await native._ensure_l1_async(self.cfg)
        up.assert_awaited_once()

    async def test_failed_box_is_removed_before_starting_its_replacement(self):
        spec = services.ServiceSpec("redis", "redis:7-alpine")
        old = SimpleNamespace(info=AsyncMock(return_value=info("redis", "failed")), start=AsyncMock())
        replacement = SimpleNamespace(start=AsyncMock())
        runtime = SimpleNamespace(
            get_or_create=AsyncMock(side_effect=[(old, False), (replacement, True)]),
            remove=AsyncMock(),
        )
        with patch.object(orchestrator, "_build_box_options_with_volumes", return_value=object()):
            await orchestrator.start_service(runtime, spec, self.cfg)
        runtime.remove.assert_awaited_once_with("boxlite-local-redis", force=True)
        old.start.assert_not_awaited()
        replacement.start.assert_awaited_once()

    async def test_unhealthy_running_box_is_recreated_once(self):
        spec = services.ServiceSpec("redis", "redis:7-alpine", healthcheck=services.HealthCheck(exec=["redis-cli", "PING"], retries=1, interval_s=0))
        old = SimpleNamespace(info=AsyncMock(return_value=info("redis", "running")), start=AsyncMock())
        replacement = SimpleNamespace(start=AsyncMock())
        runtime = SimpleNamespace(get_or_create=AsyncMock(side_effect=[(old, False), (replacement, True)]), remove=AsyncMock())
        with patch.object(orchestrator, "_build_box_options_with_volumes", return_value=object()), patch.object(
            orchestrator, "exec_collect", new=AsyncMock(side_effect=[(1, "", "wedged"), (0, "PONG", "")])
        ):
            await orchestrator.start_service(runtime, spec, self.cfg)
        runtime.remove.assert_awaited_once_with("boxlite-local-redis", force=True)
        replacement.start.assert_awaited_once()

    async def test_reconciliation_propagates_new_box_health_failure(self):
        spec = services.ServiceSpec("redis", "redis:7-alpine", healthcheck=services.HealthCheck(exec=["redis-cli", "PING"], retries=1, interval_s=0))
        box = SimpleNamespace(start=AsyncMock())
        runtime = SimpleNamespace(get_or_create=AsyncMock(return_value=(box, True)))
        with patch.object(orchestrator, "_build_box_options_with_volumes", return_value=object()), patch.object(
            orchestrator, "exec_collect", new=AsyncMock(return_value=(1, "", "unavailable"))
        ):
            with self.assertRaises(TimeoutError):
                await orchestrator.start_service(runtime, spec, self.cfg)


class NativeRegressions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.cfg = InfraConfig(repo_root=root, data_dir=root / "data", boxlite_home=root / "home")
        self.p = native._paths(self.cfg)
        self.p.logs.mkdir(parents=True)

    def test_turnstile_template_is_opt_in_and_preserves_operator_widget(self):
        self.p.infra_local.mkdir(parents=True)
        (self.p.apps / "api").mkdir()
        template = Path(native.__file__).resolve().parents[1] / "api.env"
        shutil.copy(template, self.p.infra_local / "api.env")
        native._seed_api_env(self.p, "local/agent:test")
        api_env = self.p.apps / "api" / ".env"
        seeded = api_env.read_text()
        self.assertNotIn("TURNSTILE_SITEKEY=", seeded)
        self.assertNotIn("TURNSTILE_SECRET_KEY=", seeded)
        self.assertNotIn("TURNSTILE_EXPECTED_HOSTNAMES=", seeded)

        configured = {
            "TURNSTILE_SITEKEY": "operator-sitekey",
            "TURNSTILE_SECRET_KEY": "operator-secret",
            "TURNSTILE_EXPECTED_HOSTNAMES": "dev.example.test",
        }
        for key, value in configured.items():
            native._set_env_kv(api_env, key, value)
        native._seed_api_env(self.p, "local/agent:test")
        for key, value in configured.items():
            self.assertIn(f"{key}={value}\n", api_env.read_text())

    def test_existing_archive_still_runs_cargo_freshness_check(self):
        library = self.cfg.repo_root / "target/debug/libboxlite.a"
        library.parent.mkdir(parents=True)
        library.write_bytes(b"existing native archive")
        with patch.object(_local_arm64, "REPO", self.cfg.repo_root), patch.object(
            _local_arm64, "ensure_submodules"
        ), patch.object(_local_arm64, "ensure_shared_target"), patch.object(subprocess, "run") as run:
            _local_arm64.ensure_native_lib()
        self.assertTrue(any(call.args[0] == ["make", "dev:c"] for call in run.call_args_list))

    def test_existing_archive_without_go_preparation_is_prepared_before_linking(self):
        library = self.cfg.repo_root / "target/debug/libboxlite.a"
        library.parent.mkdir(parents=True)
        library.write_bytes(b"archive built by make dev:c")
        with patch.object(_local_arm64, "REPO", self.cfg.repo_root), patch.object(
            _local_arm64, "ensure_submodules"
        ), patch.object(_local_arm64, "ensure_shared_target"), patch.object(subprocess, "run") as run:
            _local_arm64.ensure_native_lib()
        self.assertTrue(any(call.args[0] == ["make", "dev:go", "SETUP_DONE=1"] for call in run.call_args_list))

    def test_native_build_uses_the_workspace_dependency_bootstrap(self):
        with patch.object(native, "_go_build"), patch.object(subprocess, "run") as run:
            native.build(self.cfg)
        self.assertTrue(any(call.args[0] == ["make", "_ensure-apps-deps"] for call in run.call_args_list))

    def test_unowned_port_is_a_conflict_and_is_never_killed(self):
        component = native._components(self.p)["api"]
        with patch.object(native, "_component_pid", return_value=None), patch.object(
            native, "_port_listening", return_value=True
        ), patch.object(os, "kill") as kill, patch.object(subprocess, "run"), patch.object(
            subprocess, "Popen", return_value=SimpleNamespace(pid=12345)
        ) as spawn, patch.object(native, "_wait_http", return_value=True), patch.object(native.time, "sleep"):
            self.assertFalse(native.start_component(self.p, component))
        kill.assert_not_called()
        spawn.assert_not_called()

    def test_up_rejects_conflict_before_build_or_l1_mutations(self):
        with patch.object(native, "_component_pid", return_value=None), patch.object(
            native, "_port_listening", return_value=True
        ), patch.object(native, "_ensure_installed", side_effect=AssertionError("runtime touched before port preflight")), patch.object(
            _local_arm64, "ensure_tools_on_path"
        ), patch.object(_local_arm64, "export_dockerhub_env"):
            self.assertEqual(native.up(self.cfg, ["api"]), 1)

    def test_stop_without_pidfile_never_runs_a_global_name_sweep(self):
        with patch.object(subprocess, "run") as run, patch.object(os, "killpg") as kill:
            native.stop_component(self.p, "api")
        run.assert_not_called()
        kill.assert_not_called()

    def test_legacy_numeric_pidfile_is_not_process_ownership(self):
        native._pid_file(self.p, "api").write_text("12345")
        with patch.object(os, "kill"), patch.object(os, "killpg") as kill:
            self.assertIsNone(native._component_pid(self.p, "api"))
        kill.assert_not_called()

    def test_pid_identity_validation(self):
        for record, birth, group, expected in [
            ({"pid": 12345, "started_at": "original"}, "original", 12345, 12345),
            ({"pid": 12345, "started_at": "original"}, "reused", 12345, None),
            ({"pid": 12345, "started_at": "original"}, "original", 12, None),
            ({"pid": -1, "started_at": "original"}, "original", -1, None),
            ({"pid": True, "started_at": "original"}, "original", 1, None),
            ({"pid": 12345, "started_at": ""}, "", 12345, None),
        ]:
            with self.subTest(record=record, birth=birth, group=group):
                native._pid_file(self.p, "api").write_text(json.dumps(record))
                with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout=birth, returncode=0)), patch.object(os, "getpgid", return_value=group):
                    self.assertEqual(native._component_pid(self.p, "api"), expected)

    def test_status_fails_when_a_required_l1_box_is_missing_or_failed(self):
        for rows in [[("boxlite-local-postgres", "running")], [(f"boxlite-local-{name}", "failed") for name in services.SERVICES]]:
            with self.subTest(rows=rows), patch.object(native, "_l1_rows", return_value=rows), patch.object(
                native, "_component_pid", return_value=12345
            ), patch.object(native, "_port_listening", return_value=True), patch.object(orchestrator, "_http_probe", return_value=True):
                self.assertEqual(native.status(self.cfg), 1)

    def test_failed_up_never_announces_success(self):
        self.p.bin.mkdir(parents=True)
        self.p.runner_bin.touch()
        library = self.cfg.repo_root / "target/debug/libboxlite.a"
        library.parent.mkdir(parents=True)
        library.touch()
        with contextlib.ExitStack() as stack:
            for name in ("ensure_tools_on_path", "export_dockerhub_env", "ensure_native_lib"):
                stack.enter_context(patch.object(_local_arm64, name))
            for name in ("_ensure_installed", "_seed_api_env", "build", "_go_build"):
                stack.enter_context(patch.object(native, name))
            stack.enter_context(patch.object(native, "_ensure_l1_async", new=AsyncMock(return_value=False)))
            stack.enter_context(patch.object(native, "_port_listening", return_value=False))
            stack.enter_context(patch.object(native, "_bin_for", return_value=Path(__file__)))
            stack.enter_context(patch.object(native, "start_component", return_value=False))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(native.up(self.cfg, ["proxy"]), 1)
        self.assertNotIn("stack up", output.getvalue())

    def test_identity_change_prevents_signal_escalation(self):
        with patch.object(native, "_component_pid", side_effect=[12345, None]), patch.object(
            os, "killpg"
        ) as kill, patch.object(os, "getpgid", return_value=12345), patch.object(os, "kill"), patch.object(native.time, "sleep"):
            native._terminate_group(self.p, "api", 12345)
        kill.assert_called_once_with(12345, native.signal.SIGTERM)

    def test_valid_identity_can_be_stopped_and_escalated(self):
        with patch.object(native, "_component_pid", return_value=12345), patch.object(
            os, "killpg"
        ) as kill, patch.object(os, "getpgid", return_value=12345), patch.object(os, "kill"), patch.object(native.time, "sleep"):
            native._terminate_group(self.p, "api", 12345)
        self.assertEqual([call.args for call in kill.call_args_list], [(12345, native.signal.SIGTERM), (12345, native.signal.SIGKILL)])

    def test_archive_digest_changes_the_go_cache_inputs(self):
        library = self.cfg.repo_root / "target/debug/libboxlite.a"
        library.parent.mkdir(parents=True)
        flags = []
        with patch.object(subprocess, "run") as run:
            for contents in (b"old archive", b"new archive"):
                library.write_bytes(contents)
                native._go_build(self.p, "runner")
                flags.append(run.call_args.kwargs["env"].get("CGO_CFLAGS"))
        self.assertIsNotNone(flags[0])
        self.assertNotEqual(*flags)

    def run_selected_startup(self, components, missing):
        self.p.bin.mkdir(parents=True)
        for name in native._GO_BUILDS:
            binary = native._bin_for(self.p, name)
            if name not in missing:
                binary.write_bytes(b"previous executable")
                os.utime(binary, ns=(1_000_000_000, 1_000_000_000))
        library = self.cfg.repo_root / "target/debug/libboxlite.a"
        library.parent.mkdir(parents=True)
        library.write_bytes(b"refreshed archive")
        os.utime(library, ns=(2_000_000_000, 2_000_000_000))
        with contextlib.ExitStack() as stack:
            for name in ("ensure_tools_on_path", "export_dockerhub_env", "ensure_native_lib"):
                stack.enter_context(patch.object(_local_arm64, name))
            stack.enter_context(patch.object(native, "_ensure_installed"))
            stack.enter_context(patch.object(native, "_ensure_l1_async", new=AsyncMock(return_value=False)))
            stack.enter_context(patch.object(native, "_component_pid", return_value=12345))
            stack.enter_context(patch.object(native, "_seed_api_env"))
            stack.enter_context(patch.object(native, "start_component", return_value=True))
            stack.enter_context(patch.object(native, "seed", return_value=0))
            stack.enter_context(patch.object(subprocess, "run"))
            stop = stack.enter_context(patch.object(native, "stop_component"))
            build = stack.enter_context(patch.object(native, "_go_build"))
            self.assertEqual(native.up(self.cfg, components), 0)
        return [call.args[1] for call in stop.call_args_list], [call.args[1] for call in build.call_args_list]

    def test_api_only_startup_keeps_existing_runner_running(self):
        stopped, built = self.run_selected_startup(["api"], missing=[])
        self.assertNotIn("runner", stopped)
        self.assertNotIn("runner", built)

    def test_stale_selected_runner_is_stopped_even_when_another_binary_is_missing(self):
        stopped, built = self.run_selected_startup(["runner"], missing=["proxy"])
        self.assertIn("runner", stopped)
        self.assertEqual(built, ["runner"])

    def test_missing_unselected_binary_does_not_replace_existing_runner_binary(self):
        stopped, built = self.run_selected_startup(["api"], missing=["proxy"])
        self.assertNotIn("runner", stopped)
        self.assertEqual(built, [])

    def test_storage_does_not_depend_on_withdrawn_images_or_one_shot_completion(self):
        self.assertNotIn("minio-init", services.SERVICES)
        self.assertEqual(services.SERVICES["minio"].image, "ghcr.io/rustfs/rustfs:1.0.4-glibc")


class BootstrapRegressions(unittest.TestCase):
    def test_existing_venv_without_install_stamp_reinstalls_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = Path(__file__).resolve().parents[1]
            shutil.copy(source / "Makefile", root / "Makefile")
            shutil.copy(source / "pyproject.toml", root / "pyproject.toml")
            venv = root / "venv"
            (venv / "bin").mkdir(parents=True)
            trace = root / "calls"
            for executable in ("python", "pip"):
                shim = venv / "bin" / executable
                shim.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$INFRA_TEST_TRACE"\n')
                shim.chmod(0o755)
            subprocess.run(["make", "status", f"VENV={venv}"], cwd=root, env={**os.environ, "INFRA_TEST_TRACE": str(trace)}, check=True, capture_output=True)
            self.assertIn("install", trace.read_text())


if __name__ == "__main__":
    unittest.main()
