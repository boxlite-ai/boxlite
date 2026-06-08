"""Pytest fixtures for the e2e suite.

Every fixture here forces the **REST** path. There is no `Boxlite.default()`
fixture in this file by design — local-FFI tests belong under
`sdks/python/tests/`, not `scripts/test/e2e/`.
"""
from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path

import pytest
import pytest_asyncio

import boxlite

DEFAULT_PROFILE = os.environ.get("BOXLITE_E2E_PROFILE", "p1")
DEFAULT_IMAGE = os.environ.get("BOXLITE_E2E_IMAGE", "alpine:3.23")
CRED_PATH = Path.home() / ".boxlite" / "credentials.toml"


def _profile(name: str) -> dict:
    if not CRED_PATH.exists():
        pytest.exit(
            f"{CRED_PATH} missing — run scripts/test/e2e/fixture_setup.py first",
            returncode=2,
        )
    data = tomllib.loads(CRED_PATH.read_text())
    p = data.get("profiles", {}).get(name)
    if not p:
        pytest.exit(
            f"profile '{name}' not in {CRED_PATH} — run fixture_setup.py",
            returncode=2,
        )
    return p


@pytest_asyncio.fixture(scope="session")
async def rt():
    """REST-mode Boxlite runtime against the local API."""
    p = _profile(DEFAULT_PROFILE)
    opts = boxlite.BoxliteRestOptions(
        url=p["url"],
        credential=boxlite.ApiKeyCredential(p["api_key"]),
        path_prefix=p.get("path_prefix") or "",
    )
    runtime = boxlite.Boxlite.rest(opts)
    yield runtime
    # Boxlite.rest doesn't hold persistent resources we need to close,
    # but if it ever gains a `close()` we want it here.
    if hasattr(runtime, "close"):
        try:
            close = runtime.close()
            import inspect
            if inspect.isawaitable(close):
                await close
        except Exception:
            pass


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
