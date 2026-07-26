"""
Integration tests for box management functionality in the Python SDK.

These tests exercise the new runtime-oriented API that lives on the
``boxlite.Boxlite`` object.  They launch real VMs, so we mark them as
``integration``.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

import pytest
import pytest_asyncio

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


class RuntimeHarness:
    """Utility wrapper that keeps Box objects tidy for each test."""

    def __init__(self, runtime: boxlite.Boxlite) -> None:
        self._runtime = runtime
        self._boxes = []

    async def create_box(
        self,
        *,
        image: str = "alpine:latest",
        name: str | None = None,
        cpus: int | None = None,
        memory_mib: int | None = None,
        working_dir: str | None = None,
        env: list[tuple[str, str]] | None = None,
    ):
        opts = boxlite.BoxOptions(
            image=image,
            cpus=cpus,
            memory_mib=memory_mib,
            working_dir=working_dir,
            env=env or [],
        )
        box = await self._runtime.create(opts, name=name)
        self._boxes.append(box)
        return box

    async def list(self):
        return await self._runtime.list_info()

    async def get_info(self, box_id: str):
        return await self._runtime.get_info(box_id)

    async def remove(self, box_id: str):
        return await self._runtime.remove(box_id)

    def forget(self, box) -> None:
        try:
            self._boxes.remove(box)
        except ValueError:
            pass

    # Note: close() removed - shared runtime is managed by session fixture


@pytest_asyncio.fixture
async def runtime(shared_runtime):
    """Wrap the shared async runtime for box lifecycle management."""
    harness = RuntimeHarness(shared_runtime)
    try:
        yield harness
    finally:
        # Clean up boxes created by this test, but don't close the shared runtime
        for box in list(harness._boxes):
            with suppress(RuntimeError):
                await box.stop()
            with suppress(RuntimeError):
                await harness.remove(box.id)


class TestBoxManagement:
    """Test box lifecycle management features."""

    async def test_box_has_id(self, runtime):
        box = await runtime.create_box()
        assert hasattr(box, "id")
        assert box.id is not None
        assert len(box.id) == 12  # Base62 format

    async def test_box_ids_are_unique(self, runtime):
        box1 = await runtime.create_box()
        box2 = await runtime.create_box()
        assert box1.id != box2.id

    async def test_box_ids_are_unique_strings(self, runtime):
        """IDs are unique 12-char Base62 strings (not time-sortable)."""
        box1 = await runtime.create_box()
        box2 = await runtime.create_box()
        assert isinstance(box1.id, str)
        assert isinstance(box2.id, str)
        assert len(box1.id) == 12
        assert len(box2.id) == 12
        assert box1.id != box2.id

    async def test_box_info(self, runtime):
        box = await runtime.create_box(image="python:3.11", cpus=4, memory_mib=1024)
        info = await runtime.get_info(box.id)
        assert info is not None
        assert info.id == box.id
        assert info.state.status in {"configured", "running"}
        assert info.image == "python:3.11"
        assert info.cpus == 4
        assert info.memory_mib == 1024

    async def test_list_boxes(self, runtime):
        boxes = [await runtime.create_box() for _ in range(3)]
        infos = await runtime.list()
        assert len(infos) >= len(boxes)
        ids = {info.id for info in infos}
        for box in boxes:
            assert box.id in ids

    async def test_list_running(self, runtime):
        boxes = [await runtime.create_box() for _ in range(2)]
        running = await runtime.list()
        ids = {box.id for box in boxes}
        # Boxes may be in configured or running state
        active_ids = {
            info.id
            for info in running
            if info.state.status in {"configured", "running"}
        }
        assert ids.issubset(active_ids)

    async def test_list_boxes_sorted_by_creation(self, runtime):
        box1 = await runtime.create_box()
        await asyncio.sleep(0.01)
        box2 = await runtime.create_box()
        await asyncio.sleep(0.01)
        box3 = await runtime.create_box()

        our_infos = [
            info
            for info in await runtime.list()
            if info.id in {box1.id, box2.id, box3.id}
        ]
        assert len(our_infos) == 3
        assert our_infos[0].id == box3.id
        assert our_infos[1].id == box2.id
        assert our_infos[2].id == box1.id

    async def test_get_box_info_by_id(self, runtime):
        box = await runtime.create_box()
        info = await runtime.get_info(box.id)
        assert info is not None
        assert info.id == box.id
        assert info.state.status in {"configured", "running"}

    async def test_get_box_info_nonexistent(self, runtime):
        assert await runtime.get_info("nonexistent-id-12345678901") is None

    async def test_box_state_transitions(self, runtime):
        # Need auto_remove=False to check stopped state and manually remove
        opts = boxlite.BoxOptions(image="alpine:latest", auto_remove=False)
        box = await runtime._runtime.create(opts)
        runtime._boxes.append(box)
        info = await runtime.get_info(box.id)
        assert info.state.status in {"configured", "running"}
        # Ensure box is running before stopping (configured → running → stopped)
        result = await box.exec("echo", ["ready"])
        await result.wait()
        await box.stop()
        state_after_shutdown = await runtime.get_info(box.id)
        assert state_after_shutdown is not None
        assert state_after_shutdown.state.status == "stopped"
        await runtime.remove(box.id)
        runtime.forget(box)
        assert await runtime.get_info(box.id) is None

    async def test_remove_box(self, runtime):
        # Need auto_remove=False to manually remove the box
        opts = boxlite.BoxOptions(image="alpine:latest", auto_remove=False)
        box = await runtime._runtime.create(opts)
        runtime._boxes.append(box)
        await box.stop()
        await runtime.remove(box.id)
        runtime.forget(box)
        assert await runtime.get_info(box.id) is None

    async def test_cannot_remove_running_box(self, runtime):
        box = await runtime.create_box()
        # Ensure box is running by executing a command
        await box.exec("true")
        with pytest.raises(RuntimeError):
            await runtime.remove(box.id)

    async def test_box_metadata_storage(self, runtime):
        box = await runtime.create_box(image="node:18", cpus=8, memory_mib=2048)
        info = await runtime.get_info(box.id)
        assert info.image == "node:18"
        assert info.cpus == 8
        assert info.memory_mib == 2048

    async def test_runtime_list_returns_boxinfo(self, runtime):
        await runtime.create_box()
        infos = await runtime.list()
        assert infos
        assert all(isinstance(info, boxlite.BoxInfo) for info in infos)

    async def test_box_info_attributes(self, runtime):
        box = await runtime.create_box()
        info = await runtime.get_info(box.id)
        assert isinstance(info.id, str)
        assert isinstance(info.state.status, str)
        assert isinstance(info.created_at, str)
        assert info.state.pid is None or isinstance(info.state.pid, int)
        assert isinstance(info.image, str)
        assert isinstance(info.cpus, int)
        assert isinstance(info.memory_mib, int)

    async def test_multiple_boxes_isolated(self, runtime):
        boxes = [await runtime.create_box() for _ in range(5)]
        ids = {box.id for box in boxes}
        infos = await runtime.list()
        listed_ids = {info.id for info in infos}
        assert ids.issubset(listed_ids)


class TestBoxInfoObject:
    """Test BoxInfo object properties."""

    async def test_box_info_is_serializable(self, runtime):
        box = await runtime.create_box()
        info = await runtime.get_info(box.id)
        data = {
            "id": info.id,
            "state": info.state.status,
            "created_at": info.created_at,
            "pid": info.state.pid,
            "image": info.image,
            "cpus": info.cpus,
            "memory_mib": info.memory_mib,
        }
        assert data["id"] == box.id
        assert data["state"] in {"configured", "running"}  # May be configured initially

    async def test_box_info_state_values(self, runtime):
        box = await runtime.create_box()
        info = await runtime.get_info(box.id)
        assert info.state.status in {"configured", "running", "stopped", "failed"}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
