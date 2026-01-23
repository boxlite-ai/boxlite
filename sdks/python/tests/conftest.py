"""
Pytest configuration and shared fixtures for boxlite tests.

This module provides session-scoped runtime fixtures to avoid lock contention.
BoxliteRuntime uses an exclusive flock() on ~/.boxlite - only ONE runtime
instance can exist at a time. These fixtures ensure all tests share a single
runtime instance.
"""

from __future__ import annotations

import pytest

import boxlite


@pytest.fixture(scope="session")
def shared_runtime():
    """Session-scoped async runtime shared across all async tests.

    This fixture creates a single Boxlite runtime that is reused across
    the entire test session, avoiding lock contention between tests.
    """
    rt = boxlite.Boxlite(boxlite.Options())
    yield rt
    # Runtime cleanup happens when Python garbage collects the object


# For sync API tests - only available if greenlet is installed
try:
    from boxlite import SyncBoxlite

    SYNC_AVAILABLE = True
except ImportError:
    SYNC_AVAILABLE = False


@pytest.fixture(scope="session")
def shared_sync_runtime(shared_runtime):
    """Session-scoped sync runtime that wraps the shared async runtime.

    This fixture wraps the same underlying Boxlite instance from
    shared_runtime with SyncBoxlite's greenlet machinery. This avoids
    lock contention since both fixtures use the same runtime.
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
