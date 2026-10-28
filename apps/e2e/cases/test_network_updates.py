"""POL-1221: live network replacement, persistence and rejected updates over REST."""
import asyncio
from ipaddress import IPv4Address
import json
import os
from urllib.parse import urlsplit

import boxlite
import pytest

from conftest import drain, with_bounded_lifetime
from network_fixtures import state
from preview import api
from test_network_egress import REACHABLE_HOST, REACHABLE_URL, UNLISTED_HOST, UNLISTED_URL, _reaches


async def _process_identity(box):
    execution = await box.exec("sh", ["-c", "cat /proc/sys/kernel/random/boot_id; cat /proc/1/stat"])
    out, _ = await asyncio.wait_for(drain(execution), 20)
    assert (await execution.wait()).exit_code == 0
    lines = out.strip().splitlines()
    assert len(lines) == 2 and len(lines[0]) == 36, "missing guest process identity"
    # Boot ID plus PID 1's start time: survives exec, changes on reboot/restart.
    return lines[0], lines[1].rsplit(")", 1)[1].split()[19]


async def _readback(rt, box, ctx, mode, rules):
    expected = {"mode": mode, "allow_net": rules}
    for handle in (box, await rt.get(box.id)):
        policy = (await handle.info()).network.outbound
        assert {"mode": policy.mode, "allow_net": policy.allow_net} == expected
    for path in (f"boxes/{box.id}", "boxes"):
        reply = await api(ctx, "GET", path)
        assert reply.status == 200
        data = json.loads(reply.body)
        if path == "boxes":
            data = next(item for item in data["boxes"] if item["box_id"] == box.id)
        assert data["network"]["outbound"] == expected


async def test_network_updates_replace_live_policy_without_restarting(rt, image, e2e_auth):
    assert REACHABLE_HOST != UNLISTED_HOST
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        for url in (REACHABLE_URL, UNLISTED_URL):
            assert await _reaches(box, url), "unrestricted baseline cannot reach both probe hosts"
        identity = await _process_identity(box)
        for mode, rules, permitted in [
            ("disabled", [], (False, False)),
            ("enabled", [REACHABLE_HOST], (True, False)),
            ("enabled", [UNLISTED_HOST], (False, True)),
            ("enabled", [], (True, True)),
        ]:
            await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode=mode, allow_net=rules))
            await _readback(rt, box, e2e_auth, mode, rules)
            for url, expected in zip((REACHABLE_URL, UNLISTED_URL), permitted):
                assert await _reaches(box, url) == expected
            assert await _process_identity(box) == identity
            assert (await box.info()).network.inbound.mode == "disabled"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.parametrize("mode,rules", [("enabled", [REACHABLE_HOST]), ("disabled", [])])
async def test_network_updates_survive_stop_start(rt, image, e2e_auth, mode, rules):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False, auto_resume=False))
    try:
        for url in (REACHABLE_URL, UNLISTED_URL):
            assert await _reaches(box, url), "unrestricted baseline failed"
        await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode=mode, allow_net=rules))
        await box.stop()
        await state(rt, box.id, "stopped")
        box = await rt.get(box.id)
        await box.start()
        await _readback(rt, box, e2e_auth, mode, rules)
        assert await _reaches(box, REACHABLE_URL) == (mode == "enabled")
        assert not await _reaches(box, UNLISTED_URL)
        await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode="enabled"))
        assert await _reaches(box, UNLISTED_URL), "existing NIC did not recover"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.parametrize("condition", ["no-nic", "stopped"])
async def test_network_updates_reject_unsupported_state(rt, image, e2e_auth, condition):
    mode = "disabled" if condition == "no-nic" else "enabled"
    box = await rt.create(boxlite.BoxOptions(
        image=image, auto_remove=False, auto_resume=False,
        network=boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode=mode)),
    ))
    try:
        if condition == "stopped":
            await box.stop()
            await state(rt, box.id, "stopped")
        before = (await box.info()).state.status
        reply = await api(e2e_auth, "PUT", f"boxes/{box.id}/network/outbound", {"mode": "enabled"})
        assert reply.status in (400, 409, 422, 501), "unsupported update did not return a contract error"
        message = reply.body.decode().lower()
        assert ("networking is disabled" in message if condition == "no-nic" else "running" in message)
        assert (await box.info()).state.status == before
        await _readback(rt, box, e2e_auth, mode, [])
    finally:
        await rt.remove(box.id, force=True)


INVALID_POLICIES = [
    ("outbound", {"mode": "typo"}),
    ("outbound", {"mode": "enabled", "allow_nte": ["example.com"]}),
    ("outbound", {"mode": "enabled", "allow_net": [""]}),
    ("outbound", {"mode": "enabled", "allow_net": ["10.0.0.0/33"]}),
    ("outbound", {"mode": "disabled", "allow_net": ["example.com"]}),
    ("inbound", {"mode": "enabled", "allow_net": ["example.com"]}),
]


@pytest.mark.parametrize("direction,policy", INVALID_POLICIES)
async def test_network_updates_reject_invalid_policy_without_mutation(rt, image, e2e_auth, direction, policy):
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        reply = await api(e2e_auth, "PUT", f"boxes/{box.id}/network/{direction}", policy)
        assert reply.status == 400
        await _readback(rt, box, e2e_auth, "enabled", [])
        assert (await box.info()).network.inbound.mode == "disabled"
    finally:
        await rt.remove(box.id, force=True)


@pytest.mark.parametrize("direction,policy", INVALID_POLICIES)
async def test_network_create_rejects_invalid_policy(rt, image, e2e_auth, direction, policy):
    body = with_bounded_lifetime({"image": image, "network": {direction: policy}})
    try:
        reply = await api(e2e_auth, "POST", "boxes", body)
        assert reply.status == 400
    finally:
        # A broken validator may have created the box before answering unexpectedly.
        infos = await rt.list_info()
        for info in infos:
            if info.name == body["name"]:
                await rt.remove(info.id, force=True)


@pytest.mark.parametrize("legacy", [False, True], ids=["nested", "legacy"])
@pytest.mark.parametrize("rules", [None, [], ["example.com"]], ids=["omitted", "empty", "conflict"])
async def test_network_create_disabled_policy_contract(rt, image, e2e_auth, legacy, rules):
    policy = {"mode": "disabled"}
    if rules is not None:
        policy["allow_net"] = rules
    body = with_bounded_lifetime({"image": image, "network": policy if legacy else {"outbound": policy}})
    try:
        reply = await api(e2e_auth, "POST", "boxes", body)
        if rules:
            assert reply.status == 400
            assert not any(info.name == body["name"] for info in await rt.list_info()), "rejected create left a box"
        else:
            assert reply.status == 201
            assert json.loads(reply.body)["network"]["outbound"] == {"mode": "disabled", "allow_net": []}
    finally:
        for info in await rt.list_info():
            if info.name == body["name"]:
                await rt.remove(info.id, force=True)


async def test_network_updates_omitted_list_clears_and_retries_are_idempotent(rt, image, e2e_auth):
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        assert await _reaches(box, UNLISTED_URL)
        await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode="enabled", allow_net=[REACHABLE_HOST]))
        assert not await _reaches(box, UNLISTED_URL)
        for _ in range(2):
            reply = await api(e2e_auth, "PUT", f"boxes/{box.id}/network/outbound", {"mode": "enabled"})
            assert reply.status == 200
            await _readback(rt, box, e2e_auth, "enabled", [])
            assert await _reaches(box, UNLISTED_URL)
    finally:
        await rt.remove(box.id, force=True)


WILDCARD_URL = os.environ.get("BOXLITE_E2E_EGRESS_WILDCARD_URL", "https://www.example.com/")
WILDCARD_HOST = urlsplit(WILDCARD_URL).hostname
if urlsplit(WILDCARD_URL).scheme != "https" or not WILDCARD_HOST or len(WILDCARD_HOST.split(".")) < 3:
    raise ValueError("BOXLITE_E2E_EGRESS_WILDCARD_URL must use HTTPS and a subdomain")
IP_URL = os.environ.get("BOXLITE_E2E_EGRESS_IP_URL", "https://1.1.1.1/")
IP_RULE = str(IPv4Address(urlsplit(IP_URL).hostname))


@pytest.mark.parametrize("url,rule,denied", [
    (REACHABLE_URL.replace("https://", "http://", 1), REACHABLE_HOST, UNLISTED_URL),
    (WILDCARD_URL, "*." + WILDCARD_HOST.split(".", 1)[1], REACHABLE_URL),
    (IP_URL, IP_RULE, REACHABLE_URL),
    (IP_URL, IP_RULE + "/32", REACHABLE_URL),
], ids=["http-host", "wildcard-tls", "ipv4", "cidr"])
async def test_network_updates_supported_rule_types(rt, image, e2e_auth, url, rule, denied):
    box = await rt.create(boxlite.BoxOptions(image=image))
    try:
        for target in (url, denied):
            assert await _reaches(box, target), "unrestricted rule-type control failed"
        await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode="enabled", allow_net=[rule]))
        await _readback(rt, box, e2e_auth, "enabled", [rule])
        assert await _reaches(box, url), "rule rejected its allowed target"
        assert not await _reaches(box, denied), "rule admitted its unlisted target"
        await box.network.update_outbound(boxlite.OutboundNetworkSpec(mode="enabled"))
        assert await _reaches(box, denied), "denied control did not recover after clearing the rule"
    finally:
        await rt.remove(box.id, force=True)
