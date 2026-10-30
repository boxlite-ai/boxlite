"""Live execution inventory and non-booting convenience API."""

import asyncio
import pytest

import boxlite
from boxlite.simplebox import SimpleBox


@pytest.mark.asyncio
async def test_unstarted_simplebox_inventory_does_not_create():
    box = object.__new__(SimpleBox)
    box._started = False
    box._box = None
    assert await box.list_executions() == []
    assert box._box is None


@pytest.mark.integration
@pytest.mark.asyncio
async def test_native_inventory_includes_main_and_exec_without_boot(shared_runtime):
    box = await shared_runtime.create(
        boxlite.BoxOptions(
            image="alpine:latest", cmd=["sleep", "300"], auto_remove=False
        )
    )
    try:
        before = await box.info()
        assert await box.list_executions() == []
        assert (await box.info()).state.status == before.state.status
        await box.start()
        execution = await box.exec("sleep", ["300"], tty=True)
        inventory = await box.list_executions()
        assert any(info.is_main for info in inventory)
        info = next(info for info in inventory if info.execution_id == execution.id())
        assert isinstance(info, boxlite.ExecutionInfo)
        assert info.argv == ["sleep", "300"]
        assert info.pid > 0
        assert info.started_at > 0
        assert info.tty is True
        assert info.is_main is False
        with pytest.raises(AttributeError):
            info.pid = 0
        control = await box.get_execution(info.execution_id)
        await control.kill()
        await control.wait()
        assert all(
            item.execution_id != execution.id() for item in await box.list_executions()
        )
    finally:
        await shared_runtime.remove(box.id, force=True)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_simplebox_inventory_recovers_main_output(shared_runtime):
    box = SimpleBox(
        image="alpine:latest",
        runtime=shared_runtime,
        auto_remove=False,
        cmd=["sh", "-c", "while true; do echo recovered-wrapper; sleep 0.1; done"],
    )
    await box.start()
    try:
        main = next(info for info in await box.list_executions() if info.is_main)
        reader = await box.attach(main.execution_id, stdin=False)
        output = reader.stdout()

        async def read_marker():
            text = ""
            async for chunk in output:
                text += chunk
                if "recovered-wrapper" in text:
                    return text
            return text

        assert "recovered-wrapper" in await asyncio.wait_for(read_marker(), 5)
        control = await box.get_execution(main.execution_id)
        await control.kill()
        await reader.wait()
        assert await box.list_executions() == []
    finally:
        await shared_runtime.remove(box.id, force=True)
