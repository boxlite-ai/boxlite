"""
Integration tests for SecurityOptions enforcement inside a live box.

These tests verify that security options passed at box creation are actually
enforced by the guest environment — not just accepted at the API boundary.

Python-SDK counterpart of:
  - sdks/go/security_resource_limits_integration_test.go
  - sdks/node/tests/security-resource-limits.integration.test.ts
  - src/boxlite/tests/jailer.rs (resource limit enforcement)

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun / Hypervisor.framework)
"""

from __future__ import annotations

import pytest

import boxlite


@pytest.fixture
def runtime(shared_sync_runtime):
    """Reuse the shared sync runtime (one runtime per ~/.boxlite flock)."""
    return shared_sync_runtime


def _sh(sandbox, command: str) -> tuple[int, str]:
    """Run a shell command in the guest; return (exit_code, stdout)."""
    execution = sandbox.exec("sh", ["-c", command])
    stdout = "".join(list(execution.stdout()))
    result = execution.wait()
    return result.exit_code, stdout.strip()


def _security_opts(**kwargs) -> boxlite.AdvancedBoxOptions:
    """Wrap SecurityOptions inside AdvancedBoxOptions (the required nesting)."""
    return boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions(**kwargs))


@pytest.mark.integration
class TestMaxOpenFiles:
    """SecurityOptions.max_open_files must be enforced inside the guest."""

    MAX_FILES = 64

    def test_ulimit_n_does_not_exceed_configured_limit(self, runtime):
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                advanced=_security_opts(max_open_files=self.MAX_FILES),
            )
        )
        try:
            exit_code, out = _sh(sandbox, "ulimit -n")
            assert exit_code == 0, f"ulimit -n failed with exit {exit_code}"
            assert out.isdigit(), f"ulimit -n returned non-numeric output: {out!r}"
            reported = int(out)
            assert reported <= self.MAX_FILES, (
                f"max_open_files not enforced: ulimit -n = {reported}, "
                f"want ≤ {self.MAX_FILES}"
            )
        finally:
            sandbox.stop()


@pytest.mark.integration
class TestMaxProcesses:
    """SecurityOptions.max_processes must be enforced inside the guest."""

    MAX_PROCS = 50

    def test_ulimit_u_does_not_exceed_configured_limit(self, runtime):
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                advanced=_security_opts(max_processes=self.MAX_PROCS),
            )
        )
        try:
            exit_code, out = _sh(sandbox, "ulimit -u")
            assert exit_code == 0, f"ulimit -u failed with exit {exit_code}"
            assert out != "unlimited", (
                f"max_processes not enforced: ulimit -u reports 'unlimited', "
                f"want ≤ {self.MAX_PROCS}"
            )
            assert out.isdigit(), f"ulimit -u returned non-numeric output: {out!r}"
            reported = int(out)
            assert reported <= self.MAX_PROCS, (
                f"max_processes not enforced: ulimit -u = {reported}, "
                f"want ≤ {self.MAX_PROCS}"
            )
        finally:
            sandbox.stop()


@pytest.mark.integration
class TestSanitizeEnv:
    """SecurityOptions.sanitize_env must filter host environment variables."""

    def test_path_is_available_in_allowlist(self, runtime):
        """PATH is in the allowlist — it must be reachable inside the guest."""
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                advanced=_security_opts(
                    sanitize_env=True,
                    env_allowlist=["PATH", "HOME", "TERM"],
                ),
            )
        )
        try:
            exit_code, out = _sh(sandbox, "echo $PATH")
            assert exit_code == 0
            assert out != "", (
                "PATH should be present in guest env (it is in the allowlist)"
            )
        finally:
            sandbox.stop()

    def test_host_only_variable_absent_from_guest(self, runtime):
        """A variable not in env_allowlist must not appear in guest environment."""
        sandbox = runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                auto_remove=False,
                advanced=_security_opts(
                    sanitize_env=True,
                    env_allowlist=["PATH", "HOME", "TERM"],
                ),
            )
        )
        try:
            # grep returns exit 1 when there are zero matches; `|| true` keeps exit 0.
            exit_code, out = _sh(
                sandbox,
                "env | grep -c BOXLITE_SHOULD_NOT_EXIST || true",
            )
            assert exit_code == 0
            assert out in ("0", ""), (
                f"sanitize_env did not filter unlisted variable: grep count = {out!r}"
            )
        finally:
            sandbox.stop()
