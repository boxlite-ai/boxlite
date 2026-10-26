from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from boxlite.simplebox import NetworkHandle
from boxlite.sync_api._network import SyncNetworkHandle

# The wrappers forward specs untouched, so plain objects stand in for the
# native spec classes: the CI unit job runs without the Rust extension.
InboundNetworkSpec = OutboundNetworkSpec = SimpleNamespace


@pytest.mark.asyncio
async def test_network_policy_updates_delegate_and_propagate_failure():
    native = SimpleNamespace(update_inbound=AsyncMock(), update_outbound=AsyncMock())
    owner = SimpleNamespace(_started=True, _box=SimpleNamespace(network=native))
    network = NetworkHandle(owner)
    inbound = InboundNetworkSpec(mode="enabled")
    outbound = OutboundNetworkSpec(mode="enabled", allow_net=["example.com"])
    await network.update_inbound(inbound)
    await network.update_outbound(outbound)
    native.update_inbound.assert_awaited_once_with(inbound)
    native.update_outbound.assert_awaited_once_with(outbound)
    native.update_outbound.side_effect = RuntimeError("unsupported")
    with pytest.raises(RuntimeError, match="unsupported"):
        await network.update_outbound(OutboundNetworkSpec(mode="enabled"))


@pytest.mark.asyncio
async def test_network_policy_requires_started_simple_box():
    network = NetworkHandle(SimpleNamespace(_started=False))
    with pytest.raises(RuntimeError, match="not started"):
        await network.update_outbound(OutboundNetworkSpec())


def test_network_policy_sync_wrapper_dispatches_updates():
    import asyncio

    native = SimpleNamespace(update_inbound=AsyncMock(), update_outbound=AsyncMock())
    owner = SimpleNamespace(_box=SimpleNamespace(network=native), _sync=asyncio.run)
    network = SyncNetworkHandle(owner)
    # Distinct values: equal stand-ins would hide a swapped dispatch.
    inbound = InboundNetworkSpec(mode="enabled")
    outbound = OutboundNetworkSpec(mode="disabled")
    network.update_inbound(inbound)
    network.update_outbound(outbound)
    native.update_inbound.assert_awaited_once_with(inbound)
    native.update_outbound.assert_awaited_once_with(outbound)
