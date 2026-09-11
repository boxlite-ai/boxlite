"""E2E P0 (data migration slice): a box's data round-trips through export→import.

Requirement (Sandbox platform §5.7 / §12.2): the platform must let a box's data
move to a NEW box via export → import with the payload intact. This exercises
the box-level primitive (`box.export()` → `runtime.import_box()`) that the
assistant's Generation migration is built on — not the full Chat Claw
Generation orchestration (signing, atomic activation, integrity manifests),
which is application-layer, but the durable transfer underneath it.

`auto_remove=False` on the source so it survives until we've exported it.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest
from conftest import drain

import boxlite

SENTINEL = "migrate-roundtrip-7b3e9d"
DATA_PATH = "/root/migrate_payload.txt"


async def _run(box, cmd: str) -> tuple[int, str, str]:
    ex = await box.exec("sh", ["-c", cmd], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    return rc.exit_code, out, err


@pytest.mark.asyncio
async def test_data_survives_export_import_to_new_box(rt, image):
    src = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    dst = None
    with tempfile.TemporaryDirectory(prefix="boxlite_e2e_migrate_") as workdir:
        archive = os.path.join(workdir, "box.boxlite")
        try:
            # 1) Write a marker into the source box's rootfs.
            rc, _, err = await _run(
                src, f"printf '%s' '{SENTINEL}' > {DATA_PATH} && sync"
            )
            assert rc == 0, f"source write failed: rc={rc} stderr={err!r}"

            # 2) Export the source box to a host-side .boxlite archive.
            out_path = await src.export(dest=archive)
            assert os.path.exists(out_path) and os.path.getsize(out_path) > 0, (
                f"export produced no archive at {out_path!r}"
            )

            # 3) Import the archive into a brand-new box. `untrusted` is a
            # keyword-only arg on the binding.
            dst = await rt.import_box(out_path, None, untrusted=False)
            assert dst.id != src.id, "import must create a distinct box"

            # 4) The new box must carry the marker, byte-for-byte (exact match;
            # the payload was written with `printf '%s'`, so no trailing newline).
            rc, out, err = await _run(dst, f"cat {DATA_PATH}")
            assert rc == 0, f"imported box read failed: rc={rc} stderr={err!r}"
            assert out == SENTINEL, f"payload did not survive export→import → {out!r}"
        finally:
            # Remove both boxes independently so a failure on one still cleans
            # up the other (no leaked box contaminating later e2e tests), but
            # surface what failed instead of swallowing it — a box that will not
            # delete is exactly the kind of leak later cases trip over.
            cleanup_errors = []
            for leftover in (src, dst):
                if leftover is None:
                    continue
                try:
                    await rt.remove(leftover.id, force=True)
                except Exception as exc:  # noqa: BLE001 - reported below
                    cleanup_errors.append(f"{leftover.id}: {exc!r}")
            assert not cleanup_errors, (
                "failed to remove e2e boxes: " + "; ".join(cleanup_errors)
            )
