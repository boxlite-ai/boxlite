"""E2E port of `src/boxlite/tests/exec_options.rs`.

Source verifies exec-time options (working_dir, env, tty) against the
local FFI runtime. Re-tests the same surface via REST, so any drop
or rename in the proxy controller surfaces.
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


@pytest.mark.asyncio
async def test_exec_working_dir(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec("sh", ["-c", "pwd"], cwd="/tmp")
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0
        assert out.strip() == "/tmp", f"working_dir not honoured: {out!r}"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_exec_env_vars(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec(
            "sh", ["-c", "echo $MY_VAR"],
            env=[("MY_VAR", "boxlite-e2e")],
        )
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0
        assert "boxlite-e2e" in out, f"env var not propagated: {out!r}"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_exec_tty_collects_natural_exit_code(rt, image):
    """A TTY exec should still report the command's real exit code,
    not the TTY infrastructure's exit code."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec("sh", ["-c", "exit 7"], tty=True)
        await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 7, (
            f"TTY exec collapsed exit code: got {rc.exit_code}, expected 7"
        )
    finally:
        await rt.remove(box.id, force=True)
