from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import sys
import tarfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, MagicMock, patch

from pydantic import ValidationError


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

    # BoxOptions does NOT get the permissive stub. The real thing is PyBoxOptions,
    # whose #[pyo3(signature = (...))] enumerates every accepted keyword and has
    # no **kwargs catch-all — so a name the SDK does not declare is a TypeError
    # at the call site, not a silently ignored kwarg. A `**kwargs` stub here
    # cannot see that, which is exactly how build_box_options came to forward a
    # `tty` the SDK had no parameter for.
    #
    # Keep this list in sync with the signature in sdks/python/src/options.rs.
    _BOX_OPTIONS_KWARGS = frozenset(
        {
            "image",
            "rootfs_path",
            "cpus",
            "memory_mib",
            "disk_size_gb",
            "working_dir",
            "env",
            "volumes",
            "network",
            "ports",
            "auto_remove",
            "auto_stop",
            "auto_delete",
            "auto_resume",
            "detach",
            "entrypoint",
            "cmd",
            "user",
            "tty",
            "advanced",
            "secrets",
        }
    )

    class _BoxOptions:
        def __init__(self, **kwargs):
            unknown = sorted(set(kwargs) - _BOX_OPTIONS_KWARGS)
            if unknown:
                raise TypeError(
                    f"BoxOptions() got an unexpected keyword argument {unknown[0]!r}"
                )
            self.kwargs = kwargs

    module.Boxlite = _Noop
    module.Options = _Noop
    module.BoxOptions = _BoxOptions
    module.AdvancedBoxOptions = _Noop
    module.ContainerCapabilities = _Noop
    module.CloneOptions = _Noop
    module.ExportOptions = _Noop
    module.SnapshotOptions = _Noop
    module.CopyOptions = _Noop
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
        state=SimpleNamespace(status=status, pid=12345, exit_code=None),
        created_at="2026-02-22T00:00:00+00:00",
        image="alpine:latest",
        cpus=2,
        memory_mib=512,
        privileged=None,
    )


def _make_box_handle(box_id: str, *, name: str = "test-box"):
    info = _make_box_info(box_id, name=name)
    handle = SimpleNamespace(id=box_id, info=AsyncMock(return_value=info))
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
    def test_box_metadata_reports_known_privilege_and_omits_unknown(self) -> None:
        """The response preserves the native metadata's privilege knowledge."""
        for privileged in (False, True, None):
            with self.subTest(privileged=privileged):
                info = _make_box_info("box-privilege")
                info.privileged = privileged

                response = SERVER.box_info_to_dict(info)

                if privileged is None:
                    self.assertNotIn("privileged", response)
                else:
                    self.assertIs(response["privileged"], privileged)

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

    def test_create_request_rejects_remote_port_publication(self) -> None:
        with self.assertRaises(ValidationError):
            SERVER.CreateBoxRequest.model_validate(
                {"ports": [{"guest_port": 3000}]}
            )

    def test_create_request_rejects_client_supplied_security_policy(self) -> None:
        # Sandbox security is the operator's policy, set server-side. A client
        # that could pick a preset would be choosing its own isolation level --
        # `development` turns jailer, seccomp and close_fds off. The field is
        # absent from the schema, and `extra="forbid"` turns any attempt into a
        # validation error. The Rust core (src/boxlite/src/rest/types.rs) and
        # `boxlite serve` (src/cli/src/commands/serve/types.rs) refuse it the
        # same way and for the same reason.
        for preset in ("development", "standard", "maximum"):
            with self.assertRaises(ValidationError):
                SERVER.CreateBoxRequest.model_validate({"security": preset})

    def test_create_request_carries_tty_to_box_options(self) -> None:
        # `boxlite serve` has implemented tty since it existed and the Rust
        # client sends it (rest/types.rs), but this server forbids unknown
        # fields — so `boxlite run -t` against it was a 422 until the field was
        # declared here and in openapi/box.openapi.yaml.
        request = SERVER.CreateBoxRequest.model_validate(
            {"image": "alpine:latest", "tty": True}
        )

        # No patching: the stub BoxOptions rejects a keyword the real
        # PyBoxOptions does not declare, so this crosses the boundary that
        # decides whether `boxlite run -t` works or raises TypeError.
        options = SERVER.build_box_options(request)

        self.assertEqual(options.kwargs.get("tty"), True)

    def test_create_request_omits_tty_when_not_asked_for(self) -> None:
        request = SERVER.CreateBoxRequest.model_validate({"image": "alpine:latest"})

        options = SERVER.build_box_options(request)

        self.assertNotIn("tty", options.kwargs)

    def test_dedicated_ports_route_is_removed(self) -> None:
        paths = {route.path for route in SERVER.app.routes}
        self.assertNotIn("/v1/{prefix}/boxes/{box_id}/ports", paths)

    def test_build_box_options_forwards_capability_policy(self) -> None:
        request = SERVER.CreateBoxRequest(
            advanced=SERVER.CreateBoxAdvancedOptions(
                capabilities=SERVER.ContainerCapabilities(
                    add=["SYS_ADMIN"],
                    drop=["CAP_NET_RAW"],
                )
            ),
        )

        capabilities = object()
        advanced = object()
        with (
            patch.object(
                SERVER.boxlite,
                "ContainerCapabilities",
                return_value=capabilities,
            ) as capabilities_constructor,
            patch.object(
                SERVER.boxlite,
                "AdvancedBoxOptions",
                return_value=advanced,
            ) as advanced_constructor,
            patch.object(
                SERVER.boxlite,
                "BoxOptions",
                return_value=object(),
            ) as constructor,
        ):
            SERVER.build_box_options(request)

        capabilities_constructor.assert_called_once_with(
            add=["SYS_ADMIN"],
            drop=["CAP_NET_RAW"],
        )
        advanced_constructor.assert_called_once_with(
            capabilities=capabilities, privileged=False
        )
        constructor.assert_called_once_with(
            image="alpine:latest",
            advanced=advanced,
            detach=False,
        )

    def test_create_box_rejects_malformed_capability_policy(self) -> None:
        for capability in ("NET-ADMIN", "123", "ß"):
            with self.assertRaises(ValueError):
                SERVER.CreateBoxRequest(
                    advanced=SERVER.CreateBoxAdvancedOptions(
                        capabilities=SERVER.ContainerCapabilities(add=[capability])
                    )
                )

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
        runtime.import_box.assert_awaited_once_with(
            ANY, name=None, untrusted=True
        )

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
        cached = _make_box_handle("box-canonical", name="friendly-name")
        SERVER.state.active_boxes_by_id["box-canonical"] = cached
        runtime = SimpleNamespace(
            list_info=AsyncMock(return_value=[await cached.info()]),
            remove=AsyncMock(return_value=None),
        )
        SERVER.state.runtime = runtime

        response = await SERVER.remove_box(
            "demo", "friendly-name", force=False, _auth={}
        )

        self.assertEqual(response.status_code, 204)
        runtime.list_info.assert_awaited_once_with()
        runtime.remove.assert_awaited_once_with("friendly-name", force=False)
        self.assertNotIn("box-canonical", SERVER.state.active_boxes_by_id)

    async def test_head_uses_snapshot_lookup_without_attaching_handle(self) -> None:
        info = _make_box_info("box-head")
        runtime = SimpleNamespace(list_info=AsyncMock(return_value=[info]))
        SERVER.state.runtime = runtime

        response = await SERVER.box_exists("demo", "box-head", _auth={})

        self.assertEqual(response.status_code, 204)
        runtime.list_info.assert_awaited_once_with()


def _tar_of(entries: dict[str, bytes | None]) -> bytes:
    """An archive holding `entries`: bytes for a file, None for a directory."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            if data is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class UploadSourceTests(unittest.IsolatedAsyncioTestCase):
    """What `upload_files` hands `copy_in` after extracting an upload.

    Into an existing destination the SDK copies a directory under its own
    name unless the source ends in `/.`, so the server must not hand it the
    extraction directory itself.
    """

    async def asyncSetUp(self) -> None:
        SERVER.state.active_boxes_by_id = {}
        SERVER.state.active_boxes_lock = asyncio.Lock()

    async def _copied_source(self, archive: bytes) -> tuple[str, bool]:
        seen: dict[str, object] = {}

        async def copy_in(source, path, options):
            seen["source"] = source
            seen["is_file"] = os.path.isfile(source)

        handle = _make_box_handle("box-upload")
        handle.copy_in = AsyncMock(side_effect=copy_in)
        SERVER.state.active_boxes_by_id["box-upload"] = handle

        response = await SERVER.upload_files(
            "demo",
            "box-upload",
            path="/root/dst",
            overwrite=True,
            request=_DummyRequest(archive),
            _auth={},
        )

        self.assertEqual(response.status_code, 204)
        return seen["source"], seen["is_file"]

    async def test_a_lone_file_is_copied_by_itself(self) -> None:
        # It must land *as* `path`, as it did when the server copied the
        # extraction directory's contents with include_parent=False.
        source, is_file = await self._copied_source(_tar_of({"notes.txt": b"hi"}))

        self.assertTrue(source.endswith(os.sep + "notes.txt"), source)
        self.assertTrue(is_file)

    async def test_anything_else_is_copied_as_the_extracted_contents(self) -> None:
        source, _ = await self._copied_source(
            _tar_of({"proj/": None, "proj/a.txt": b"a"})
        )

        self.assertTrue(source.endswith(os.sep + "extracted/."), source)


class _FakeExecution:
    def __init__(self, execution_id: str) -> None:
        self._id = execution_id
        self._done = asyncio.Event()
        self.killed = False
        self.resized: tuple[int, int] | None = None

    def id(self) -> str:
        return self._id

    async def wait(self):
        await self._done.wait()
        return SimpleNamespace(exit_code=None, error_message=None)

    async def kill(self) -> None:
        self.killed = True

    async def resize_tty(self, rows: int, cols: int) -> None:
        self.resized = (rows, cols)

    def finish(self) -> None:
        self._done.set()


def _make_execution_info(
    execution_id: str,
    *,
    started_at: int = 1_700_000_000_000,
    main: bool = False,
):
    return SimpleNamespace(
        execution_id=execution_id,
        argv=["sleep", "300"],
        started_at=started_at,
        tty=False,
        is_main_session=main,
    )


class ExecutionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        SERVER.state.runtime = None
        SERVER.state.active_executions = {}
        SERVER.state.active_boxes_by_id = {}
        SERVER.state.active_boxes_lock = asyncio.Lock()
        self.executions: list[_FakeExecution] = []

    async def asyncTearDown(self) -> None:
        for execution in self.executions:
            execution.finish()
        await asyncio.sleep(0)

    def _box(self, box_id: str = "box-1"):
        handle = _make_box_handle(box_id)
        SERVER.state.active_boxes_by_id[box_id] = handle
        # `box.executions()` is synchronous on every SDK; only its methods await.
        handle.executions = MagicMock(
            return_value=SimpleNamespace(
                list=AsyncMock(return_value=[]),
                get=AsyncMock(),
            )
        )
        return handle

    @staticmethod
    def _sessions(handle):
        """The fake execution namespace behind one box handle."""
        return handle.executions.return_value

    def _fake(self, exec_id: str) -> _FakeExecution:
        execution = _FakeExecution(exec_id)
        self.executions.append(execution)
        return execution

    async def test_get_execution_recovers_a_main_session_from_the_guest(self) -> None:
        handle = self._box()
        info = _make_execution_info("container-1", main=True)
        execution = self._fake("container-1")
        self._sessions(handle).list.return_value = [info]
        self._sessions(handle).get.return_value = execution

        body = await SERVER.get_execution(
            "demo", "box-1", "container-1", _auth={}
        )

        self.assertEqual(body["execution_id"], "container-1")
        self.assertEqual(body["status"], "running")
        self.assertEqual(
            body["started_at"],
            datetime.fromtimestamp(
                info.started_at / 1000, tz=timezone.utc
            ).isoformat(),
        )
        active = SERVER.state.active_executions["container-1"]
        self.assertIs(active.the_execution, execution)
        self.assertIsNone(active.stdout)
        self._sessions(handle).get.assert_awaited_once_with("container-1")

    async def test_get_execution_404s_when_the_guest_also_has_no_session(self) -> None:
        handle = self._box()

        with self.assertRaises(SERVER.HTTPException) as ctx:
            await SERVER.get_execution("demo", "box-1", "missing", _auth={})

        self.assertEqual(ctx.exception.status_code, 404)
        self._sessions(handle).get.assert_not_awaited()

    async def test_execution_from_another_box_is_not_recovered(self) -> None:
        self._box("box-2")
        execution = self._fake("exec-1")
        SERVER.state.active_executions["exec-1"] = SERVER.ActiveExecution(
            the_execution=execution,
            box_id="box-1",
            stdout=None,
            stderr=None,
            stdin=None,
        )

        with self.assertRaises(SERVER.HTTPException) as ctx:
            await SERVER.get_execution("demo", "box-2", "exec-1", _auth={})

        self.assertEqual(ctx.exception.status_code, 404)

    async def test_signal_recovers_a_guest_session_and_uses_its_control_handle(
        self,
    ) -> None:
        handle = self._box()
        info = _make_execution_info("exec-1")
        execution = self._fake("exec-1")
        self._sessions(handle).list.return_value = [info]
        self._sessions(handle).get.return_value = execution

        response = await SERVER.signal_execution(
            "demo",
            "box-1",
            "exec-1",
            SERVER.SignalRequest(signal=15),
            _auth={},
        )

        self.assertEqual(response.status_code, 204)
        self.assertTrue(execution.killed)


if __name__ == "__main__":
    unittest.main()
