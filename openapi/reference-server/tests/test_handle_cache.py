from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SERVER_DIR = SERVER_PATH.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))


def _install_boxlite_stub() -> None:
    if "boxlite" in sys.modules:
        return

    module = types.ModuleType("boxlite")

    class _Noop:
        def __init__(self, *args, **kwargs):
            pass

    class _SecurityOptions:
        @staticmethod
        def development():
            return object()

        @staticmethod
        def standard():
            return object()

        @staticmethod
        def maximum():
            return object()

    module.Boxlite = _Noop
    module.Options = _Noop
    module.BoxOptions = _Noop
    module.CloneOptions = _Noop
    module.ExportOptions = _Noop
    module.SnapshotOptions = _Noop
    module.CopyOptions = _Noop
    module.SecurityOptions = _SecurityOptions
    sys.modules["boxlite"] = module


_install_boxlite_stub()

SPEC = importlib.util.spec_from_file_location("reference_server_app", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Failed to load server module spec from {SERVER_PATH}")
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)


def _make_box_info(box_id: str, *, name: str = "test-box", status: str = "created"):
    return SimpleNamespace(
        id=box_id,
        name=name,
        state=SimpleNamespace(status=status, pid=12345),
        created_at="2026-02-22T00:00:00+00:00",
        image="alpine:latest",
        cpus=2,
        memory_mib=512,
    )


def _make_box_handle(box_id: str, *, name: str = "test-box"):
    info = _make_box_info(box_id, name=name)
    handle = SimpleNamespace(info=lambda: info)
    handle.start = AsyncMock()
    handle.stop = AsyncMock()
    handle.clone = AsyncMock()
    return handle


class _DummyRequest:
    def __init__(self, payload: bytes):
        self._payload = payload

    async def body(self) -> bytes:
        return self._payload


class HandleCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        SERVER.state.runtime = None
        SERVER.state.server_config = None
        SERVER.state.runtime_config = None
        SERVER.state.active_executions = {}
        SERVER.state.active_boxes_by_id = {}
        SERVER.state.active_boxes_lock = asyncio.Lock()

    async def test_cache_is_keyed_by_id_only(self) -> None:
        handle = _make_box_handle("box-123", name="friendly-name")

        cached_id = await SERVER.cache_box_handle(handle)

        self.assertEqual(cached_id, "box-123")
        self.assertIn("box-123", SERVER.state.active_boxes_by_id)
        self.assertNotIn("friendly-name", SERVER.state.active_boxes_by_id)

    async def test_get_box_or_404_uses_cache_hit_before_runtime_get(self) -> None:
        handle = _make_box_handle("box-123")
        SERVER.state.active_boxes_by_id["box-123"] = handle
        runtime = SimpleNamespace(get=AsyncMock(side_effect=AssertionError("unexpected call")))
        SERVER.state.runtime = runtime

        resolved = await SERVER.get_box_or_404("box-123")

        self.assertIs(resolved, handle)
        runtime.get.assert_not_called()

    async def test_get_box_or_404_caches_runtime_lookup_result(self) -> None:
        handle = _make_box_handle("box-canonical")
        runtime = SimpleNamespace(get=AsyncMock(return_value=handle))
        SERVER.state.runtime = runtime

        resolved = await SERVER.get_box_or_404("friendly-name")

        self.assertIs(resolved, handle)
        runtime.get.assert_awaited_once_with("friendly-name")
        self.assertIs(SERVER.state.active_boxes_by_id["box-canonical"], handle)

    async def test_get_box_or_404_missing_returns_404(self) -> None:
        runtime = SimpleNamespace(get=AsyncMock(return_value=None))
        SERVER.state.runtime = runtime

        with self.assertRaises(SERVER.HTTPException) as ctx:
            await SERVER.get_box_or_404("missing-box")

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("box not found", ctx.exception.detail["error"]["message"])

    async def test_create_box_caches_handle(self) -> None:
        handle = _make_box_handle("box-create")
        runtime = SimpleNamespace(create=AsyncMock(return_value=handle))
        SERVER.state.runtime = runtime

        with patch.object(SERVER, "build_box_options", return_value=object()):
            response = await SERVER.create_box(
                "demo", SERVER.CreateBoxRequest(), _auth={}
            )

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["box_id"], "box-create")
        self.assertIn("box-create", SERVER.state.active_boxes_by_id)

    async def test_clone_box_caches_cloned_handle(self) -> None:
        source = _make_box_handle("box-source")
        cloned = _make_box_handle("box-cloned")
        source.clone = AsyncMock(return_value=cloned)
        runtime = SimpleNamespace(get=AsyncMock(return_value=source))
        SERVER.state.runtime = runtime

        response = await SERVER.clone_box(
            "demo", "box-source", SERVER.CloneBoxRequest(name="copy"), _auth={}
        )

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["box_id"], "box-cloned")
        self.assertIn("box-cloned", SERVER.state.active_boxes_by_id)

    async def test_import_box_caches_imported_handle(self) -> None:
        imported = _make_box_handle("box-imported")
        runtime = SimpleNamespace(import_box=AsyncMock(return_value=imported))
        SERVER.state.runtime = runtime
        request = _DummyRequest(b"fake archive")

        response = await SERVER.import_box("demo", request, name=None, _auth={})

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["box_id"], "box-imported")
        self.assertIn("box-imported", SERVER.state.active_boxes_by_id)

    async def test_stop_box_evicts_cached_handle_by_canonical_id(self) -> None:
        handle = _make_box_handle("box-stop")
        SERVER.state.active_boxes_by_id["box-stop"] = handle
        runtime = SimpleNamespace(get=AsyncMock(return_value=handle))
        SERVER.state.runtime = runtime

        response = await SERVER.stop_box("demo", "box-stop", req=None, _auth={})

        self.assertEqual(response["box_id"], "box-stop")
        self.assertNotIn("box-stop", SERVER.state.active_boxes_by_id)
        runtime.get.assert_not_called()

    async def test_remove_box_evicts_cached_handle_using_canonical_id(self) -> None:
        cached = _make_box_handle("box-canonical")
        SERVER.state.active_boxes_by_id["box-canonical"] = cached
        runtime = SimpleNamespace(
            get_info=AsyncMock(return_value=_make_box_info("box-canonical")),
            remove=AsyncMock(return_value=None),
        )
        SERVER.state.runtime = runtime

        response = await SERVER.remove_box(
            "demo", "friendly-name", force=False, _auth={}
        )

        self.assertEqual(response.status_code, 204)
        runtime.get_info.assert_awaited_once_with("friendly-name")
        runtime.remove.assert_awaited_once_with("friendly-name", force=False)
        self.assertNotIn("box-canonical", SERVER.state.active_boxes_by_id)


if __name__ == "__main__":
    unittest.main()
