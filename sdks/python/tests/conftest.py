"""
Pytest configuration and shared fixtures for boxlite tests.

This module provides session-scoped runtime fixtures to avoid lock contention.
BoxliteRuntime uses an exclusive flock() on ~/.boxlite - only ONE runtime
instance can exist at a time. These fixtures ensure all tests share a single
runtime instance.
"""

from __future__ import annotations

import os

import pytest

import boxlite

# BOXLITE_REQUIRE_NATIVE=1 (set by scripts/test/coverage-bindings.sh after
# it builds the extension): importing the module proves it loads, and the
# names prove the SSH surface exists — an absent or broken module, or a
# missing type, fails collection instead of silently skipping native tests.
if os.environ.get("BOXLITE_REQUIRE_NATIVE") == "1":
    from boxlite.boxlite import (  # noqa: F401 - imported for the check
        Box,
        Boxlite,
        SshAccount,
        SshCaConfig,
        SshConfig,
        SshHandle,
        SshStatus,
    )


def _test_registries() -> list:
    """Registry list, built lazily.

    Must NOT run at conftest module scope: pytest imports conftest.py
    for every run (incl. the CI unit job `-m "not integration"`), and
    `boxlite.ImageRegistry` is a native pyclass absent when the
    extension isn't built (the unit job has no build step). Calling
    this only from the fixture body keeps module import native-free —
    the unit job deselects all integration tests so the fixture never
    runs there.

    `make test:integration:python` runs pytest under `with-local-registry`,
    which sets BOXLITE_TEST_REGISTRY to a registry on 127.0.0.1 that replays
    recorded images (src/boxlite/tests/README.md). Run without it, the suite
    fails test_harness_registry.py and pulls through mirrors before falling
    back to docker.io: anonymous
    Docker Hub pulls are rate-limited (100/6h per IP) and intermittently
    return "Not authorized" under CI/hook load, flaking any image-pulling
    integration test. Kept in sync with sdks/node/tests/test-registries.ts.
    """
    local = os.environ.get("BOXLITE_TEST_REGISTRY")
    if local:
        return [boxlite.ImageRegistry(host=local, transport="http", search=True)]
    return [
        boxlite.ImageRegistry(host="docker.m.daocloud.io", search=True),
        boxlite.ImageRegistry(host="docker.xuanyuan.me", search=True),
        boxlite.ImageRegistry(host="docker.1ms.run", search=True),
        boxlite.ImageRegistry(host="docker.io", search=True),
    ]


@pytest.fixture(scope="session")
def test_registries() -> list:
    """The registries the shared runtime resolves images against."""
    return _test_registries()


@pytest.fixture(scope="session")
def shared_runtime(test_registries):
    """Session-scoped async runtime shared across all async tests.

    This fixture creates a single Boxlite runtime that is reused across
    the entire test session, avoiding lock contention between tests.
    """
    rt = boxlite.Boxlite(boxlite.Options(image_registries=test_registries))
    yield rt
    # Runtime cleanup happens when Python garbage collects the object


# For sync API tests - only available if greenlet is installed
try:
    from boxlite import SyncBoxlite

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False


@pytest.fixture(scope="module")
def shared_sync_runtime(shared_runtime):
    """Module-scoped sync runtime that wraps the shared async runtime.

    This fixture wraps the same underlying Boxlite instance from
    shared_runtime with SyncBoxlite's greenlet machinery. This avoids
    lock contention since both fixtures use the same runtime.

    Scope is limited to a single module so pytest-asyncio can run async test
    modules after sync test modules without inheriting a long-lived running
    event loop from SyncBoxlite.
    """
    if not SYNC_AVAILABLE:
        pytest.skip("greenlet not installed")

    # Create SyncBoxlite that wraps the existing shared_runtime
    # instead of creating a new Boxlite instance
    rt = object.__new__(SyncBoxlite)
    rt._boxlite = shared_runtime  # Reuse the shared runtime
    rt._loop = None
    rt._dispatcher_fiber = None
    rt._own_loop = False
    rt._sync_helper = None

    rt.start()  # Start greenlet machinery
    yield rt
    rt.stop()  # Stop greenlet machinery (doesn't close the shared runtime)
