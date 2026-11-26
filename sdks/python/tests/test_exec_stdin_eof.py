import pytest

import boxlite

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_one_shot_async_exec_closes_stdin(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        result = await box.exec("wc", "-c", timeout=3)

    assert result.exit_code == 0, "wc did not exit after stdin EOF"
    assert result.stdout.strip() == "0"


def test_one_shot_sync_exec_closes_stdin(test_registries, tmp_path):
    if not hasattr(boxlite, "SyncBoxlite"):
        pytest.skip("greenlet not installed")
    options = boxlite.Options(home_dir=str(tmp_path), image_registries=test_registries)
    with (
        boxlite.SyncBoxlite(options) as runtime,
        boxlite.SyncSimpleBox(image="alpine:latest", runtime=runtime) as box,
    ):
        result = box.exec("wc", "-c", timeout=3)

    assert result.exit_code == 0, "wc did not exit after stdin EOF"
    assert result.stdout.strip() == "0"


@pytest.mark.asyncio
async def test_streaming_exec_keeps_stdin_open(shared_runtime):
    box = await shared_runtime.create(
        boxlite.BoxOptions(image="alpine:latest", auto_remove=True)
    )
    try:
        execution = await box.exec("wc", ["-c"], timeout_secs=3)
        stdin = execution.stdin()
        await stdin.send_input(b"hello")
        await stdin.close()
        output = [line async for line in execution.stdout()]
        result = await execution.wait()
    finally:
        await box.stop()

    assert result.exit_code == 0
    assert "".join(output).strip() == "5"
