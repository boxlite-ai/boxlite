"""Real REST/API/runner/VM checkpoint acceptance; requires configured storage.

No fallback or missing-capability skip: run against the branch's deployed stack.
This case creates two concurrent Boxes and is deliberately outside smoke tests.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import boxlite
import pytest
import pytest_asyncio
from conftest import drain
from e2e_auth import request_json


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
        for key in ["source", "copy", "target", "archive"]
    }
    owned = set()
    yield names, owned
    if not owned:
        return
    failures = []
    # Cancelling targets first also releases failed import-use records.
    for key in ["target", "copy", "source"]:
        try:
            info = await rt.get_info(names[key])
            if info is not None:
                await rt.remove(info.id, force=True)
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
async def test_checkpoint_archive_survives_source_deletion_and_recovers_public_identity(
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
    checkpoint = await rt.checkpoints.create(source.id, names["archive"])
    checkpoint = await ready_checkpoint(rt.checkpoints, checkpoint.id)
    # The immutable archive must retain the captured disk, not this later write.
    await shell(source, "printf changed-after-capture > /workspace/checkpoint-e2e.txt; sync")
    await rt.remove(source.id, force=True)
    assert (await rt.checkpoints.get(checkpoint.id)).state == "ready"

    copy = await rt.checkpoints.create_box(checkpoint.id, names["copy"])
    assert copy.id != source.id
    read_captured = (
        "printf '%s\n%s\n' \"$CHECKPOINT_E2E\" \"$BOXLITE_BOX_ID\"; "
        "cat /workspace/checkpoint-e2e.txt"
    )
    assert await shell(copy, read_captured) == f"{marker}\n{copy.id}\n{marker}"

    target = await rt.create(
        boxlite.BoxOptions(
            image=image, cpus=2, memory_mib=1024,
            env=[("CHECKPOINT_E2E", "old-target")],
        ),
        name=names["target"],
    )
    await shell(target, "mkdir -p /workspace; printf old-target > /workspace/checkpoint-e2e.txt")
    await target.stop()
    public_id = target.id
    recovered = await rt.checkpoints.recover_box(checkpoint.id, public_id)
    assert recovered.id == public_id
    assert recovered.name == names["target"]
    info = await recovered.info()
    assert (info.cpus, info.memory_mib) == (1, 512)
    await recovered.start()
    assert await shell(recovered, read_captured) == f"{marker}\n{public_id}\n{marker}"

    await rt.checkpoints.remove(checkpoint.id)
    with pytest.raises(boxlite.NotFoundError):
        await rt.checkpoints.get(checkpoint.id)
    assert await shell(copy, "cat /workspace/checkpoint-e2e.txt") == marker
    assert await shell(recovered, "cat /workspace/checkpoint-e2e.txt") == marker
