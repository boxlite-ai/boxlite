"""Filestore volume mounts over REST — loud failure on an unknown instance,
and data that survives stop/start.

A box volume reference can name a Filestore instance instead of a managed
volume (PR #2534): `{"filestore": {"instance": "<logical-name>"}, "guest_path":
...}`, mutually exclusive with `managed_volume`. The instance is real NFS on
the runner, bind-mounted into the box: stop/start keeps the data, destroy
unbinds but keeps it (apps/runner/pkg/boxlite/volumes.go).

Instances are ops-provisioned runner env config, never API-created: the
runner resolves the logical name against its FILESTORE_INSTANCES registry
(apps/runner/cmd/runner/config/config.go), and an unknown name fails the box
create with "unknown Filestore instance ..." (volumes.go,
lookupFilestoreInstance). The API deliberately does not pre-validate the name
— the runner's registry is the source of truth (box.service.ts:286-290) — so
that loud refusal is the contract the first case pins.

Both creates go through raw REST rather than the SDK, for the same reason
test_volumes' read-only case does: the Python SDK's volume dicts accept only
managed_volume / host_path / guest_path / read_only and reject a `filestore`
key outright (sdks/python/src/options.rs), so the reference cannot travel
through `BoxOptions` at all. Exec, stop and start still go through the SDK —
`rt.get(box_id)` hands back a full handle once the id is known.

How the runner-side failure reaches a REST caller: POST /boxes inserts a
pending box and the endpoint then waits up to 30s for STARTED
(boxlite-box.controller.ts:139); the failed CREATE_BOX job marks the box
ERROR carrying the runner's words (job-state-handler.service.ts), and the
waiter rejects with "Box state transition failed: <runner's error>" as HTTP
400. So the create answer itself carries the failure — but the box row it
inserted is still there in ERROR state, and the case deletes it (a 4xx create
is not proof no box was created; same note as test_quota_enforcement's
`_post_box`). A 2xx is likewise more than acceptance: the endpoint answers
only once the box reached STARTED, so no separate wait is needed.

Filestore references skip the managed-volume machinery entirely —
`validateVolumes` gets an empty selector list and returns before the
object-storage check (volume.service.ts:216) — so there is no 503
precondition here the way test_volumes has. The permission precondition is
real though: attaching *any* volume requires the key to hold volume
permissions (boxlite-box.controller.ts::assertCanAttachVolumes), and that 403
names a skip, mirroring test_volumes.
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

# The runner's words for an instance name its registry does not know, pinned
# verbatim so a softened or reworded refusal cannot pass silently
# (apps/runner/pkg/boxlite/volumes.go:288).
UNKNOWN_INSTANCE_MARKER = "unknown Filestore instance"


@pytest.fixture(scope="module")
def filestore_instance():
    """Module gate: prove the stage runner holds a Filestore instance BEFORE
    any test runs.

    The registry is runner-side env config with no listing API, so the only
    honest probe is one create attempt: the happy-path create IS the probe.
    A refusal carrying "unknown Filestore instance" means no registry — the
    whole module skips with a warning naming what was tried. Anything else
    that fails is a defect, not a precondition. On success the probe box is
    deleted immediately and the proven instance name is returned for the
    tests to reuse.
    """
    candidate = os.environ.get("FILESTORE_E2E_INSTANCE") or f"e2e-filestore-probe-{uuid.uuid4().hex[:8]}"
    # Whether the candidate was declared by the operator changes what an
    # unknown-instance refusal means: a declared name that the registry does
    # not hold is a misconfiguration to fix by hand (correct the env var, or
    # provision/remove the instance), not a missing precondition to skip past.
    declared = bool(os.environ.get("FILESTORE_E2E_INSTANCE"))
    probe_name = f"e2e-filestore-probe-{uuid.uuid4().hex[:10]}"

    try:
        status, body = _create_filestore_box(candidate, name=probe_name)
        _skip_when_key_cannot_attach_volumes(status)

        body_str = json.dumps(body) if body else ""
        if not (200 <= status < 300) and UNKNOWN_INSTANCE_MARKER in body_str:
            if declared:
                pytest.fail(
                    f"FILESTORE_E2E_INSTANCE={candidate!r} is not in the stage runner's "
                    "FILESTORE_INSTANCES registry — fix the injected name, or provision "
                    "(or remove) the instance; a declared instance is not skipped past"
                )
            warnings.warn(f"GCP FileStore instance=[{candidate}] not existed. Skip test_filestore.py .")
            pytest.skip(
                f"GCP FileStore instance=[{candidate}] not existed — provision the "
                "instance and add it to the stage runner's FILESTORE_INSTANCES to enable"
            )
        assert 200 <= status < 300, f"filestore probe create failed: HTTP {status}: {body_str}"
    finally:
        _delete_box_by_name(probe_name)

    return candidate


def _boxes_path(suffix: str = "") -> str:
    return auth_context().v1(f"boxes{suffix}")


def _create_filestore_box(instance: str, name: str | None = None) -> tuple[int, dict[str, Any] | None]:
    """POST a box whose one volume references a Filestore instance by name.

    Raw REST for the wire shape the SDK cannot express (see module docstring).
    The instance name must satisfy `/^[a-z0-9][a-z0-9-]{0,62}$/`
    (create-box.dto.ts FilestoreRefDto); the uuid-hex names below do.
    """
    body: dict[str, Any] = {
        "image": DEFAULT_IMAGE,
        "volumes": [{"filestore": {"instance": instance}, "guest_path": GUEST_PATH}],
    }
    if name is not None:
        body["name"] = name
    return request_json("POST", _boxes_path(), with_bounded_lifetime(body))


def _skip_when_key_cannot_attach_volumes(status: int) -> None:
    """Attaching any volume — a Filestore reference included — requires the
    key to hold READ_VOLUMES and WRITE_VOLUMES
    (boxlite-box.controller.ts::assertCanAttachVolumes). A 403 is a
    precondition of the credential, not a defect; same skip class as
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


async def _exec_ok(box, script: str) -> str:
    ex = await box.exec("sh", ["-c", script], None)
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0, f"{script!r} failed ({rc.exit_code}): {err!r}"
    return out


@pytest.mark.asyncio
async def test_create_with_unregistered_instance_fails_loudly(filestore_instance):
    """An instance name outside the runner's registry must fail the create loudly.

    The registry is runner-side env config an API caller cannot inspect, so
    the only honest outcomes are a mounted instance or a refusal that names
    the instance. A create that swallowed the unknown name — mounting
    nothing, or failing with a generic reason — would leave the caller
    believing /filestore is backed by storage it is not.

    Behind the module gate: on a stage without a registry the whole file
    skips, so this case only runs where an instance was proven to exist.
    """
    instance = f"e2e-no-such-instance-{uuid.uuid4().hex[:8]}"
    box_name = f"e2e-filestore-fail-{uuid.uuid4().hex[:10]}"

    try:
        status, body = _create_filestore_box(instance, name=box_name)
        _skip_when_key_cannot_attach_volumes(status)

        body_str = json.dumps(body) if body else ""
        assert 400 <= status < 500, (
            f"an unknown Filestore instance must fail the create with 4xx, "
            f"got HTTP {status}: {body_str}"
        )
        assert UNKNOWN_INSTANCE_MARKER in body_str, (
            f"the refusal must carry the runner's words ({UNKNOWN_INSTANCE_MARKER!r}), "
            f"got HTTP {status}: {body_str}"
        )
    finally:
        # The 400 arrived after the box row was inserted: clean up the
        # ERROR-state box rather than leaving it for the sweep.
        _delete_box_by_name(box_name)


@pytest.mark.asyncio
async def test_filestore_volume_data_survives_stop_start(rt, filestore_instance):
    """Bytes written through the box's filestore mount survive stop → start.

    The mount is real NFS on the runner, bind-mounted into the box; stop
    unbinds but keeps the data directory, and start rebuilds the mount from
    the record saved at create time (volumes.go), so the same declared volume
    derives the same data directory. That is what separates a volume from the
    box's own disk, and it had no coverage outside the runner's own
    integration tests.

    The instance comes from the module gate, which proved the runner's
    registry holds it before any test body ran.
    """
    instance = filestore_instance

    status, body = _create_filestore_box(instance)
    assert 200 <= status < 300, f"filestore box create failed: HTTP {status}: {body_str}"

    assert body is not None and body.get("box_id"), f"create response has no box_id: {body_str}"
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
