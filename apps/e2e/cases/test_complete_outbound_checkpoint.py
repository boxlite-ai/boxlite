"""Managed checkpoint acceptance on an isolated GCP stage with owned peers."""

from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

import boxlite
import pytest

from e2e_auth import request_json
from test_checkpoints import checkpoint_resources, ready_checkpoint, remove_box, wait_stopped  # noqa: F401
from test_network_egress import _reaches


pytestmark = [
    pytest.mark.e2e,
    pytest.mark.asyncio,
    pytest.mark.skipif(
        os.environ.get("BOXLITE_E2E_GCP_COMPLETE_OUTBOUND") != "1",
        reason="requires an isolated GCP stage and owned outbound probe listeners",
    ),
]


def owned_http_peers():
    urls = [os.environ[f"BOXLITE_E2E_GCP_{name}_URL"] for name in ("ALLOWED", "DENIED")]
    peers = [urlsplit(url) for url in urls]
    for peer in peers:
        assert peer.scheme in {"http", "https"} and peer.hostname and peer.port, (
            "each owned peer requires an HTTP(S) URL with an explicit port"
        )
        assert not peer.username and not peer.password, "owned peer URLs must not contain credentials"
    assert (peers[0].hostname, peers[0].port) != (peers[1].hostname, peers[1].port)
    rules = [peer.netloc.lower() for peer in peers]
    return urls, rules


async def confirmed(box):
    async def wait():
        while True:
            status = await box.network.outbound_policy_status()
            committed = status["persisted"]
            if status["application_state"] == "confirmed":
                assert status["runtime_persisted"] == committed
                assert status["observed"]["snapshot"] == committed
                assert status["observed"]["application_state"] == "confirmed"
                return committed
            await asyncio.sleep(0.5)

    return await asyncio.wait_for(wait(), timeout=30)


async def test_complete_outbound_checkpoint_preserves_latest_policy(rt, image, checkpoint_resources):
    urls, rules = owned_http_peers()
    status, config = await asyncio.to_thread(request_json, "GET", "/v1/config")
    assert status == 200 and config
    assert config["capabilities"]["complete_outbound_policy_enabled"] is True
    assert config["capabilities"]["checkpoints_enabled"] is True

    names, owned = checkpoint_resources
    owned.update(names.values())
    source = await rt.create_with_outbound_policy(
        boxlite.BoxOptions(image=image), {"mode": "enabled", "deny_net": []}, name=names["source"]
    )
    initial = await confirmed(source)
    for url in urls:
        assert await _reaches(source, url), "owned peer did not pass the unrestricted control"

    # Both destinations match allow rules. Only the explicit deny can block one.
    policy = {
        "mode": "enabled",
        "allow_net": [*rules, *(f"allow-{n}.invalid" for n in range(62))],
        "deny_net": [rules[1], *(f"deny-{n}.invalid" for n in range(63))],
    }
    result = await source.network.replace_outbound_policy(policy, initial["revision"])
    latest = await confirmed(source)
    assert latest["revision"] != initial["revision"]
    assert latest == result["acknowledged"]
    assert latest["policy"] == policy
    for key in ("allow_net", "deny_net"):
        invalid = {**policy, key: [*policy[key], "exceeds-limit.invalid"]}
        with pytest.raises((boxlite.OutboundPolicyError, boxlite.InvalidArgumentError)):
            await source.network.replace_outbound_policy(invalid, latest["revision"])
        assert await confirmed(source) == latest

    await source.stop()
    await wait_stopped(rt, source.id)
    source = await rt.get(source.id)
    await source.start()
    assert await confirmed(source) == latest
    assert await _reaches(source, urls[0])
    assert not await _reaches(source, urls[1])
    await source.stop()
    await wait_stopped(rt, source.id)
    checkpoint = await rt.checkpoints.create(source.id, names["archive"])
    checkpoint = await ready_checkpoint(rt.checkpoints, checkpoint.id)
    await remove_box(rt, source.id)

    copy = await rt.create(boxlite.BoxOptions(checkpoint=checkpoint.id), name=names["copy"])
    assert copy.id != source.id
    restored = await confirmed(copy)
    assert restored["revision"] != latest["revision"]
    assert restored["policy"] == latest["policy"]
    assert restored["admission"] == latest["admission"]
    assert await _reaches(copy, urls[0])
    assert not await _reaches(copy, urls[1])

    # Control the same denied listener after restore to rule out an outage.
    await copy.network.replace_outbound_policy({"mode": "enabled", "deny_net": []}, restored["revision"])
    assert await _reaches(copy, urls[1]), "denied fixture was unavailable during restore testing"
