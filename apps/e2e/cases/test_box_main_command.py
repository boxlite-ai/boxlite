"""The box's main command over REST — `cmd` and `entrypoint` overrides.

E2E port of `src/boxlite/tests/run_main_command.rs`, which drives the same two
options against the local runtime. Both cross the wire
(`CreateBoxRequest::from_options`, src/boxlite/src/rest/types.rs:207-208) and
both reach the control plane (`createBoxToCreateBox`,
apps/api/src/boxlite-rest/mappers/box-to-box.mapper.ts:49-50), yet nothing in
this suite set either one — a cloud box was always created with the image's
own init.

The local tests assert through an attach stream. These assert through a side
effect instead: the main command writes a marker the next exec reads back. A
cloud attach cannot see output the main command produced before the client
connected — that is the very race #1569 is about — so a marker file is what
makes the assertion about the option rather than about attach timing.
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain

MARKER = "/tmp/main-command-ran"
# Long enough that the box is still up when the assertions run, short enough
# that a stranded one cannot outlive its auto_stop window anyway.
LINGER = "sleep 600"


async def _read(box, path: str) -> str:
    ex = await box.exec("cat", [path], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0, f"reading {path} failed ({rc.exit_code}): {err!r}"
    return out.strip()


@pytest.mark.asyncio
async def test_cmd_replaces_the_image_default_init(rt, image):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            cmd=["sh", "-c", f"echo cmd-init > {MARKER}; {LINGER}"],
        ),
    )
    try:
        assert await _read(box, MARKER) == "cmd-init", (
            "the box booted something other than the cmd it was created with"
        )
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_entrypoint_replaces_the_image_entrypoint(rt, image):
    box = await rt.create(
        boxlite.BoxOptions(
            image=image,
            entrypoint=["sh", "-c"],
            cmd=[f"echo entrypoint-init > {MARKER}; {LINGER}"],
        ),
    )
    try:
        assert await _read(box, MARKER) == "entrypoint-init", (
            "the entrypoint override did not reach the guest's init"
        )
    finally:
        await rt.remove(box.id, force=True)
