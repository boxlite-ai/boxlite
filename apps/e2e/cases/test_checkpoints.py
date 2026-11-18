"""Real REST/API/runner/VM checkpoint acceptance; requires configured storage.

No fallback or missing-capability skip: run against the branch's deployed stack.
This case uses checkpoint storage and multiple guest lifecycles, so it is
deliberately outside smoke tests.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import boxlite
import pytest
import pytest_asyncio
from conftest import E2E_AUTO_DELETE_SECONDS, E2E_AUTO_STOP_SECONDS, drain
from e2e_auth import request_json


LIFECYCLE_TIMEOUT_SECONDS = 30


async def wait_stopped(rt, key):
    async def wait():
        while True:
            info = await rt.get_info(key)
            assert info is not None, f"Box {key} disappeared before stopping"
            state = info.state.status
            assert state not in {"failed", "unknown"}, f"Box {key} entered {state} while stopping"
            if state == "stopped":
                return
            await asyncio.sleep(0.2)

    try:
        await asyncio.wait_for(wait(), timeout=LIFECYCLE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        raise AssertionError(f"Box {key} did not stop within {LIFECYCLE_TIMEOUT_SECONDS}s") from error


async def remove_box(rt, key):
    async def remove():
        info = await rt.get_info(key)
        if info is None:
            return
        # Admission renames the Box; only its stable ID proves deletion finished.
        box_id = info.id
        while True:
            try:
                await rt.remove(box_id, force=True)
                break
            except boxlite.NotFoundError:
                return
            except boxlite.InvalidArgumentError as error:
                if "state change in progress" not in str(error).lower():
                    raise
                await asyncio.sleep(0.2)
        while await rt.get_info(box_id) is not None:
            await asyncio.sleep(0.2)

    try:
        await asyncio.wait_for(remove(), timeout=LIFECYCLE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        raise AssertionError(f"Box {key} was not removed within {LIFECYCLE_TIMEOUT_SECONDS}s") from error


async def ready_checkpoint(checkpoints, key):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        info = await checkpoints.get(key)
        assert info.state != "failed", f"Checkpoint {info.id} failed"
        if info.state == "ready":
            assert info.size_bytes > 0
            return info
        await asyncio.sleep(1)
    raise AssertionError(f"Checkpoint {key} did not become ready")


async def shell(box, command):
    execution = await box.exec("sh", ["-c", command])
    stdout, stderr = await drain(execution)
    result = await asyncio.wait_for(execution.wait(), timeout=30)
    assert result.exit_code == 0, (result.exit_code, stdout, stderr)
    return stdout


@pytest_asyncio.fixture
async def checkpoint_resources(rt):
    suffix = uuid.uuid4().hex[:12]
    names = {
        key: f"e2e-checkpoint-{key}-{suffix}"
        for key in ["source", "copy", "archive"]
    }
    owned = set()
    yield names, owned
    if not owned:
        return
    failures = []
    # Removing the copy first also releases failed import-use records.
    for key in ["copy", "source"]:
        try:
            await remove_box(rt, names[key])
        except boxlite.NotFoundError:
            pass
        except Exception as error:
            failures.append(f"{names[key]}: {error}")
    try:
        await rt.checkpoints.remove(names["archive"], force=True)
    except Exception as error:
        failures.append(f"{names['archive']}: {error}")
    assert not failures, "Checkpoint E2E cleanup failed: " + "; ".join(failures)


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_checkpoint_archive_survives_source_deletion_and_creates_boxes(
    rt, image, checkpoint_resources
):
    status, config = await asyncio.to_thread(request_json, "GET", "/v1/config")
    assert (
        status == 200
        and config
        and config.get("capabilities", {}).get("checkpoints_enabled") is True
    ), "Deploy this branch's API/runner and configure checkpoint storage before running this case"
    names, owned = checkpoint_resources
    owned.update(names.values())
    marker = uuid.uuid4().hex
    source = await rt.create(
        boxlite.BoxOptions(
            image=image, cpus=1, memory_mib=512,
            env=[("CHECKPOINT_E2E", marker)],
        ),
        name=names["source"],
    )
    await shell(
        source,
        "mkdir -p /workspace; "
        "printf '%s' \"$CHECKPOINT_E2E\" > /workspace/checkpoint-e2e.txt; sync",
    )
    await source.stop()
    await wait_stopped(rt, source.id)
    checkpoint = await rt.checkpoints.create(source.id, names["archive"])
    checkpoint = await ready_checkpoint(rt.checkpoints, checkpoint.id)
    # The immutable archive must retain the captured disk, not this later write.
    source = await rt.get(source.id)
    await source.start()
    await shell(source, "printf changed-after-capture > /workspace/checkpoint-e2e.txt; sync")
    await remove_box(rt, source.id)
    assert (await rt.checkpoints.get(checkpoint.id)).state == "ready"

    copy = await rt.create(
        boxlite.BoxOptions(checkpoint=checkpoint.id), name=names["copy"]
    )
    assert copy.id != source.id
    copy_info = await rt.get_info(copy.id)
    assert copy_info is not None
    assert copy_info.auto_stop == E2E_AUTO_STOP_SECONDS
    assert copy_info.auto_delete == E2E_AUTO_DELETE_SECONDS
    read_captured = (
        "printf '%s\n%s\n' \"$CHECKPOINT_E2E\" \"$BOXLITE_BOX_ID\"; "
        "cat /workspace/checkpoint-e2e.txt"
    )
    assert await shell(copy, read_captured) == f"{marker}\n{copy.id}\n{marker}"

    await rt.checkpoints.remove(checkpoint.id)
    with pytest.raises(boxlite.NotFoundError):
        await rt.checkpoints.get(checkpoint.id)
    assert await shell(copy, "cat /workspace/checkpoint-e2e.txt") == marker
