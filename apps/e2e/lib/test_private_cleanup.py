"""Exercise the private-image case's cleanup without SDK or VM fixtures."""

import runpy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call, patch

PRIVATE_CASE = Path(__file__).resolve().parents[1] / "cases/test_images_private.py"


class PrivateCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_login_removal_is_retried_by_teardown(self):
        pytest = MagicMock()
        pytest.mark.asyncio.side_effect = lambda function: function
        pytest_asyncio = MagicMock()
        pytest_asyncio.fixture.side_effect = lambda **kwargs: lambda function: function
        dependencies = {
            "pytest": pytest,
            "pytest_asyncio": pytest_asyncio,
            "boxlite": SimpleNamespace(NotFoundError=FileNotFoundError),
            "e2e_auth": MagicMock(),
        }
        with patch.dict(sys.modules, dependencies):
            case = runpy.run_path(str(PRIVATE_CASE))
        runtime = SimpleNamespace(
            images=SimpleNamespace(
                get=AsyncMock(),
                registries=SimpleNamespace(
                    list=AsyncMock(return_value=[]),
                    remove=AsyncMock(
                        side_effect=[ConnectionError("delete failed"), None]
                    ),
                ),
            ),
            remove=AsyncMock(),
        )
        fixture = case["only_what_this_case_made"](runtime)
        await anext(fixture)
        case["state"].update(
            login=SimpleNamespace(id="login-1"),
            box=SimpleNamespace(id="box-1"),
            boxes=["box-1"],
        )
        with self.assertRaisesRegex(ConnectionError, "delete failed"):
            await case["test_once_the_box_is_gone_the_login_can_be"](runtime)
        with self.assertRaises(StopAsyncIteration):
            await anext(fixture)
        self.assertEqual(
            runtime.images.registries.remove.await_args_list,
            [call("login-1"), call("login-1")],
        )


if __name__ == "__main__":
    unittest.main()
