"""Filestore volumes over the unified volume API — data that survives
stop/start, cross-box sharing, and lifecycle rules.

A Filestore volume is a Volume row like any other (volume.service): created
through `POST /volumes` with an `instance` naming the NFS instance that holds
its data directory, mounted by box volume references that carry only
`managed_volume` — the same selector form as bucket-backed volumes. The API
resolves the instance address at dispatch time from its FILESTORE_INSTANCES
configuration, validates the name at volume create, and hands the runner the
resolved server and export inside the internal dispatch DTO — the public
request and the persisted row carry only the logical name.

Data semantics (volumes.go filestoreDataDir): a volume's data directory is
named by the volume id, so boxes sharing a volume share data, and a destroyed
box's data stays reachable by mounting the volume into a new box. Volume
removal this release tombstones the row (the NFS directory is left in place
for ops cleanup), and refuses while any live box still mounts it
(volume.service delete).

Raw REST rather than the SDK throughout, matching test_volumes' read-only
case: the Python SDK's volume dicts predate Filestore and reject unknown keys
(sdks/python/src/options.rs), and the wire shape used here
(`{"managed_volume": ...}`) is the volume-create + box-create flow
test_volumes already exercises for buckets — so the REST form is the honest
wire-level proof. Exec, stop and start still go through the SDK —
`rt.get(box_id)` hands back a full handle once the id is known.

How a runner-side failure reaches a REST caller: POST /boxes inserts a pending
box and the endpoint then waits up to 30s for STARTED
(boxlite-box.controller.ts:139); the failed CREATE_BOX job marks the box ERROR
carrying the runner's words (job-state-handler.service.ts), and the waiter
rejects with "Box state transition failed: <runner's error>" as HTTP 400. So
the create answer itself carries the failure — but the box row it inserted is
still there in ERROR state, and the case deletes it (a 4xx create is not proof
no box was created; same note as test_quota_enforcement's `_post_box`). A 2xx
is likewise more than acceptance: the endpoint answers only once the box
reached STARTED, so no separate wait is needed.

Filestore volumes skip the object-storage machinery entirely — creating one
succeeds on an API with no object storage configured, and `validateVolumes`
gets the full selector list (volume.service.ts) — so there is no 503
precondition here the way test_volumes has. The permission precondition is
real though: attaching any volume requires the key to hold volume permissions
(boxlite-box.controller.ts::assertCanAttachVolumes), and that 403 names a
skip, mirroring test_volumes.

Deployment reality, so nobody mistakes a green local run for coverage: the
FILESTORE_INSTANCES configuration is provisioned on stage/prod API deployments
today. A local single-machine stack has none, so the module only ever
exercises its skip path locally — the four cases need an environment whose API
config declares an instance and whose runner can reach it.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
import warnings
from typing import Any

import pytest

from conftest import DEFAULT_IMAGE, drain, with_bounded_lifetime
from e2e_auth import auth_context, request_json


GUEST_PATH = "/filestore"

# The API's words for an instance name its configuration does not know,
# pinned verbatim so a softened or reworded refusal cannot pass silently
# (apps/api/src/box/services/volume.service.ts).
UNKNOWN_INSTANCE_MARKER = "unknown Filestore instance"


@pytest.fixture(scope="module")
def filestore_instance():
    """Module gate: prove the stage runner holds a Filestore instance BEFORE
    any test runs.

    The configuration is deployment-side env config with no listing API, so
    the only honest probe is one create attempt: the volume create IS the
    probe, and the box create proves the runner mount chain behind it. A refusal carrying "unknown Filestore instance" means no configured
    instance — the whole module skips with a warning naming what was tried. Anything else
    that fails is a defect, not a precondition. On success the probe box is
    deleted immediately and the proven instance name is returned for the tests
    to reuse.
    """
    candidate = os.environ.get("FILESTORE_E2E_INSTANCE") or f"e2e-filestore-probe-{uuid.uuid4().hex[:8]}"
    # Whether the candidate was declared by the operator changes what an
    # unknown-instance refusal means: a declared name that the API
    # configuration does not hold is a misconfiguration to fix by hand (correct the env var, or
    # provision/remove the instance), not a missing precondition to skip past.
    declared = bool(os.environ.get("FILESTORE_E2E_INSTANCE"))
    probe_volume_name = f"e2e-fs-probe-{uuid.uuid4().hex[:10]}"
    probe_box_name = f"e2e-fs-probe-box-{uuid.uuid4().hex[:10]}"

    volume_id = None
    try:
        status, body = request_json(
            "POST",
            auth_context().v1("volumes"),
            with_bounded_lifetime({"name": probe_volume_name, "instance": candidate}),
        )
        body_str = json.dumps(body) if body else ""
        if not (200 <= status < 300) and UNKNOWN_INSTANCE_MARKER in body_str:
            if declared:
                pytest.fail(
                    f"FILESTORE_E2E_INSTANCE={candidate!r} is not in the API's "
                    "FILESTORE_INSTANCES configuration — fix the injected name, or "
                    "provision (or remove) the instance; a declared instance is not "
                    "skipped past"
                )
            warnings.warn(f"GCP FileStore instance=[{candidate}] not existed. Skip test_filestore.py .")
            pytest.skip(
                f"GCP FileStore instance=[{candidate}] not existed — add it to the "
                "API's FILESTORE_INSTANCES configuration to enable"
            )
        assert 200 <= status < 300, f"filestore volume create failed: HTTP {status}: {body}"
        assert body is not None and body.get("id"), f"volume create response has no id: {body}"
        assert body.get("state") == "ready", (
            f"a filestore volume must be ready at once (the runner provisions the data "
            f"directory lazily at first mount), got {body}"
        )
        assert body.get("instance") == candidate, f"volume response lost the instance: {body}"
        volume_id = body["id"]

        status, body = _create_box_with_volume(volume_id, name=probe_box_name)
        _skip_when_key_cannot_attach_volumes(status)

        assert 200 <= status < 300, f"filestore probe box create failed: HTTP {status}: {body_str}"
    finally:
        _delete_box_by_name(probe_box_name)
        if volume_id:
            _delete_volume_by_id(volume_id, force=True)

    return candidate


def _boxes_path(suffix: str = "") -> str:
    return auth_context().v1(f"boxes{suffix}")


def _volumes_path(suffix: str = "") -> str:
    return auth_context().v1(f"volumes{suffix}")


def _create_filestore_volume(instance: str, name: str | None = None) -> tuple[int, dict[str, Any] | None]:
    """POST a filestore volume: a Volume row whose data directory will live on
    the named NFS instance."""
    body: dict[str, Any] = {"instance": instance}
    if name is not None:
        body["name"] = name
    return request_json("POST", _volumes_path(), with_bounded_lifetime(body))


def _create_box_with_volume(volume_selector: str, name: str | None = None) -> tuple[int, dict[str, Any] | None]:
    """POST a box mounting the volume by selector — the same `managed_volume`
    form a bucket-backed volume uses."""
    body: dict[str, Any] = {
        "image": DEFAULT_IMAGE,
        "volumes": [{"managed_volume": volume_selector, "guest_path": GUEST_PATH}],
    }
    if name is not None:
        body["name"] = name
    return request_json("POST", _boxes_path(), with_bounded_lifetime(body))


def _skip_when_key_cannot_attach_volumes(status: int) -> None:
    """Attaching any volume requires the key to hold READ_VOLUMES and
    WRITE_VOLUMES (boxlite-box.controller.ts::assertCanAttachVolumes). A 403
    is a precondition of the credential, not a defect; same skip class as
    test_volumes' managed-volume 403."""
    if status == 403:
        pytest.skip("API key lacks volume attach permissions (READ_VOLUMES, WRITE_VOLUMES)")


def _delete_box_by_name(name: str) -> None:
    """Remove the ERROR-state box a refused create leaves behind.

    The refusal came from the create's STARTED wait, not from the insert: the
    row exists in ERROR state. Best effort — the bounded lifetime and the
    `e2e-` name let `sweep.py` reclaim the box if this deletion itself fails.
    """
    try:
        status, body = request_json("GET", _boxes_path(f"/{name}"))
        if status == 200 and body and body.get("box_id"):
            request_json("DELETE", _boxes_path(f"/{body['box_id']}?force=true"))
    except Exception:
        pass


def _delete_volume_by_id(volume_id: str, force: bool = False) -> None:
    try:
        suffix = f"/{volume_id}" + ("?force=true" if force else "")
        request_json("DELETE", _volumes_path(suffix))
    except Exception:
        pass


async def _exec_ok(box, script: str) -> str:
    ex = await box.exec("sh", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0, f"{script!r} failed ({rc.exit_code}): {err!r}"
    return out


@pytest.mark.asyncio
async def test_create_with_unregistered_instance_fails_loudly(filestore_instance):
    """A volume create naming an instance outside the API configuration fails loudly.

    The configuration is deployment-side env config an API caller cannot
    inspect, so the only honest outcomes are an accepted name or a refusal
    that names the instance. A create that swallowed the unknown name —
    accepting the row and deferring the failure to box create — would leave
    the caller believing the volume is backed by storage it is not.

    Behind the module gate: on a deployment without a configured instance the
    whole file skips, so this case only runs where an instance was proven to
    exist.
    """
    instance = f"e2e-no-such-instance-{uuid.uuid4().hex[:8]}"
    volume_name = f"e2e-fs-bad-{uuid.uuid4().hex[:10]}"

    status, body = _create_filestore_volume(instance, name=volume_name)
    body_str = json.dumps(body) if body else ""
    assert 400 <= status < 500, (
        f"an unknown Filestore instance must fail the volume create with 4xx, "
        f"got HTTP {status}: {body_str}"
    )
    assert UNKNOWN_INSTANCE_MARKER in body_str, (
        f"the refusal must carry the API's words ({UNKNOWN_INSTANCE_MARKER!r}), "
        f"got HTTP {status}: {body_str}"
    )
@pytest.mark.asyncio
async def test_filestore_volume_data_survives_stop_start(rt, filestore_instance):
    """Bytes written through a filestore volume survive stop → start.

    The mount is real NFS on the runner, bind-mounted into the box; stop
    unbinds but keeps the data directory, and start rebuilds the mount from
    the metadata saved at create time (volumes.go), so the same volume derives
    the same data directory. That is what separates a volume from the box's
    own disk, and it had no coverage outside the runner's own tests.
    """
    volume_name = f"e2e-fs-keep-{uuid.uuid4().hex[:10]}"
    box_name = f"e2e-fs-keep-box-{uuid.uuid4().hex[:10]}"

    status, body = _create_filestore_volume(filestore_instance, name=volume_name)
    assert 200 <= status < 300, f"filestore volume create failed: HTTP {status}: {body}"
    volume_id = body["id"]
    status, body = _create_box_with_volume(volume_name)  # by name, the other selector form
    assert 200 <= status < 300, f"filestore box create failed: HTTP {status}: {body}"

    assert body is not None and body.get("box_id"), f"create response has no box_id: {body}"
    box_id = body["box_id"]
    # The create's 2xx already means STARTED (the endpoint waits for it), so
    # the handle is usable for exec right away.
    box = await rt.get(box_id)
    assert box is not None, f"box {box_id} missing right after create"

    payload = f"filestore-e2e-{uuid.uuid4().hex[:8]}"
    try:
        await _exec_ok(box, f"printf %s {payload} > {GUEST_PATH}/probe.txt")

        await box.stop()
        await box.start()
        # A freshly started box gets the same short grace before its first
        # exec as in test_lifecycle_comprehensive; mirror it rather than race it.
        await asyncio.sleep(2)

        out = await _exec_ok(box, f"cat {GUEST_PATH}/probe.txt")
        assert out.strip() == payload, (
            f"filestore content did not survive stop/start: {out!r}"
        )
    finally:
        await rt.remove(box_id, force=True)
        _delete_volume_by_id(volume_id, force=True)


@pytest.mark.asyncio
async def test_filestore_volume_shares_data_across_boxes(rt, filestore_instance):
    """Two boxes mounting the same volume see the same bytes.

    The data directory is named by the volume id (filestoreDataDir), so the
    second box's mount lands in the first box's directory. This is the
    bucket-alignment contract — a destroyed box's data stays reachable by
    mounting the volume into a new box — and it had no coverage anywhere.
    """
    volume_name = f"e2e-fs-share-{uuid.uuid4().hex[:10]}"
    box1_name = f"e2e-fs-share-a-{uuid.uuid4().hex[:8]}"
    box2_name = f"e2e-fs-share-b-{uuid.uuid4().hex[:8]}"

    status, body = _create_filestore_volume(filestore_instance, name=volume_name)
    assert 200 <= status < 300, f"filestore volume create failed: HTTP {status}: {body}"
    volume_id = body["id"]

    status, body = _create_box_with_volume(volume_id, name=box1_name)
    assert 200 <= status < 300, f"box1 create failed: HTTP {status}: {body}"
    box1_id = body["box_id"]
    box1 = await rt.get(box1_id)

    payload = f"shared-e2e-{uuid.uuid4().hex[:8]}"
    box2_id = None
    try:
        await _exec_ok(box1, f"printf %s {payload} > {GUEST_PATH}/shared.txt")

        status, body = _create_box_with_volume(volume_name)  # second box, by name
        assert 200 <= status < 300, f"box2 create failed: HTTP {status}: {body}"
        box2_id = body["box_id"]
        box2 = await rt.get(box2_id)

        out = await _exec_ok(box2, f"cat {GUEST_PATH}/shared.txt")
        assert out.strip() == payload, (
            f"box2 must see box1's bytes through the shared volume: {out!r}"
        )

        # A destroyed box's data stays reachable: destroy box1, box2 still
        # reads what box1 wrote.
        await rt.remove(box1_id, force=True)
        box1_id = None
        out = await _exec_ok(box2, f"cat {GUEST_PATH}/shared.txt")
        assert out.strip() == payload, f"data must survive box1's destroy: {out!r}"
    finally:
        if box1_id:
            await rt.remove(box1_id, force=True)
        if box2_id:
            await rt.remove(box2_id, force=True)
        _delete_volume_by_id(volume_id, force=True)


@pytest.mark.asyncio
async def test_filestore_volume_lifecycle_rules(filestore_instance):
    """Volume removal follows the same rules as bucket volumes: in-use refusal,
    removal once free.

    volume.service delete refuses while any non-destroyed box's volumes JSON
    carries the volume id, and tombstones the row once free (the NFS data
    directory is left in place for ops cleanup this release — documented in
    apps/runner/README.md). Force-deleting a missing volume is accepted.
    """
    volume_name = f"e2e-fs-del-{uuid.uuid4().hex[:10]}"
    box_name = f"e2e-fs-del-box-{uuid.uuid4().hex[:10]}"

    status, body = _create_filestore_volume(filestore_instance, name=volume_name)
    assert 200 <= status < 300, f"filestore volume create failed: HTTP {status}: {body}"
    volume_id = body["id"]
    box_id = None

    try:
        # In-use refusal: the delete arrives while a box mounts the volume.
        status, body = _create_box_with_volume(volume_id, name=box_name)
        assert 200 <= status < 300, f"box create failed: HTTP {status}: {body}"
        box_id = body["box_id"]

        status, body = request_json("DELETE", _volumes_path(f"/{volume_id}"))
        assert status == 409, (
            f"deleting a volume a live box mounts must be refused with 409, "
            f"got HTTP {status}: {body}"
        )

        # Free, then removed: destroy the box, delete succeeds.
        await (await rt.get(box_id)).remove(force=True)
        box_id = None

        status, body = request_json("DELETE", _volumes_path(f"/{volume_id}"))
        assert status == 204, f"deleting a free volume must answer 204, got HTTP {status}: {body}"

        # A second delete with force is accepted as already-deleted.
        status, body = request_json("DELETE", _volumes_path(f"/{volume_id}?force=true"))
        assert status == 204, f"force-deleting an already-deleted volume must answer 204, got HTTP {status}: {body}"
    finally:
        if box_id:
            await rt.remove(box_id, force=True)
        _delete_volume_by_id(volume_id, force=True)
