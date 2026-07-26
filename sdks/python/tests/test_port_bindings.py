from __future__ import annotations

import pytest
from boxlite.simplebox import SimpleBox


class _FakeBox:
    def __init__(self, bindings):
        self.bindings = bindings
        self.calls = 0

    async def port_bindings(self):
        self.calls += 1
        return self.bindings


@pytest.mark.asyncio
async def test_simplebox_port_bindings_returns_resolved_native_bindings():
    expected = [(49152, 3000, "tcp", "127.0.0.1")]
    native_box = _FakeBox(expected)
    box = SimpleBox.__new__(SimpleBox)
    box._started = True
    box._box = native_box

    assert await box.port_bindings() == expected
    assert native_box.calls == 1


@pytest.mark.asyncio
async def test_simplebox_port_bindings_requires_a_started_box():
    box = SimpleBox.__new__(SimpleBox)
    box._started = False

    with pytest.raises(RuntimeError, match="Box not started"):
        await box.port_bindings()
