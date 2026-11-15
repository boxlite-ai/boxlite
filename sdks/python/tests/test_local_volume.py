from __future__ import annotations

import os
import uuid

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def test_local_volume_shared_by_boxes_clone_and_import(shared_runtime):
    volume = await shared_runtime.volumes.create(name=f"sdk-{uuid.uuid4()}")
    box = None
    clone = None
    imported = None
    try:
        box = await shared_runtime.create(
            boxlite.BoxOptions(
                image="alpine:latest",
                volumes=[
                    {
                        "managed_volume": volume.name,
                        "guest_path": "/workspace",
                        "read_only": False,
                    }
                ],
                auto_delete=0,
                detach=False,
            )
        )
        execution = await box.exec(
            "sh",
            [
                "-c",
                "mkdir -p /workspace/team/backend; echo sdk-data > /workspace/team/backend/result.txt",
            ],
        )
        result = await execution.wait()
        assert result.exit_code == 0, result.stderr
        archive = await box.export(
            dest=os.path.join(os.sep, "tmp", f"{volume.id}.boxlite")
        )
        clone = await box.clone_box()
        execution = await clone.exec("cat", ["/workspace/team/backend/result.txt"])
        stdout = "".join([chunk async for chunk in execution.stdout()])
        result = await execution.wait()
        assert result.exit_code == 0, result.stderr
        assert "sdk-data" in stdout
        with pytest.raises(Exception, match="referenced"):
            await shared_runtime.volumes.remove(volume.id)
        await shared_runtime.remove(box.id, force=True)
        box = None
        with pytest.raises(Exception, match="referenced"):
            await shared_runtime.volumes.remove(volume.id)
        await shared_runtime.remove(clone.id, force=True)
        clone = None
        imported = await shared_runtime.import_box(archive)
        execution = await imported.exec("cat", ["/workspace/team/backend/result.txt"])
        stdout = "".join([chunk async for chunk in execution.stdout()])
        result = await execution.wait()
        assert result.exit_code == 0, result.stderr
        assert "sdk-data" in stdout
        with pytest.raises(Exception, match="referenced"):
            await shared_runtime.volumes.remove(volume.id)
        await shared_runtime.remove(imported.id, force=True)
        imported = None
        await shared_runtime.volumes.remove(volume.id)
    finally:
        if box is not None:
            await shared_runtime.remove(box.id, force=True)
        if clone is not None:
            await shared_runtime.remove(clone.id, force=True)
        if imported is not None:
            await shared_runtime.remove(imported.id, force=True)
        with pytest.raises(boxlite.NotFoundError):
            await shared_runtime.volumes.get(volume.id)
