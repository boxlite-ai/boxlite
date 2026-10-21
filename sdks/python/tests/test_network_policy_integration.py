from __future__ import annotations

import asyncio

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def test_network_policy_live_traffic_and_restart(shared_runtime):
    marker = "boxlite-policy-probe"

    async def reply(reader, writer):
        try:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(
                f"HTTP/1.1 200 OK\r\nContent-Length: {len(marker)}\r\nConnection: close\r\n\r\n{marker}".encode()
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass  # Rejected/disabled connections may close before sending HTTP.
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(reply, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    box = await shared_runtime.create(
        boxlite.BoxOptions(
            image="alpine:latest",
            cmd=["sleep", "300"],
            auto_remove=False,
        )
    )
    box_id = box.id

    async def probe():
        execution = await box.exec(
            "wget", ["-q", "-T", "1", "-O", "-", f"http://192.168.127.254:{port}/"]
        )
        stdout = "".join([chunk async for chunk in execution.stdout()])
        stderr = "".join([chunk async for chunk in execution.stderr()])
        result = await execution.wait()
        print(f"probe exit={result.exit_code} stdout={stdout!r} stderr={stderr!r}")
        return result.exit_code == 0 and stdout == marker

    async def replace(mode="enabled", rules=None):
        await box.network.update_outbound(
            boxlite.OutboundNetworkSpec(mode=mode, allow_net=rules or [])
        )

    try:
        await box.start()
        pid = (await box.info()).state.pid
        assert pid is not None
        assert await probe()
        await replace(rules=["example.invalid"])
        assert not await probe()
        await replace(rules=["192.168.127.254"])
        assert await probe()
        await replace("disabled")
        assert not await probe()
        await replace()
        assert await probe()
        assert (await box.info()).state.pid == pid

        await replace(rules=["example.invalid"])
        await box.stop()
        box = await shared_runtime.get(box_id)
        cloned = await box.clone_box()
        try:
            assert (await cloned.info()).network.outbound.allow_net == [
                "example.invalid"
            ]
        finally:
            await shared_runtime.remove(cloned.id, force=True)
        with pytest.raises(Exception, match="running box"):
            await replace()
        await box.start()
        assert (await box.info()).network.outbound.allow_net == ["example.invalid"]
        assert not await probe()
        await replace()
        assert await probe()
        await replace("disabled")
        await box.stop()
        box = await shared_runtime.get(box_id)
        await box.start()
        assert (await box.info()).network.outbound.mode == "disabled"
        assert not await probe()
        await replace()
        assert await probe()
    finally:
        await shared_runtime.remove(box_id, force=True)
        server.close()
        await server.wait_closed()


async def test_network_policy_does_not_hotplug_a_missing_nic(shared_runtime):
    box = await shared_runtime.create(
        boxlite.BoxOptions(
            image="alpine:latest",
            cmd=["sleep", "300"],
            auto_remove=False,
            network=boxlite.NetworkSpec(
                outbound=boxlite.OutboundNetworkSpec(mode="disabled")
            ),
        )
    )
    try:
        await box.start()
        pid = (await box.info()).state.pid
        assert pid is not None
        with pytest.raises(Exception, match="networking is disabled"):
            await box.network.update_outbound(
                boxlite.OutboundNetworkSpec(mode="enabled")
            )
        assert (await box.info()).state.pid == pid
    finally:
        await shared_runtime.remove(box.id, force=True)
