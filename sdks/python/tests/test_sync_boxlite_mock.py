"""
SyncBoxlite's factories and image handle, without the native extension.

The CI unit job does not build the extension, so the tests that drive a real
runtime (test_image_handle.py) skip there. These put a stand-in where the
native module is imported from and check what the sync layer itself does:
which async runtime it wraps, that nothing runs before it starts, and that
each image call hands back what the awaited native call returned.
"""

from __future__ import annotations

import sys
import types

import pytest

pytest.importorskip("greenlet")

from boxlite.errors import NotFoundError
from boxlite.sync_api import SyncBoxlite, SyncImageHandle

NAME = "quay.io/acme/app"


class _NativeImages:
    """Answers like the native ImageHandle and records each call."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    async def pull(self, reference: str) -> str:
        self.calls.append(("pull", reference))
        return f"pulled {reference}"

    async def list(self) -> list[str]:
        self.calls.append(("list",))
        return [f"{NAME}:v1"]

    async def get(self, name: str) -> str:
        self.calls.append(("get", name))
        if name != NAME:
            raise NotFoundError(f"not found: {name}")
        return f"detail of {name}"

    async def remove(self, name: str) -> None:
        self.calls.append(("remove", name))

    async def usage(self) -> str:
        self.calls.append(("usage",))
        return "usage"


class _NativeBoxlite:
    """Stands in for the native Boxlite and records which factory made it."""

    def __init__(self, options=None, made_by: str = "Boxlite(options)") -> None:
        self.options = options
        self.made_by = made_by
        self.images = _NativeImages()

    @classmethod
    def rest(cls, options) -> _NativeBoxlite:
        return cls(options, made_by="Boxlite.rest")

    @classmethod
    def default(cls) -> _NativeBoxlite:
        return cls(made_by="Boxlite.default")


@pytest.fixture(autouse=True)
def _native_stand_in(monkeypatch):
    native = types.ModuleType("boxlite.boxlite")
    native.Boxlite = _NativeBoxlite
    monkeypatch.setitem(sys.modules, "boxlite.boxlite", native)


class TestFactories:
    def test_the_constructor_wraps_a_runtime_built_from_its_options(self):
        options = object()

        runtime = SyncBoxlite(options)

        assert runtime.runtime.made_by == "Boxlite(options)"
        assert runtime.runtime.options is options

    def test_rest_wraps_the_runtime_boxlite_rest_made(self):
        options = object()

        runtime = SyncBoxlite.rest(options)

        assert runtime.runtime.made_by == "Boxlite.rest"
        assert runtime.runtime.options is options

    def test_default_wraps_the_default_runtime(self):
        assert SyncBoxlite.default().runtime.made_by == "Boxlite.default"

    @pytest.mark.parametrize(
        "make", [SyncBoxlite.rest, SyncBoxlite], ids=["rest", "constructor"]
    )
    def test_nothing_runs_before_start(self, make):
        runtime = make(object())

        with pytest.raises(RuntimeError, match="not started"):
            _ = runtime.images


class TestImages:
    def test_each_call_returns_what_the_native_call_answered(self):
        with SyncBoxlite.rest(object()) as runtime:
            images = runtime.images

            assert isinstance(images, SyncImageHandle)
            assert images.pull("alpine:latest") == "pulled alpine:latest"
            assert images.list() == [f"{NAME}:v1"]
            assert images.get(NAME) == f"detail of {NAME}"
            images.remove(NAME)
            assert images.usage() == "usage"

        assert runtime.runtime.images.calls == [
            ("pull", "alpine:latest"),
            ("list",),
            ("get", NAME),
            ("remove", NAME),
            ("usage",),
        ]

    def test_a_failure_keeps_its_class_and_message(self):
        with (
            SyncBoxlite.rest(object()) as runtime,
            pytest.raises(NotFoundError, match="not found: quay.io/acme/other"),
        ):
            runtime.images.get("quay.io/acme/other")
