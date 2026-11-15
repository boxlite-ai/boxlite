import pytest

import boxlite

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout", [None, 0.0])
async def test_async_exec_without_deadline_returns_full_output(shared_runtime, timeout):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        result = await box.exec("sh", "-c", "sleep 4; echo finished", timeout=timeout)

    assert result.exit_code == 0
    assert result.stdout.strip() == "finished"
    assert result.error_message is None


@pytest.mark.parametrize("timeout", [None, 0.0])
def test_sync_exec_without_deadline_returns_full_output(
    test_registries, tmp_path, timeout
):
    if not hasattr(boxlite, "SyncBoxlite"):
        pytest.skip("greenlet not installed")
    options = boxlite.Options(home_dir=str(tmp_path), image_registries=test_registries)
    with (
        boxlite.SyncBoxlite(options) as runtime,
        boxlite.SyncSimpleBox(image="alpine:latest", runtime=runtime) as box,
    ):
        result = box.exec("sh", "-c", "sleep 4; echo finished", timeout=timeout)

    assert result.exit_code == 0
    assert result.stdout.strip() == "finished"
    assert result.error_message is None
