"""Pytest fixtures for the e2e suite.

Every fixture here forces the **REST** path. There is no `Boxlite.default()`
fixture in this file by design — local-FFI tests belong under
`sdks/python/tests/`, not `scripts/test/e2e/`.

The autouse fixture `verify_runner_saw_all_boxes` proves per-test that
every box the test created actually reached the runner via the API. If a
test accidentally swaps to local-FFI or talks to the wrong endpoint,
that fixture fails the test with a path-bypass error.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import pytest
import pytest_asyncio

import boxlite

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context, credentials_path
from path_verification import runner_journal_seek, runner_hits_for_box

DEFAULT_IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")


class _TrackingRuntime:
    """Wraps a REST Boxlite runtime so we can intercept .create() and
    record the box ids per test. Other methods pass through unchanged
    via __getattr__. Designed to be transparent — any failure inside the
    tracking layer must not mask the underlying runtime behaviour."""

    def __init__(self, inner):
        object.__setattr__(self, "_inner", inner)
        # Per-test bucket of (box_id, created_at_monotonic). Reset by
        # the autouse fixture before each test.
        object.__setattr__(self, "_created", [])

    async def create(self, *args, **kwargs):
        box = await self._inner.create(*args, **kwargs)
        try:
            self._created.append((box.id, time.monotonic()))
        except Exception:
            pass  # never mask the real return
        return box

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest_asyncio.fixture(scope="session")
async def rt():
    """REST-mode Boxlite runtime against the local API, wrapped in a
    tracking shim so the autouse fixture can verify each box reached
    the runner."""
    try:
        ctx = auth_context()
    except RuntimeError as exc:
        pytest.exit(str(exc), returncode=2)
    opts = boxlite.BoxliteRestOptions(
        url=ctx.url,
        credential=boxlite.ApiKeyCredential(ctx.token),
        path_prefix=ctx.path_prefix,
    )
    runtime = boxlite.Boxlite.rest(opts)
    tracking = _TrackingRuntime(runtime)
    yield tracking
    if hasattr(runtime, "close"):
        try:
            close = runtime.close()
            import inspect
            if inspect.isawaitable(close):
                await close
        except Exception:
            pass


@pytest_asyncio.fixture(autouse=True)
async def verify_runner_saw_all_boxes(rt):
    """Per-test path-bypass guard.

    Before each test runs, snapshot the runner journal timestamp and
    reset the tracking runtime's per-test bucket. After the test,
    every box id created via `rt.create` MUST appear in the runner
    journal — if not, the SDK silently bypassed the API → Runner
    chain (e.g. degraded to local FFI, or the runner-side journal
    write broke). Tests that don't create any boxes are unaffected.

    Set ``BOXLITE_E2E_SKIP_PATH_VERIFY=1`` to bypass this check entirely.
    Intended for cloud-CI runs where the runner journal lives on a
    remote EC2 instance and isn't reachable from ``journalctl`` on the
    pytest host.
    """
    if os.environ.get("BOXLITE_E2E_SKIP_PATH_VERIFY", "").lower() in ("1", "true", "yes", "on"):
        yield
        return

    since = runner_journal_seek()
    object.__setattr__(rt, "_created", [])

    yield

    # Give the runner a brief window to flush its log buffer. The
    # CREATE_BOX journal entry is written as the job completes —
    # if we check immediately we can race the journald write.
    created = list(rt._created)
    if not created:
        return

    deadline = time.time() + 5.0
    missing = []
    while True:
        missing = [bid for bid, _ in created
                   if runner_hits_for_box(since, bid) < 1]
        if not missing or time.time() > deadline:
            break
        await asyncio.sleep(0.3)

    assert not missing, (
        f"box(es) created in this test never reached the runner journal: "
        f"{missing}. Either the SDK degraded to local FFI, the API did not "
        f"forward to the runner, or journalctl access broke. See "
        f"scripts/test/e2e/README.md for the chain spec."
    )


@pytest.fixture(scope="session")
def e2e_auth():
    return auth_context()


@pytest.fixture(scope="session")
def e2e_credentials_path() -> Path:
    return credentials_path()


@pytest.fixture(scope="session")
def image() -> str:
    return DEFAULT_IMAGE


@pytest_asyncio.fixture
async def box(rt, image):
    """Create a box per test, auto-removed on teardown."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    yield b
    try:
        await rt.remove(b.id, force=True)
    except Exception:
        pass


# ─── helpers shared across cases ────────────────────────────────────────────

async def collect_stream(stream) -> str:
    if stream is None:
        return ""
    chunks: list[str] = []
    async for ch in stream:
        chunks.append(ch.decode("utf-8", "replace") if isinstance(ch, bytes) else str(ch))
    return "".join(chunks)


async def drain(ex) -> tuple[str, str]:
    """Drain stdout + stderr concurrently — required for REST exec."""
    import asyncio
    out_t = asyncio.create_task(collect_stream(ex.stdout()))
    err_t = asyncio.create_task(collect_stream(ex.stderr()))
    return await asyncio.gather(out_t, err_t)


def stdout_line_count(s: str) -> int:
    return len([ln for ln in s.splitlines() if ln])
