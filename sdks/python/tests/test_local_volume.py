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
    archive_path = os.path.join(os.sep, "tmp", f"{volume.id}.boxlite")
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
        archive = await box.export(dest=archive_path)
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
        for handle in (box, clone, imported):
            if handle is not None:
                try:
                    await shared_runtime.remove(handle.id, force=True)
                except Exception:
                    pass
        try:
            await shared_runtime.volumes.remove(volume.id)
        except Exception:
            pass
        try:
            os.remove(archive_path)
        except FileNotFoundError:
            pass

    with pytest.raises(boxlite.NotFoundError):
        await shared_runtime.volumes.get(volume.id)
