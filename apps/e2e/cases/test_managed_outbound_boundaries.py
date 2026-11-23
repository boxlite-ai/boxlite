"""Release boundary checks using the deployed API, Runner and live observers."""

import asyncio
from contextlib import AsyncExitStack
from dataclasses import replace
import json
import time
from urllib.parse import urlsplit
from uuid import uuid4

import boxlite
import pytest

from conftest import drain, e2e_box_name
from managed_outbound_deployment import controlled_run, deployment_box, dhcp_evidence, guest_link_evidence, runner_receipt
from preview import require
from test_managed_outbound import (
    GATEWAY_DNS_IPV4, GUEST_BUSINESS_DNS, calibrate_connect_trace, deployment_runners, execute_network_probe, isolated_org,
    literal_https_probe, managed_box, managed_lab, named_dns_rows, register_proxy, remove_registration,
    require_bracketed_capture, require_udp_ingress, udp_probe, wait_for_confirmed_proxy,
)
from test_managed_outbound_deployment import replace_policy


pytestmark = [pytest.mark.e2e, pytest.mark.managed_outbound]

GUEST_READ_OLD_UDP = '''
import json
import socket
import sys

address, port, marker = sys.argv[1:]
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
    peer.settimeout(4)
    peer.connect((address, int(port)))
    peer.sendall(marker.encode('ascii'))
    if sys.stdin.readline() != 'read-old-frame\\n':
        raise SystemExit(1)
    try:
        received = peer.recv(33).decode('ascii')
    except TimeoutError:
        received = None
    print(json.dumps({'received': received}))
'''

GUEST_LEASE_ADDRESS = '''
import json
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as gateway:
    gateway.connect((sys.argv[1], 67))
    print(json.dumps(gateway.getsockname()[0]))
'''


def allow_network(*entries):
    return boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=list(entries)))


@pytest.mark.parametrize("route", ["direct", "http-anonymous", "https-anonymous", "socks5-anonymous"])
async def test_managed_proxy_deployment_protected_hostname_and_mapped_ipv4(
    managed_lab, deployment_runners, rt, image, isolated_org, route,
):
    lab = managed_lab
    private, dns, captures = lab.protected_target, lab.dns, lab.tcp_faults
    require(all((private, dns, captures)) and dns.guest_business_ip not in {private.address, lab.target_tcp_ip},
            "configure separate public, protected and original Guest destinations plus live DNS and trace controls")
    private_lab = replace(lab, target_tcp_ip=private.address, target_origin=private.origin,
                          target_log=private.target_log, direct_source=private.source)
    registry = rt.outbound_proxies()
    variant = lab.variants.get(route)
    async with AsyncExitStack() as cleanup:
        name, binding = None, None
        if variant:
            name = e2e_box_name()
            cleanup.push_async_callback(remove_registration, registry, name)
            binding = await register_proxy(isolated_org, registry, name, variant)
        entries = [f"{lab.target_tcp_ip}/32", f"*.{dns.zone}"]
        if variant:
            entries.append(f"{private.address}/32")
        subject = await managed_box(cleanup, rt, image, name, network=allow_network(*entries))
        positive = await managed_box(cleanup, rt, image, None, network=allow_network(
            f"{private.address}/32", f"{captures.refused_proxy.source}/32",
        ))
        original = await lab.readback(subject, binding)
        trace, _ = await cleanup.enter_async_context(controlled_run(lab, deployment_runners))
        await calibrate_connect_trace(trace, positive, lab)
        await trace.step("start-connect-trace", box_id=subject.id, epoch=original[0])

        for address in (lab.target_tcp_ip, f"::ffff:{lab.target_tcp_ip}"):
            started, completed, _ = await literal_https_probe(subject, lab, variant, address=address)
            attempts = await trace.connect_window(subject.id, original[0], lab.target_tcp_ip,
                                                  captures.syn.port, started, completed)
            require(await captures.syn.packets(started, completed), "allowed address lacked independent target ingress")
            if variant:
                require(not attempts, "allowed proxy request attempted a direct target dial")
            else:
                require(attempts and all(attempt["family"] == "inet" for attempt in attempts),
                        "allowed direct request did not dial its IPv4 target")

        first = await literal_https_probe(positive, private_lab)
        blocked = []
        for address in (private.address, f"::ffff:{private.address}"):
            blocked.append(await literal_https_probe(subject, private_lab, expected_failure=True, address=address))

        host = f"private-{uuid4().hex}.{dns.zone}"
        marker = uuid4().hex
        started = time.time_ns()
        result = await execute_network_probe(subject, GUEST_BUSINESS_DNS, [
            dns.guest_business_ip, str(private.capture.port), host, marker, "8",
        ])
        completed = time.time_ns()
        blocked.append((started, completed, result["elapsed"]))
        require(result["marker"] is None and not private_lab.observations(marker),
                "the hostname resolving to the protected address reached the target")
        dns_log, source = (dns.doh_log, variant.source) if variant else (dns.runner_log, dns.runner_source)
        records = named_dns_rows(dns_log, host)
        require(any(row.get("type") == "A" and row.get("address") == private.address
                    and row.get("source") == source and row.get("outcome") == "answer"
                    and started <= row["time_ns"] <= completed for row in records),
                "the expected resolver did not return the protected address for the permitted hostname")
        if variant:
            require(not named_dns_rows(dns.runner_log, host), "bound hostname used the direct resolver")
        require(not await trace.connect_window(subject.id, original[0], dns.guest_business_ip,
                                               private.capture.port, started, completed),
                "hostname refusal fell back to the original Guest destination")
        lab.observe_connect(None, private.capture.port, started, completed, completed, address=dns.guest_business_ip)

        last = await literal_https_probe(positive, private_lab)
        for started, completed, _ in blocked:
            await require_bracketed_capture(private.capture, first[:2], (started, completed), last[:2])
            require(not await trace.connect_window(subject.id, original[0], private.address,
                                                   private.capture.port, started, completed),
                    "protected address refusal attempted a direct dial")
            private_lab.observe_connect(None, private.capture.port, started, completed, completed,
                                        address=private.address)
        require(await lab.readback(subject, binding) == original, "address probes changed the installed revision")


@pytest.mark.parametrize("fault", ["lost-exact", "lost-pending", "wrong-proxy-revision", "wrong-epoch"])
async def test_managed_proxy_deployment_reconciles_only_exact_apply_evidence(
    managed_lab, deployment_runners, rt, image, isolated_org, fault,
):
    lab = managed_lab
    registry = rt.outbound_proxies()
    first, second = e2e_box_name(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        for name in (first, second):
            cleanup.push_async_callback(remove_registration, registry, name)
        a = await register_proxy(isolated_org, registry, first, lab.variants["https-anonymous"])
        await register_proxy(isolated_org, registry, second, lab.variants["https-anonymous"])
        update = await registry.update(second, url=lab.variants["http-anonymous"].endpoint, clear_credential=True)
        b = {"name": second, "revision": (await registry.get(second))["revision"]}
        require(update.get("state") == "accepted" and a["revision"] != b["revision"],
                "Apply fault requires two distinguishable registration revisions")
        box = await managed_box(cleanup, rt, image, first)
        epoch, revision = await lab.readback(box, a)
        predecessor = await deployment_box(lab, box.id)
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("arm-apply-evidence", box_id=box.id, epoch=epoch, fault=fault)
            response = await replace_policy(
                isolated_org, box, revision, {"mode": "enabled", "allow_net": [], "proxy": second},
            )
            installed = await runner_receipt(lab, box.id, epoch)
            candidate = installed["installed"]
            next_revision = candidate["snapshot"]["revision"]
            require(installed["durable"] == candidate and installed["pending_attempt"] is None
                    and next_revision != revision and candidate["binding"]["registration_revision"] == str(b["revision"]),
                    "the actual Runner did not install the candidate before the evidence fault")
            events = await control.evidence("apply-evidence-observed", box.id)
            applies = [index for index, event in enumerate(events) if event["operation"] == "apply"]
            require(len(applies) == 1 and events[applies[0]]["delivered"], "expected one actual Apply dispatch")
            applied = events[applies[0]]
            attempt = applied.get("attempt_id")
            require(isinstance(attempt, str) and bool(attempt), "Apply dispatch omitted its attempt ID")
            if fault.startswith("lost-"):
                require(not applied["reply_forwarded"], "Apply reply was not lost")
                observed = [event for event in events[applies[0] + 1:]
                            if event["operation"] == "inspect" and event["delivered"] and event["reply_forwarded"]]
                require(bool(observed), "lost Apply did not exercise authenticated readback")
                reply = observed[0].get("reply", {})
            else:
                require(applied["reply_forwarded"], "modified Apply reply did not reach Cloud")
                reply = applied.get("reply", {})

            expected_epoch = epoch if fault != "wrong-epoch" else reply.get("epoch")
            require(isinstance(expected_epoch, str) and bool(expected_epoch)
                    and (fault != "wrong-epoch" or expected_epoch != epoch)
                    and reply.get("epoch") == expected_epoch and reply.get("policy_revision") == next_revision
                    and reply.get("registration_id") == candidate["binding"]["registration_id"]
                    and reply.get("registration_revision") == str(
                        a["revision"] if fault == "wrong-proxy-revision" else b["revision"],
                    ) and "pending_attempt" in reply and reply["pending_attempt"] == (
                        attempt if fault == "lost-pending" else None
                    ), "the observed reply did not contain the exact requested Apply fault")

            if fault == "lost-exact":
                require(response.status == 200 and response.headers.get("etag") == f'"{next_revision}"'
                        and await lab.readback(box, b) == (epoch, next_revision),
                        "exact installed and durable readback did not reconcile the lost reply")
            else:
                require(response.status == 409 and json.loads(response.body).get("code")
                        == "outbound_application_unconfirmed", "inexact Apply evidence confirmed an update")
                row = await deployment_box(lab, box.id)
                pins = {pin["kind"]: pin for pin in row["pins"]}
                pending = row["control"]["managed"]["pending"]
                status = await box.network.managed_proxy_status()
                require(row["control"]["revision"] == revision and row["policy"] == predecessor["policy"]
                        and set(pins) == {"committed", "pending"} and pins["committed"] in predecessor["pins"]
                        and pins["pending"]["attempt_id"] == pending["attempt_id"] == attempt
                        and pins["pending"]["registration_id"] == candidate["binding"]["registration_id"]
                        and str(pins["pending"]["revision"]) == str(b["revision"])
                        and status.get("application_state") == "pending",
                        "Cloud did not retain the predecessor policy and both version references")
            await control.step("resume-apply-evidence", box_id=box.id)
            async with asyncio.timeout(120):
                await wait_for_confirmed_proxy(box, b)
            require(await lab.readback(box, b) == (epoch, next_revision), "exact evidence did not settle the original attempt")
            final = await deployment_box(lab, box.id)
            require(len(final["pins"]) == 1 and final["pins"][0]["kind"] == "committed"
                    and final["pins"][0]["registration_id"] == candidate["binding"]["registration_id"]
                    and str(final["pins"][0]["revision"]) == str(b["revision"]), "candidate reference was not committed")


@pytest.mark.parametrize("phase", ["completed", "queued", "partial"])
async def test_managed_proxy_deployment_fences_old_udp_at_guest_link(
    managed_lab, deployment_runners, rt, image, isolated_org, phase,
):
    lab = managed_lab
    registry, name = rt.outbound_proxies(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, name, lab.variants["https-anonymous"])
        box = await managed_box(cleanup, rt, image, None)
        epoch, revision = await lab.readback(box, None)
        require_udp_ingress(lab, await udp_probe(box, lab, "echo"))
        marker = uuid4().hex
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("arm-udp-writer", box_id=box.id, epoch=epoch, phase=phase, marker=marker)
            started = time.time_ns()
            execution = await box.exec("python3", [
                "-c", GUEST_READ_OLD_UDP, lab.target_udp_ip, str(lab.target_udp_port), marker,
            ], timeout_secs=100)
            await control.step("await-udp-writer", box_id=box.id, phase=phase, marker=marker)
            require_udp_ingress(lab, marker)
            async with asyncio.TaskGroup() as updates:
                update = updates.create_task(replace_policy(
                    isolated_org, box, revision, {"mode": "enabled", "allow_net": [], "proxy": name},
                ))
                await control.step("release-udp-writer", box_id=box.id, phase=phase, marker=marker)
            response = update.result()
            completed = time.time_ns()
            evidence = await control.step("udp-writer-evidence", box_id=box.id, epoch=epoch, phase=phase,
                                          marker=marker, started_ns=started, completed_ns=completed)
            guest_link_evidence(evidence, lab.runner_id, box.id, epoch, marker, phase, started, completed)
            if phase == "partial":
                row = await deployment_box(lab, box.id)
                require(response.status == 409 and json.loads(response.body).get("code")
                        == "outbound_application_unconfirmed" and row["control"]["revision"] == revision,
                        "the incomplete Guest-link write advanced the Cloud revision")
            else:
                installed_epoch, installed_revision = await lab.readback(box, binding)
                require(response.status == 200 and response.headers.get("etag") == f'"{installed_revision}"'
                        and installed_epoch == epoch and installed_revision != revision,
                        "the old frame control did not settle the new revision in the same epoch")
                await execution.stdin().send_input(b"read-old-frame\n")
                async with asyncio.timeout(12):
                    stdout, _ = await drain(execution)
                    require((await execution.wait()).exit_code == 0 and json.loads(stdout).get("received")
                            == (marker if phase == "completed" else None), "Guest received the wrong old UDP frame")
                blocked = await udp_probe(box, lab, "no-echo")
                require(not lab.observations(blocked), "new external UDP escaped the authenticated binding")


async def test_managed_proxy_deployment_preserves_dhcp_ack_while_external_udp_is_blocked(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    registry, name = rt.outbound_proxies(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, name, lab.variants["https-anonymous"])
        bound = await managed_box(cleanup, rt, image, name)
        direct = await managed_box(cleanup, rt, image, None)
        state = await lab.readback(bound, binding)
        require_udp_ingress(lab, await udp_probe(direct, lab, "echo"))
        lease_ip = await execute_network_probe(bound, GUEST_LEASE_ADDRESS, [GATEWAY_DNS_IPV4])
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("arm-dhcp", box_id=bound.id, epoch=state[0])
            started = time.time_ns()
            async with asyncio.TaskGroup() as probes:
                captured = probes.create_task(control.step("renew-dhcp", box_id=bound.id, epoch=state[0]))
                denied = probes.create_task(udp_probe(bound, lab, "no-echo"))
            completed = time.time_ns()
            dhcp_evidence(captured.result(), lab.runner_id, bound.id, state[0], lease_ip, GATEWAY_DNS_IPV4,
                          started, completed)
            require(not lab.observations(denied.result()), "external UDP reached the target during DHCP renewal")
            require(await execute_network_probe(bound, GUEST_LEASE_ADDRESS, [GATEWAY_DNS_IPV4]) == lease_ip
                    and await lab.readback(bound, binding) == state, "DHCP changed the lease address or bound revision")
        require_udp_ingress(lab, await udp_probe(direct, lab, "echo"))
