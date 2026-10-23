"""Managed volumes over REST — CRUD, and data that outlives the box.

Ported from E2B's cloud volume tests
(`packages/python-sdk/tests/async/volume_async/test_volume.py:83-131,208` and
`test_volume_content.py:46-69`): create a volume, see it in the listing, fetch
it by id, write through a sandbox, and read the same bytes back. BoxLite's volumes
are the same idea reached through `rt.volumes()` and
`BoxOptions(volumes=[{"managed_volume": ..., "guest_path": ...}])`.

Only `test_volume_host_bind_mount.py` touched volumes before this, and it
tests a *rejection*. The managed path — the one the cloud actually offers —
had no coverage at all, though the API has served it since
apps/api/src/boxlite-rest/boxlite-volume.controller.ts landed.

Volumes are FUSE-mounted from object storage on the runner, so a stage without
object storage answers 503 (`isVolumeStorageConfigured` →
`ServiceUnavailableException`, apps/api/src/box/services/volume.service.ts:52),
and an API key without volume permissions answers 403. Both are preconditions of the environment rather
than defects, and each skips with the reason named.
"""
from __future__ import annotations

import asyncio
import uuid

import boxlite
import pytest

from conftest import drain, with_bounded_lifetime
from e2e_auth import auth_context, request_json


GUEST_PATH = "/mnt/e2e-volume"


def _volume_path(suffix: str = "") -> str:
    return auth_context().v1(f"volumes{suffix}")


async def _exec_ok(box, script: str) -> str:
    ex = await box.exec("sh", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0, f"{script!r} failed ({rc.exit_code}): {err!r}"
    return out


@pytest.fixture
def managed_volume():
    """One volume per test, removed on teardown.

    Raw REST rather than the SDK: a 403 and a 503 have to be told apart from a
    real failure, and the HTTP status is the only place that distinction is
    unambiguous.
    """
    name = f"e2e-vol-{uuid.uuid4().hex[:8]}"
    status, body = request_json("POST", _volume_path(), {"name": name})
    if status == 403:
        pytest.skip("API key lacks volume permissions (WRITE_VOLUMES)")
    if status == 503:
        pytest.skip("stage has no object storage configured for volumes")
    assert status in (200, 201), f"volume create returned {status}: {body}"
    assert body is not None
    yield body
    request_json("DELETE", _volume_path(f"/{body['id']}?force=true"))


@pytest.mark.asyncio
async def test_volume_is_listed_and_fetchable_through_the_sdk(rt, managed_volume):
    volume_id = managed_volume["id"]

    infos = await rt.volumes().list()
    assert volume_id in {info.id for info in infos}, (
        f"created volume {volume_id} missing from {[i.id for i in infos]}"
    )

    info = await rt.volumes().get(volume_id)
    assert info.name == managed_volume["name"], (
        f"name changed between create and get: {info.name!r} vs {managed_volume['name']!r}"
    )


@pytest.mark.asyncio
async def test_a_read_only_mount_is_refused_rather_than_downgraded(managed_volume):
    """Asking for read-only must fail, not quietly hand back a writable mount.

    Ported from the intent of `src/boxlite/tests/mount_security.rs` and
    `sdks/python/tests/test_readonly_volume_remount.py`, which pin read-only
    enforcement on the local runtime. The cloud has no such enforcement yet and
    says so at the boundary: `VolumeSpecDto.read_only` is `@IsIn([false])`
    (apps/api/src/boxlite-rest/dto/create-box.dto.ts:170-179), rejected
    "rather than silently downgraded to read-write, which would hand the caller
    a writable mount they believe is protected". Raw REST because the point is
    the server's answer, and the SDK sends `read_only` on every volume spec.
    """
    from conftest import DEFAULT_IMAGE

    status, body = request_json(
        "POST",
        auth_context().v1("boxes"),
        with_bounded_lifetime({
            "image": DEFAULT_IMAGE,
            "volumes": [{
                "managed_volume": managed_volume["id"],
                "guest_path": GUEST_PATH,
                "read_only": True,
            }],
        }),
    )
    assert status == 400, (
        f"a read-only managed mount must be refused while enforcement is "
        f"missing, got HTTP {status}: {body}"
    )


@pytest.mark.asyncio
async def test_volume_contents_outlive_the_box_that_wrote_them(rt, image, managed_volume):
    """The point of a managed volume: the bytes survive the box."""
    mount = [{"managed_volume": managed_volume["id"], "guest_path": GUEST_PATH}]
    payload = f"written-by-{uuid.uuid4().hex[:8]}"

    writer = await rt.create(boxlite.BoxOptions(image=image, volumes=mount))
    try:
        await _exec_ok(writer, f"printf %s {payload} > {GUEST_PATH}/probe.txt")
    finally:
        await rt.remove(writer.id, force=True)

    reader = await rt.create(boxlite.BoxOptions(image=image, volumes=mount))
    try:
        out = await _exec_ok(reader, f"cat {GUEST_PATH}/probe.txt")
        assert out.strip() == payload, (
            f"volume content did not survive the writing box: {out!r}"
        )
    finally:
        await rt.remove(reader.id, force=True)
