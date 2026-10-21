from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from boxlite import InboundNetworkSpec, OutboundNetworkSpec
from boxlite.simplebox import NetworkHandle
from boxlite.sync_api._network import SyncNetworkHandle


@pytest.mark.asyncio
async def test_network_policy_setters_delegate_and_propagate_failure():
    native = SimpleNamespace(set_inbound=AsyncMock(), set_outbound=AsyncMock())
    owner = SimpleNamespace(_started=True, _box=SimpleNamespace(network=native))
    network = NetworkHandle(owner)
    inbound = InboundNetworkSpec(mode="enabled")
    outbound = OutboundNetworkSpec(mode="enabled", allow_net=["example.com"])
    await network.set_inbound(inbound)
    await network.set_outbound(outbound)
    native.set_inbound.assert_awaited_once_with(inbound)
    native.set_outbound.assert_awaited_once_with(outbound)
    native.set_outbound.side_effect = RuntimeError("unsupported")
    with pytest.raises(RuntimeError, match="unsupported"):
        await network.set_outbound(OutboundNetworkSpec(mode="enabled"))


@pytest.mark.asyncio
async def test_network_policy_requires_started_simple_box():
    network = NetworkHandle(SimpleNamespace(_started=False))
    with pytest.raises(RuntimeError, match="not started"):
        await network.set_outbound(OutboundNetworkSpec())


def test_network_policy_sync_wrapper_dispatches_setters():
    import asyncio

    native = SimpleNamespace(set_inbound=AsyncMock(), set_outbound=AsyncMock())
    owner = SimpleNamespace(_box=SimpleNamespace(network=native), _sync=asyncio.run)
    network = SyncNetworkHandle(owner)
    inbound, outbound = InboundNetworkSpec(), OutboundNetworkSpec()
    network.set_inbound(inbound)
    network.set_outbound(outbound)
    native.set_inbound.assert_awaited_once_with(inbound)
    native.set_outbound.assert_awaited_once_with(outbound)
