"""Managed object-storage volumes over REST and a real guest VM.

The base cases cover volume CRUD and data that outlives a Box. The mount-option
cases cover the cloud behavior that cannot be safely inferred from mocked DTOs:
whole-volume read-only, subpath selection, RW auto-create, RO fail-closed,
sibling isolation, per-Box RO/RW sharing, and stop/start persistence.

The same cases run against the local S3-compatible stack and a cloud profile.
They are skipped only when volume permissions or object storage are absent, so
a missing backend cannot look like a passing feature. Filestore is out of scope
for this PR.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager

import boxlite
import pytest
from conftest import (
    DEFAULT_IMAGE,
    drain,
    e2e_box_name,
    wait_for_box_state,
    with_bounded_lifetime,
)
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

    infos = await rt.volumes.list()
    assert volume_id in {info.id for info in infos}, (
        f"created volume {volume_id} missing from {[i.id for i in infos]}"
    )

    info = await rt.volumes.get(volume_id)
    assert info.name == managed_volume["name"], (
        f"name changed between create and get: {info.name!r} vs {managed_volume['name']!r}"
    )


async def _exec_failed(box, script: str) -> tuple[int, str, str]:
    """Run one command and return its result without treating failure as success."""
    ex = await box.exec("sh", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    return rc.exit_code, out, err


async def _remove_box_by_name(name: str) -> None:
    """Delete a raw REST box, tolerating a box that never became visible.

    A rejected request normally never creates a Box, but a late runner failure
    does: the API returns 500 only after persisting and dispatching it. The
    explicit delete keeps a failed assertion from leaving quota behind.
    """
    path = auth_context().v1(f"boxes/{name}?force=true")
    for _ in range(3):
        status, _body = await asyncio.to_thread(request_json, "DELETE", path)
        if status in (200, 202, 204, 404):
            return
        await asyncio.sleep(0.5)
    raise AssertionError(f"failed to delete raw e2e box {name}")


@asynccontextmanager
async def _mounted_box(rt, *, mounts: list[dict]):
    """Create through the public mounts request and yield an exec handle.

    The Python SDK intentionally exposes the legacy managed-volume vocabulary,
    not the REST `mounts` shape. Raw REST exercises the public contract;
    `rt.get(name)` reattaches to the same API-owned Box for guest assertions.
    Cleanup runs when the context exits, including after a failed assertion.
    """
    name = e2e_box_name()
    body = with_bounded_lifetime(
        {
            "image": DEFAULT_IMAGE,
            "name": name,
            "mounts": mounts,
        }
    )
    try:
        status, response = await asyncio.to_thread(
            request_json,
            "POST",
            auth_context().v1("boxes"),
            body,
            timeout=60,
        )
        if status not in (200, 201):
            raise AssertionError(f"mount create returned HTTP {status}: {response}")

        box = await rt.get(name)
        if box is None:
            raise AssertionError(f"mount-created box {name} could not be reattached")
        yield box
    finally:
        await _remove_box_by_name(name)


async def _expect_mount_create_failure(
    mounts: list[dict], *, expected_status: int = 400, expected_code: str | None = None
):
    """Assert that a bad or unfulfillable mount request does not start a Box."""
    name = e2e_box_name()
    body = with_bounded_lifetime(
        {
            "image": DEFAULT_IMAGE,
            "name": name,
            "mounts": mounts,
        }
    )
    try:
        status, response = await asyncio.to_thread(
            request_json,
            "POST",
            auth_context().v1("boxes"),
            body,
            timeout=60,
        )
        assert status == expected_status, (
            f"expected HTTP {expected_status}, got {status}: {response}"
        )
        if expected_code is not None:
            detail = json.dumps(response, sort_keys=True)
            assert expected_code in detail, (
                f"failure did not contain {expected_code}: {detail}"
            )
    finally:
        await _remove_box_by_name(name)


async def _expect_box_create_rejection(body: dict):
    """Assert a synchronous 400 and clean up if an implementation accepts it."""
    name = e2e_box_name()
    body = with_bounded_lifetime({**body, "name": name})
    try:
        status, response = await asyncio.to_thread(
            request_json,
            "POST",
            auth_context().v1("boxes"),
            body,
            timeout=30,
        )
        assert status == 400, f"expected 400, got {status}: {response}"
    finally:
        await _remove_box_by_name(name)


async def _seed_mount(
    rt, *, volume_id: str, commands: list[str], read_only: bool = False
):
    """Mount the volume root, run seed commands, and always delete the seeder."""
    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                volume_id,
                read_only=read_only,
            )
        ],
    ) as box:
        rc, _out, err = await _exec_failed(box, "; ".join(commands))
        if rc != 0:
            raise AssertionError(f"failed to seed volume ({rc}): {err}")


def _volume_mount(
    volume_id: str, *, read_only: bool = False, sub_path: str | None = None
):
    mount = {
        "type": "volume",
        "source": volume_id,
        "target": GUEST_PATH,
        "read_only": read_only,
    }
    if sub_path is not None:
        mount["sub_path"] = sub_path
    return mount


def _volume_request(volume_id: str, *, read_only: bool):
    return [
        {
            "managed_volume": volume_id,
            "guest_path": GUEST_PATH,
            "read_only": read_only,
        }
    ]


@pytest.mark.asyncio
async def test_read_only_mount_is_accepted_and_enforced(rt, image, managed_volume):
    """A RO request starts, reads seeded data, and cannot mutate the volume."""
    seed = f"whole-volume-{uuid.uuid4().hex}"
    writer = await rt.create(
        boxlite.BoxOptions(
            image=image,
            volumes=_volume_request(managed_volume["id"], read_only=False),
        )
    )
    try:
        rc, _out, err = await _exec_failed(
            writer, f"printf %s {seed} > {GUEST_PATH}/probe.txt"
        )
        assert rc == 0, f"seeding the volume failed ({rc}): {err}"
    finally:
        await rt.remove(writer.id, force=True)

    reader = await rt.create(
        boxlite.BoxOptions(
            image=image,
            volumes=_volume_request(managed_volume["id"], read_only=True),
        )
    )
    try:
        out = await _exec_ok(reader, f"cat {GUEST_PATH}/probe.txt")
        assert out.strip() == seed

        # Exercise all destructive classes. If any command unexpectedly wins,
        # fail immediately rather than letting a later command hide the change.
        for label, script in {
            "create": f"echo {uuid.uuid4().hex} > {GUEST_PATH}/must-not-exist",
            "append": f"echo {uuid.uuid4().hex} >> {GUEST_PATH}/probe.txt",
            "modify": f"printf corrupted > {GUEST_PATH}/probe.txt",
            "delete": f"rm -f {GUEST_PATH}/probe.txt",
            "rename": f"mv {GUEST_PATH}/probe.txt {GUEST_PATH}/renamed.txt",
        }.items():
            rc, out, err = await _exec_failed(reader, script)
            assert rc != 0, f"{label} succeeded on a read-only volume: {out!r} {err!r}"

        # A guest remount attempt must not turn the share writable. The mount
        # command itself may be denied by the container's capability set; either
        # way, a subsequent write must still fail.
        await _exec_failed(reader, f"mount -o remount,rw {GUEST_PATH}")
        rc, out, err = await _exec_failed(
            reader, f"echo after-remount > {GUEST_PATH}/after-remount"
        )
        assert rc != 0, f"write succeeded after remount attempt: {out!r} {err!r}"

        out = await _exec_ok(reader, f"cat {GUEST_PATH}/probe.txt")
        assert out.strip() == seed, "a rejected write changed the read-only volume"
    finally:
        await rt.remove(reader.id, force=True)


@pytest.mark.asyncio
async def test_mount_request_rejects_invalid_contract(managed_volume):
    """Bad mounts are rejected synchronously, before runner dispatch."""
    volume_id = managed_volume["id"]
    valid = _volume_mount(volume_id)
    cases = [
        (
            "bind source",
            {"mounts": [{**valid, "type": "bind", "source": "/host/data"}]},
        ),
        ("empty sub_path", {"mounts": [{**valid, "sub_path": ""}]}),
        ("absolute sub_path", {"mounts": [{**valid, "sub_path": "/team/backend"}]}),
        ("traversal sub_path", {"mounts": [{**valid, "sub_path": "team/../backend"}]}),
        ("null sub_path", {"mounts": [{**valid, "sub_path": None}]}),
        ("null read_only", {"mounts": [{**valid, "read_only": None}]}),
        (
            "volumes and mounts together",
            {
                "volumes": _volume_request(volume_id, read_only=False),
                "mounts": [valid],
            },
        ),
    ]

    for label, extra in cases:
        await _expect_box_create_rejection({"image": DEFAULT_IMAGE, **extra})


@pytest.mark.asyncio
async def test_rw_subpath_is_created_and_persistent(rt, managed_volume):
    """Cloud RW creates missing nested directories and their data survives."""
    token = uuid.uuid4().hex
    backend = f"e2e/{token}/backend"

    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                managed_volume["id"],
                sub_path=backend,
            )
        ],
    ) as writer:
        await _exec_ok(writer, f"printf created-{token} > {GUEST_PATH}/marker")
        out = await _exec_ok(writer, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"created-{token}"

    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                managed_volume["id"],
                sub_path=backend,
            )
        ],
    ) as reader:
        out = await _exec_ok(reader, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"created-{token}"


@pytest.mark.asyncio
async def test_rw_existing_subpath_hides_its_sibling(rt, managed_volume):
    """Mounting one existing directory must not expose another directory."""
    token = uuid.uuid4().hex
    backend = f"e2e/{token}/backend"
    await _seed_mount(
        rt,
        volume_id=managed_volume["id"],
        commands=[
            f"mkdir -p {GUEST_PATH}/{backend}",
            f"printf backend-{token} > {GUEST_PATH}/{backend}/marker",
            f"mkdir -p {GUEST_PATH}/e2e/{token}/other",
            f"printf sibling-{token} > {GUEST_PATH}/e2e/{token}/other/sibling-marker",
        ],
    )

    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                managed_volume["id"],
                sub_path=backend,
            )
        ],
    ) as box:
        out = await _exec_ok(box, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"backend-{token}"
        await _exec_ok(box, f"test ! -e {GUEST_PATH}/sibling-marker")
        rc, _out, err = await _exec_failed(
            box, f"printf rw-{token} > {GUEST_PATH}/writable"
        )
        assert rc == 0, f"existing RW subpath could not write: {err!r}"


@pytest.mark.asyncio
async def test_ro_existing_subpath_is_read_only(rt, managed_volume):
    """An existing RO subpath is visible; destructive operations fail unchanged."""
    token = uuid.uuid4().hex
    backend = f"e2e/{token}/backend"
    await _seed_mount(
        rt,
        volume_id=managed_volume["id"],
        commands=[
            f"mkdir -p {GUEST_PATH}/{backend}",
            f"printf ro-{token} > {GUEST_PATH}/{backend}/marker",
        ],
    )

    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                managed_volume["id"],
                read_only=True,
                sub_path=backend,
            )
        ],
    ) as box:
        out = await _exec_ok(box, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"ro-{token}"

        for label, script in {
            "create": f"echo no > {GUEST_PATH}/new",
            "append": f"echo no >> {GUEST_PATH}/marker",
            "modify": f"printf no > {GUEST_PATH}/marker",
            "delete": f"rm -f {GUEST_PATH}/marker",
            "rename": f"mv {GUEST_PATH}/marker {GUEST_PATH}/moved",
        }.items():
            rc, out, err = await _exec_failed(box, script)
            assert rc != 0, f"{label} succeeded on an RO subpath: {out!r} {err!r}"

        out = await _exec_ok(box, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"ro-{token}"


@pytest.mark.asyncio
async def test_ro_missing_subpath_fails_without_creating_dirs(rt, managed_volume):
    """RO must fail closed and leave every missing directory uncreated."""
    token = uuid.uuid4().hex
    backend = f"e2e/{token}/backend"

    await _expect_mount_create_failure(
        [_volume_mount(managed_volume["id"], read_only=True, sub_path=backend)],
        expected_status=500,
        expected_code="VOLUME_SUBPATH_NOT_FOUND",
    )

    async with _mounted_box(
        rt, mounts=[_volume_mount(managed_volume["id"])]
    ) as checker:
        out = await _exec_ok(
            checker,
            "; ".join(
                [
                    f"test ! -e {GUEST_PATH}/e2e/{token}",
                    f"test ! -e {GUEST_PATH}/{backend}",
                    "echo unchanged",
                ]
            ),
        )
        assert out.strip() == "unchanged"


@pytest.mark.asyncio
async def test_subpath_pointing_at_a_file_fails(rt, managed_volume):
    """A file is not a mountable directory; Runner/guest must fail closed."""
    token = uuid.uuid4().hex
    file_path = f"e2e/{token}/file"
    await _seed_mount(
        rt,
        volume_id=managed_volume["id"],
        commands=[
            f"mkdir -p {GUEST_PATH}/e2e/{token}",
            f"printf data > {GUEST_PATH}/{file_path}",
        ],
    )

    await _expect_mount_create_failure(
        [_volume_mount(managed_volume["id"], sub_path=file_path)],
        expected_status=500,
        expected_code="VOLUME_SUBPATH_INVALID",
    )

    async with _mounted_box(
        rt, mounts=[_volume_mount(managed_volume["id"])]
    ) as checker:
        out = await _exec_ok(checker, f"cat {GUEST_PATH}/{file_path}")
        assert out.strip() == "data"


@pytest.mark.asyncio
async def test_ro_and_rw_boxes_on_one_volume_are_isolated(rt, image, managed_volume):
    """One RO mount must not turn the shared backend read-only for another Box."""
    token = uuid.uuid4().hex
    seed = f"shared-{token}"

    writer_seed = await rt.create(
        boxlite.BoxOptions(
            image=image,
            volumes=_volume_request(managed_volume["id"], read_only=False),
        )
    )
    try:
        await _exec_ok(writer_seed, f"printf {seed} > {GUEST_PATH}/probe.txt")
    finally:
        await rt.remove(writer_seed.id, force=True)

    reader = await rt.create(
        boxlite.BoxOptions(
            image=image,
            volumes=_volume_request(managed_volume["id"], read_only=True),
        )
    )
    writer = await rt.create(
        boxlite.BoxOptions(
            image=image,
            volumes=_volume_request(managed_volume["id"], read_only=False),
        )
    )
    try:
        out = await _exec_ok(reader, f"cat {GUEST_PATH}/probe.txt")
        assert out.strip() == seed

        rc, out, err = await _exec_failed(
            reader, f"echo no > {GUEST_PATH}/reader-write"
        )
        assert rc != 0, f"RO Box wrote to the shared volume: {out!r} {err!r}"

        marker = f"writer-{token}"
        rc, _out, err = await _exec_failed(
            writer, f"printf {marker} > {GUEST_PATH}/writer-marker"
        )
        assert rc == 0, f"RW Box lost write access while an RO Box was mounted: {err!r}"
    finally:
        for box in (reader, writer):
            await rt.remove(box.id, force=True)


@pytest.mark.asyncio
async def test_ro_subpath_survives_stop_start(rt, managed_volume):
    """Restart must restore both target and RO semantics from persisted config."""
    token = uuid.uuid4().hex
    backend = f"e2e/{token}/backend"
    await _seed_mount(
        rt,
        volume_id=managed_volume["id"],
        commands=[
            f"mkdir -p {GUEST_PATH}/{backend}",
            f"printf restart-{token} > {GUEST_PATH}/{backend}/marker",
        ],
    )

    async with _mounted_box(
        rt,
        mounts=[
            _volume_mount(
                managed_volume["id"],
                read_only=True,
                sub_path=backend,
            )
        ],
    ) as box:
        out = await _exec_ok(box, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"restart-{token}"

        await box.stop()
        await wait_for_box_state(rt, box.id, "stopped")
        await box.start()
        await wait_for_box_state(rt, box.id, "running")

        out = await _exec_ok(box, f"cat {GUEST_PATH}/marker")
        assert out.strip() == f"restart-{token}"
        rc, out, err = await _exec_failed(box, f"echo after-restart > {GUEST_PATH}/new")
        assert rc != 0, f"restart downgraded RO to RW: {out!r} {err!r}"


@pytest.mark.asyncio
async def test_volume_contents_outlive_the_box_that_wrote_them(
    rt, image, managed_volume
):
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
