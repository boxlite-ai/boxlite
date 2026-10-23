"""Cold create recovery must retain the accepted Box and bound polling."""

import asyncio
import contextlib
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/infra-local"))
try:
    from compose.provision import create_ready
finally:
    sys.path.pop(0)

STARTUP_TIMEOUT = (
    "internal error: server timed out: Timed out waiting for box box-1 to reach started"
)


def fixture():
    box = SimpleNamespace(
        id="box-1",
        info=AsyncMock(
            return_value=SimpleNamespace(state=SimpleNamespace(status="running"))
        ),
    )
    runtime = SimpleNamespace(
        create=AsyncMock(side_effect=RuntimeError(STARTUP_TIMEOUT)),
        get=AsyncMock(return_value=box),
    )
    return runtime, box


class RunnerProvisionTest(unittest.IsolatedAsyncioTestCase):
    async def test_cold_create_recovers_the_accepted_box_without_a_second_post(self):
        runtime, box = fixture()
        options = object()
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                result = await create_ready(runtime, options, "cold-proof", timeout=1)
            except RuntimeError as error:
                result = error
        self.assertIs(
            result, box, "the accepted cold-pull Box must survive the API wait timeout"
        )
        runtime.create.assert_awaited_once()
        runtime.get.assert_awaited_once_with("cold-proof")

    async def test_unrelated_errors_are_not_recovered(self):
        for message in ("permission denied", "server timed out: storage unavailable"):
            with self.subTest(message=message):
                runtime, _ = fixture()
                error = RuntimeError(message)
                runtime.create.side_effect = error
                with self.assertRaises(RuntimeError) as caught:
                    await create_ready(runtime, object(), "cold-proof", timeout=1)
                self.assertIs(caught.exception, error)
                runtime.get.assert_not_awaited()

    async def test_recovery_rejects_a_different_box_with_the_same_name(self):
        runtime, box = fixture()
        box.id = "other-box"
        with self.assertRaisesRegex(RuntimeError, "box-1.*other-box"):
            await create_ready(runtime, object(), "cold-proof", timeout=1)
        runtime.create.assert_awaited_once()

    async def test_total_deadline_bounds_recovery(self):
        runtime, box = fixture()
        box.info.return_value.state.status = "configured"
        with self.assertRaises(TimeoutError):
            await create_ready(runtime, object(), "cold-proof", timeout=0.02)
        runtime.create.assert_awaited_once()
        runtime.get.assert_awaited_once_with("cold-proof")

    async def test_total_deadline_also_bounds_the_initial_post(self):
        runtime, _ = fixture()

        async def stalled_create(*args, **kwargs):
            await asyncio.Event().wait()

        runtime.create.side_effect = stalled_create
        with self.assertRaises(TimeoutError):
            await create_ready(runtime, object(), "cold-proof", timeout=0.02)
        runtime.create.assert_awaited_once()
        runtime.get.assert_not_awaited()

    async def test_recovery_waits_for_visibility_and_running(self):
        runtime, box = fixture()
        runtime.get.side_effect = [None, box, box]
        box.info.side_effect = [
            SimpleNamespace(state=SimpleNamespace(status="configured")),
            SimpleNamespace(state=SimpleNamespace(status="running")),
        ]
        result = await create_ready(runtime, object(), "cold-proof", timeout=2)
        self.assertIs(result, box)
        runtime.create.assert_awaited_once()
        self.assertEqual(runtime.get.await_count, 3)

    async def test_failed_box_is_reported_without_waiting_for_deadline(self):
        runtime, box = fixture()
        box.info.return_value.state.status = "failed"
        with self.assertRaisesRegex(RuntimeError, "box-1.*failed"):
            await create_ready(runtime, object(), "cold-proof", timeout=1)

    async def test_successful_create_does_not_lookup_again(self):
        runtime, box = fixture()
        runtime.create.side_effect = None
        runtime.create.return_value = box
        options = object()
        result = await create_ready(runtime, options, "cold-proof", timeout=1)
        self.assertIs(result, box)
        runtime.create.assert_awaited_once_with(options, name="cold-proof")
        runtime.get.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
