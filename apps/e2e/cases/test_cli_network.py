"""POL-1221: CLI private descriptor/revoke and persisted live network policy."""
import asyncio
import json
import os
import signal

import pytest

from test_cli_entry import cli
from network_fixtures import PORT, eventually_status, ready, service_box
from preview import Wire, access, require
from test_network_egress import REACHABLE_HOST, REACHABLE_URL, UNLISTED_URL, _reaches


async def _launch(cli, ctx, *args):
    env = {**os.environ, "BOXLITE_API_KEY": ctx.token, "RUST_LOG": "warn"}
    env.pop("BOXLITE_PROFILE", None)
    return await asyncio.create_subprocess_exec(
        cli, "--url", ctx.url, "--path-prefix", ctx.path_prefix, *args,
        env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )


async def _cli(cli, ctx, *args):
    process = await _launch(cli, ctx, *args)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 45)
        require(process.returncode == 0, "network CLI failed: " + stderr.decode().replace(ctx.token, "[redacted]"))
        return stdout.decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_cli_network_private_revoke_and_policy_readback(cli, rt, image, e2e_auth):
    async with service_box(rt, image) as (box, marker):
        descriptor = json.loads(await _cli(cli, e2e_auth, "network", "tunnel", box.id, str(PORT), "--private"))
        require(descriptor["isPublic"] is False and bool(descriptor["token"]), "CLI private descriptor is incomplete")
        uri, token = descriptor["uri"], descriptor["token"]
        await ready(uri, marker, {"X-BoxLite-Access-Token": token})
        for transport in ("http", "ws", "connect"):
            reply = await access(uri, transport, {"X-BoxLite-Access-Token": token})
            assert reply.status == (101 if transport == "ws" else 200) and marker in reply.body
        repeated = json.loads(await _cli(cli, e2e_auth, "network", "tunnel", box.id, str(PORT), "--private"))
        require("*" in repeated["token"] and token != repeated["token"], "CLI repeated prepare exposed the full token")
        for url in (REACHABLE_URL, UNLISTED_URL):
            assert await _reaches(box, url), "CLI policy control target is unavailable"
        await _cli(cli, e2e_auth, "network", "outbound", box.id, "enabled", "--allow-net", REACHABLE_HOST)
        inspected = json.loads(await _cli(cli, e2e_auth, "inspect", box.id))[0]
        assert inspected["Network"]["Outbound"] == {"Mode": "enabled", "AllowNet": [REACHABLE_HOST]}
        assert inspected["Network"]["Inbound"]["Mode"] == "enabled"
        assert await _reaches(box, REACHABLE_URL)
        assert not await _reaches(box, UNLISTED_URL)
        await _cli(cli, e2e_auth, "network", "outbound", box.id, "enabled")
        assert await _reaches(box, UNLISTED_URL)
        await _cli(cli, e2e_auth, "network", "tunnel", box.id, str(PORT), "--revoke")
        await eventually_status(uri, "http", 404, {"X-BoxLite-Access-Token": token})


async def test_cli_network_forward_cannot_reprepare_after_revoke(cli, rt, image, e2e_auth):
    async with service_box(rt, image) as (box, marker):
        process = await _launch(cli, e2e_auth, "network", "tunnel", box.id, str(PORT), "--private", "--listen", "0")
        try:
            descriptor = json.loads(await asyncio.wait_for(process.stdout.readline(), 30))
            local_address = (await asyncio.wait_for(process.stdout.readline(), 10)).decode().strip()
            uri = descriptor["uri"]
            await ready(uri, marker, {"X-BoxLite-Access-Token": descriptor["token"]})
            assert local_address.startswith("tcp://"), "CLI listener must return a TCP address"
            local_uri = "http://" + local_address.removeprefix("tcp://")
            try:
                reply = await access(local_uri)
            except OSError as error:
                process.send_signal(signal.SIGINT)
                _, stderr = await asyncio.wait_for(process.communicate(), 5)
                detail = stderr.decode().replace(e2e_auth.token, "[redacted]").replace(descriptor["token"], "[redacted]")
                raise AssertionError(f"CLI forward failed ({type(error).__name__}): {detail}") from None
            assert reply.body == marker
            await _cli(cli, e2e_auth, "network", "tunnel", box.id, str(PORT), "--revoke")
            await eventually_status(uri, "http", 404)
            wire = await asyncio.to_thread(Wire, local_uri)
            try:
                with pytest.raises((AssertionError, ConnectionResetError)):
                    await asyncio.to_thread(wire.request, "GET", "/")
            finally:
                wire.close()
            assert (await access(uri)).status == 404
        finally:
            if process.returncode is None:
                process.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
