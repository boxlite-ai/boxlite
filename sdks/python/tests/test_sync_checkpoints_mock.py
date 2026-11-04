"""Sync checkpoint dispatch and lifetime without loading the native extension."""

import sys
import types

import pytest

pytest.importorskip("greenlet")

from boxlite.errors import InvalidStateError
from boxlite.sync_api import SyncBoxlite


class Catalog:
    def __init__(self):
        self.calls = []

    async def create(self, *, name=None):
        self.calls.append(("create", name))
        return "captured"

    async def list(self):
        self.calls.append(("list",))
        return ["captured"]

    async def get(self, key):
        self.calls.append(("get", key))
        if key == "failed":
            raise InvalidStateError("failed capture")
        return None if key == "missing" else "captured"

    async def remove(self, key, *, force=False):
        self.calls.append(("remove", key, force))


class NativeBox:
    id = "child"

    def __init__(self):
        self.checkpoint = Catalog()
        self.calls = []

    async def pause(self, *, host_writers_stopped=False):
        self.calls.append(("pause", host_writers_stopped))

    async def resume(self):
        self.calls.append(("resume",))

    async def export_checkpoint(self, path):
        self.calls.append(("export", path))


class NativeRuntime:
    def __init__(self, options):
        self.catalog = Catalog()
        self.box = NativeBox()
        self.calls = []

    def checkpoints(self):
        return self.catalog

    async def get(self, key):
        return self.box

    async def create_from_checkpoint(self, key, *, name=None):
        self.calls.append(("restore", key, name))
        return self.box

    async def import_checkpoint(self, path, *, name=None):
        self.calls.append(("import", path, name))
        return self.box

    @staticmethod
    def inspect_checkpoint(path):
        return ("inspection", path)


@pytest.fixture
def runtime(monkeypatch):
    native = types.ModuleType("boxlite.boxlite")
    native.Boxlite = NativeRuntime
    monkeypatch.setitem(sys.modules, "boxlite.boxlite", native)
    return SyncBoxlite(object())


def test_checkpoint_sync_dispatch_returns_results_and_preserves_options(runtime):
    with runtime:
        box = runtime.get("source")
        scoped = box.checkpoint
        catalog = runtime.checkpoints()
        assert scoped.create() == "captured"
        assert scoped.create(name="saved") == "captured"
        assert catalog.list() == ["captured"]
        assert scoped.get("missing") is None
        assert catalog.get("saved") == "captured"
        scoped.remove("missing", force=True)
        catalog.remove("saved")
        box.pause()
        box.pause(host_writers_stopped=True)
        box.resume()
        box.export_checkpoint("caller-path")
        assert runtime.create_from_checkpoint("saved", name="new").id == "child"
        assert runtime.import_checkpoint("caller-path").id == "child"
        assert runtime.inspect_checkpoint("caller-path") == (
            "inspection",
            "caller-path",
        )
        with pytest.raises(InvalidStateError, match="failed capture"):
            catalog.get("failed")
    assert runtime.runtime.box.calls == [
        ("pause", False),
        ("pause", True),
        ("resume",),
        ("export", "caller-path"),
    ]
    assert runtime.runtime.calls == [
        ("restore", "saved", "new"),
        ("import", "caller-path", None),
    ]
    assert runtime.runtime.box.checkpoint.calls == [
        ("create", None),
        ("create", "saved"),
        ("get", "missing"),
        ("remove", "missing", True),
    ]
    with pytest.raises(RuntimeError, match="not started"):
        catalog.list()
    with pytest.raises(RuntimeError, match="not started"):
        scoped.create()
    with pytest.raises(RuntimeError, match="not started"):
        box.resume()


def test_checkpoint_sync_refuses_calls_before_start(runtime):
    with pytest.raises(RuntimeError, match="not started"):
        runtime.checkpoints()
    with pytest.raises(RuntimeError, match="not started"):
        runtime.create_from_checkpoint("saved")
    with pytest.raises(RuntimeError, match="not started"):
        runtime.import_checkpoint("caller-path")
