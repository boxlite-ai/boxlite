"""Managed checkpoints against an actual local VM, without cloud storage."""

import asyncio
import tempfile
from pathlib import Path

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def shell(box, command):
    execution = await box.exec("sh", ["-c", command])

    async def collect(stream):
        return "".join([str(chunk) async for chunk in stream])

    stdout, stderr = await asyncio.gather(
        collect(execution.stdout()), collect(execution.stderr())
    )
    result = await asyncio.wait_for(execution.wait(), 30)
    assert result.exit_code == 0, (result.exit_code, stdout, stderr)
    return stdout


async def test_checkpoint_local_vm_capture_import_and_recover(test_registries):
    # Short paths keep macOS Unix sockets below their 104-byte limit.
    with tempfile.TemporaryDirectory(prefix="bl-cp-", dir="/tmp") as directory:
        root = Path(directory)
        runtime = boxlite.Boxlite(
            boxlite.Options(
                home_dir=str(root / "runtime"),
                checkpoints_dir=str(root / "archives"),
                image_registries=test_registries,
            )
        )
        try:
            source = await runtime.create(
                boxlite.BoxOptions(
                    image="alpine:latest",
                    cpus=1,
                    memory_mib=512,
                    auto_delete=0,
                    env=[("CHECKPOINT_TEST", "captured")],
                ),
                name="source",
            )
            await shell(
                source, "mkdir -p /data; printf captured > /data/checkpoint.txt; sync"
            )
            checkpoint = await runtime.checkpoints.create(source.id, "base")
            assert checkpoint.state == "ready"
            assert checkpoint.size_bytes > 0
            assert list((root / "archives").glob("*/archive.boxlite"))
            await shell(source, "printf changed-later > /data/checkpoint.txt; sync")
            await runtime.remove(source.id, force=True)

            copy = await runtime.checkpoints.create_box(checkpoint.id, "copy")
            assert copy.id != source.id
            assert (
                await shell(
                    copy, "printf '%s\n' \"$CHECKPOINT_TEST\"; cat /data/checkpoint.txt"
                )
                == "captured\ncaptured"
            )
            target = await runtime.create(
                boxlite.BoxOptions(
                    image="alpine:latest",
                    cpus=2,
                    memory_mib=768,
                    auto_delete=0,
                    env=[("CHECKPOINT_TEST", "old-target")],
                ),
                name="target",
            )
            await shell(
                target, "mkdir -p /data; printf old-target > /data/checkpoint.txt; sync"
            )
            await target.stop()
            old_id = target.id
            recovered = await runtime.checkpoints.recover_box(checkpoint.id, old_id)
            assert recovered.id != old_id
            assert recovered.name == "target"
            assert await runtime.get_info(old_id) is None
            info = await recovered.info()
            assert (info.cpus, info.memory_mib) == (1, 512)
            with pytest.raises((boxlite.InvalidStateError, boxlite.StoppedError)):
                await target.start()
            assert (
                await shell(
                    recovered,
                    "printf '%s\n' \"$CHECKPOINT_TEST\"; cat /data/checkpoint.txt",
                )
                == "captured\ncaptured"
            )
            await runtime.checkpoints.remove(checkpoint.id)
            assert await runtime.checkpoints.list() == []
            assert await shell(copy, "cat /data/checkpoint.txt") == "captured"
            assert await shell(recovered, "cat /data/checkpoint.txt") == "captured"
        finally:
            for info in await runtime.list_info():
                await runtime.remove(info.id, force=True)
            await runtime.shutdown()
