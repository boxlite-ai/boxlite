"""Acceptance checks requiring the isolated deployment fault controller."""

import asyncio
from contextlib import AsyncExitStack
import json
import time
from uuid import UUID, uuid4

import boxlite
from boxlite.errors import ManagedCreateError
import pytest

from conftest import bound_box_lifetime, e2e_box_name, wait_until_unlisted, with_bounded_lifetime
from managed_outbound_deployment import (
    controlled_run, deployment_box, deployment_box_ids, runner_receipt,
)
from preview import http, require
from test_managed_outbound import (
    cleanup_box, deployment_runners, isolated_org, literal_https_probe, managed_box, managed_lab, register_proxy, registry_request,
    remove_registration, wait_for_confirmed_proxy,
)


pytestmark = [pytest.mark.e2e, pytest.mark.managed_outbound]
WARM_POOL_OWNER = "00000000-0000-0000-0000-000000000000"


async def replace_policy(ctx, box, revision, policy):
    return await http(
        ctx.url_for(ctx.v1(f"boxes/{box.id}/network/outbound")), "PUT",
        {**ctx.auth_headers(content_type=True), "If-Match": f'"{revision}"'}, json.dumps(policy).encode(),
    )


async def post_bound_box(ctx, image, name, proxy):
    return await registry_request(ctx, "POST", "boxes", with_bounded_lifetime({
        "name": name, "image": image, "network": {"outbound": {"mode": "enabled", "proxy": proxy}},
    }))


async def assert_registration_pinned(ctx, name):
    denied = await registry_request(ctx, "DELETE", f"proxies/{name}")
    require(denied.status == 409, "referenced registration was not protected from deletion")


def candidate_runner(armed, deployment_runners):
    try:
        runner = str(UUID(armed["candidate_runner_id"]))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise AssertionError("controller did not identify the incompatible Runner") from None
    require(runner not in deployment_runners, "incompatible candidate overlaps an enrolled control Runner")
    return runner


@pytest.mark.parametrize(("profile", "diagnostic"), [
    ("http-only-v0", "runner_proxy_tls_unsupported"), ("v2-only", "runner_proxy_unsupported"),
])
async def test_managed_proxy_deployment_rejects_incompatible_admission(
    managed_lab, deployment_runners, rt, image, isolated_org, profile, diagnostic,
):
    lab = managed_lab
    registry, name, proxy = rt.outbound_proxies(), e2e_box_name(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy)
        cleanup.push_async_callback(cleanup_box, rt, name)
        await register_proxy(isolated_org, registry, proxy, lab.variants["https-anonymous"])
        async with controlled_run(lab, deployment_runners) as (control, replacement):
            armed = await control.step("arm-create", name=name, fault=profile)
            candidate = candidate_runner(armed, (lab.runner_id, replacement.runner_id))
            result = await post_bound_box(isolated_org, image, name, proxy)
            require(result.status == 503, "bound create did not refuse incompatible Runner placement")
            body = json.loads(result.body)
            require(body.get("code") == "outbound_create_rejected" and "boxId" not in body and "box_id" not in body
                    and body.get("diagnostic") == {"code": diagnostic}, "create refusal details differ")
            require(await deployment_box_ids(lab, name) == [], "refused create allocated a persistent Box")
            post, events = await control.create_evidence(name, candidate=candidate)
            require(post["status"] == 503 and post["reply_forwarded"] and not events,
                    "placement refusal dispatched work or lacked an observed public response")


@pytest.mark.parametrize("fault", [
    "drop-public-reply", "reset-first-runner-reply", "reset-all-runner-replies", "hold-first-runner-reply",
])
async def test_managed_proxy_deployment_create_acknowledgement(
    managed_lab, deployment_runners, rt, image, isolated_org, fault,
):
    lab = managed_lab
    captures = lab.tcp_faults
    require(captures is not None, "configure independent target capture for the creation window")
    registry, name, proxy = rt.outbound_proxies(), e2e_box_name(), e2e_box_name()
    variant = lab.variants["https-credential"]
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy)
        cleanup.push_async_callback(cleanup_box, rt, name)
        binding = await register_proxy(isolated_org, registry, proxy, variant)
        control_box = await managed_box(cleanup, rt, image, proxy)
        positive = await literal_https_probe(control_box, lab, variant)
        require(await captures.syn.packets(*positive[:2]), "creation target capture missed its positive control")
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("arm-create", name=name, fault=fault)
            started = time.time_ns()
            if fault == "drop-public-reply":
                options = boxlite.BoxOptions(image=image)
                bound_box_lifetime(options)
                with pytest.raises(ManagedCreateError) as dropped:
                    await rt.create_with_outbound_proxy(options, proxy, name)
                error = dropped.value
                require(error.admission == "unknown" and error.http_status is None and error.box_id is None,
                        "SDK did not report an unknown create after losing the public reply")
            else:
                sent_at = time.monotonic()
                result = await post_bound_box(isolated_org, image, name, proxy)
                elapsed = time.monotonic() - sent_at
                payload = json.loads(result.body)

            ids = await deployment_box_ids(lab, name)
            require(len(ids) == 1, "expected exactly one persisted Box for the original public request")
            box_id, = ids
            listed = [item.id for item in await rt.list_info() if item.name == name]
            require(listed == [box_id], "exact-name SDK lookup did not find the admitted Box")
            post, events = await control.create_evidence(name, box_id)
            creates = [event for event in events if event["operation"] == "create"]
            boots = [event for event in events if event["operation"] == "bootstrap"]
            count = {"drop-public-reply": 1, "reset-first-runner-reply": 2,
                     "reset-all-runner-replies": 4, "hold-first-runner-reply": 1}[fault]
            require(len(creates) == count and all(event["delivered"] and event.get("stopped_placeholder") is True
                    and not event["credential_present"] and event["runner_id"] == lab.runner_id for event in creates),
                    "Runner create ingresses differ from the original credential-free stopped allocation")
            require(post["reply_forwarded"] is (fault != "drop-public-reply"),
                    "public response forwarding did not match the requested fault")
            resets = 1 if fault == "reset-first-runner-reply" else 4 if fault == "reset-all-runner-replies" else 0
            require(all(event.get("reply_fault") == "reset-before-response" and not event["reply_forwarded"]
                        for event in creates[:resets]), "Runner replies were not reset before their first byte")

            row = await deployment_box(lab, box_id)
            if fault in {"drop-public-reply", "reset-first-runner-reply"}:
                launch = row["control"]["managed"]["launch"]["key"]
                require(post["status"] == 201 and len(boots) == 1 and boots[0]["delivered"]
                        and boots[0]["runner_id"] == lab.runner_id and creates[-1]["reply_forwarded"]
                        and boots[0]["credential_present"] and boots[0].get("attempt_id") == launch["attempt_id"],
                        "creation did not complete exactly one bootstrap for the stored attempt")
                if fault == "reset-first-runner-reply":
                    require(result.status == 201 and payload.get("box_id") == box_id,
                            "Runner retry did not return the original Box")
                box = await rt.get(box_id)
                require(box is not None, "confirmed Box was not recoverable by its original ID")
                await lab.readback(box, binding)
                return

            require(result.status in {408, 422} and post["status"] == result.status
                    and payload.get("code") == "outbound_create_admitted" and payload.get("boxId") == box_id
                    and row["runner_id"] == lab.runner_id and not row["control"].get("managed")
                    and not boots and not any(event["credential_present"] or event["operation"] == "start"
                                              for event in events),
                    "failed create did not preserve one unconfirmed allocation without dispatching bootstrap")
            if fault == "hold-first-runner-reply":
                require(result.status == 408 and elapsed >= 29.9 and post.get("runner_request_active") is True
                        and creates[0].get("reply_fault") == "held" and not creates[0]["reply_forwarded"],
                        "the public deadline was not reached with exactly one Runner request still held")
            placeholder = await http(f"{lab.runner_origin}/boxes/{box_id}", headers=lab.runner_headers())
            require(placeholder.status == 200 and json.loads(placeholder.body).get("state") == "stopped",
                    "authenticated Runner did not confirm the same stopped placeholder")
            require(not await captures.syn.packets(started, time.time_ns()), "unconfirmed create reached the target")
            if fault == "hold-first-runner-reply":
                await control.step("finish-held-create", box_id=box_id)
                _, finished = await control.create_evidence(name, box_id)
                require(len(finished) == 1 and finished[0]["operation"] == "create"
                        and finished[0].get("response_status") == 422 and not finished[0]["credential_present"],
                        "finishing the held placeholder caused a Runner retry or bootstrap")


async def test_managed_proxy_deployment_refuses_bound_v2_restart(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    registry, proxy = rt.outbound_proxies(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy)
        binding = await register_proxy(isolated_org, registry, proxy, lab.variants["https-anonymous"])
        box = await managed_box(cleanup, rt, image, proxy)
        epoch, _ = await lab.readback(box, binding)
        stopped = await registry_request(isolated_org, "POST", f"boxes/{box.id}/stop")
        require(stopped.status == 201, "could not stop the bound V0 control")
        async with asyncio.timeout(60):
            while True:
                original = await deployment_box(lab, box.id)
                if original["state"] == "stopped" and not original["pending"]:
                    break
                await asyncio.sleep(0.5)
        require(original["runner_id"] == lab.runner_id and original["desired_state"] == "stopped"
                and original["control"]["managed"]["epoch"] == epoch and original["pins"],
                "stopped V0 control did not retain its binding")

        async with controlled_run(lab, deployment_runners) as (control, replacement):
            staged = await control.step("stage-v2-restart", box_id=box.id, epoch=epoch)
            candidate = candidate_runner(staged, (lab.runner_id, replacement.runner_id))
            before = await deployment_box(lab, box.id)
            require(before == {**original, "runner_id": candidate}, "V2 setup changed the stopped binding or pins")
            result = await registry_request(isolated_org, "POST", f"boxes/{box.id}/start")
            require(result.status == 503 and json.loads(result.body).get("diagnostic")
                    == {"code": "runner_proxy_unsupported"}, "bound V2 restart returned an unexpected refusal")
            require(await deployment_box(lab, box.id) == before, "refused restart changed the stopped Box or its pins")
            require(not await control.evidence("v2-restart-refused", box.id, candidate=candidate),
                    "refused bound restart dispatched Runner work")
            await assert_registration_pinned(isolated_org, proxy)
        require(await deployment_box(lab, box.id) == original, "V2 fixture cleanup did not restore assignment")


async def test_managed_proxy_deployment_refuses_unbind_without_runner_evidence(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    registry, primary, pending_proxy = rt.outbound_proxies(), e2e_box_name(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        for name in (primary, pending_proxy):
            cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, primary, lab.variants["https-anonymous"])
        await register_proxy(isolated_org, registry, pending_proxy, lab.variants["http-anonymous"])
        box = await managed_box(cleanup, rt, image, primary)
        epoch, revision = await lab.readback(box, binding)
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("drop-prepare-reply", box_id=box.id)
            deferred = await replace_policy(
                isolated_org, box, revision, {"mode": "enabled", "allow_net": [], "proxy": pending_proxy},
            )
            require(deferred.status == 409 and json.loads(deferred.body).get("code") == "outbound_application_unconfirmed",
                    "could not establish the pending bound update")
            before = await deployment_box(lab, box.id)
            pending = before["control"]["managed"]["pending"]
            receipt = await runner_receipt(lab, box.id, epoch)
            require(receipt["pending_attempt"] == pending["attempt_id"]
                    and receipt["installed"]["snapshot"]["revision"] == revision
                    and {pin["kind"] for pin in before["pins"]} == {"committed", "pending"},
                    "pending unbind control lacked exact Runner evidence and both pins")

            await control.step("drop-inspect-reply", box_id=box.id)
            result = await replace_policy(
                isolated_org, box, revision, {"mode": "enabled", "allow_net": [], "proxy": None},
            )
            require(result.status == 409 and json.loads(result.body).get("code") == "outbound_update_blocked",
                    "unbind without authenticated evidence returned an unexpected response")
            require(await deployment_box(lab, box.id) == before, "refused unbind changed policy, attempts or pins")
            observed = await runner_receipt(lab, box.id, epoch)
            require(all(receipt[field] == observed[field] for field in ("pending_attempt", "installed", "durable")),
                    "refused unbind changed Runner state")
            events = await control.evidence("unbind-refused", box.id)
            require(events and all(event["operation"] == "inspect" and event["delivered"]
                                   and not event["reply_forwarded"] and not event["credential_present"] for event in events),
                    "unbind did not exercise unavailable evidence or dispatched a mutation")
            for name in (primary, pending_proxy):
                await assert_registration_pinned(isolated_org, name)


async def test_managed_proxy_deployment_retains_binding_after_ordinary_runner_404(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    registry, proxy = rt.outbound_proxies(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy)
        binding = await register_proxy(isolated_org, registry, proxy, lab.variants["https-anonymous"])
        box = await managed_box(cleanup, rt, image, proxy)
        epoch, revision = await lab.readback(box, binding)
        before = await deployment_box(lab, box.id)
        original = before["control"]["managed"]
        key = original["launch"]["key"]
        require((await runner_receipt(lab, box.id, epoch, bootstrap_key=key)).get("outcome") == "confirmed",
                "delete control lacked the authenticated active boot receipt")
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("arm-delete-404", box_id=box.id, epoch=epoch)
            requested = await registry_request(isolated_org, "DELETE", f"boxes/{box.id}")
            require(requested.status == 204, "public delete was not admitted")
            await control.step("await-delete-404", box_id=box.id, epoch=epoch)
            events = await control.evidence("delete-unresolved", box.id)
            require(any(event["runner_id"] == lab.runner_id and event["operation"] == "stop"
                        and event.get("response_status") == 404 and event["reply_forwarded"] for event in events)
                    and any(event["operation"] == "retire" and not event["reply_forwarded"] for event in events)
                    and all(event["runner_id"] == lab.runner_id and not event["credential_present"]
                            and event["operation"] != "remove-retired" for event in events),
                    "delete fixture did not observe an ordinary 404 without retirement proof")
            after = await deployment_box(lab, box.id)
            managed = after["control"].get("managed", {})
            retirement = managed.get("retirement", {})
            require(after["desired_state"] == "destroyed" and after["state"] != "destroyed" and after["pending"]
                    and after["runner_id"] == before["runner_id"] and after["old_runner_id"] == before["old_runner_id"]
                    and after["control"]["revision"] == revision and after["pins"] == before["pins"]
                    and all(managed.get(key) == original[key] for key in ("runnerId", "binding", "epoch", "launch"))
                    and retirement.get("terminated") is False and retirement.get("resolved") is not True,
                    "ordinary Runner 404 settled deletion or released the binding")
            require((await runner_receipt(lab, box.id, epoch, bootstrap_key=key)).get("outcome") == "confirmed",
                    "the Runner lost the original authenticated boot identity during the refused retirement")
            await assert_registration_pinned(isolated_org, proxy)

        require(not await wait_until_unlisted(rt, [box.id]), "the original Box remained after retirement was restored")


async def test_managed_proxy_deployment_bypasses_matching_warm_box(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    proxy = lab.variants["https-credential"]
    registry, proxy_name, name = rt.outbound_proxies(), e2e_box_name(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy_name)
        binding = await register_proxy(isolated_org, registry, proxy_name, proxy)
        async with controlled_run(lab, deployment_runners) as (control, _):
            seeded = await control.step("seed-warm-pool", image=image, name=name)
            warm_id = seeded.get("box_id")
            require(isinstance(warm_id, str), "warm fixture did not supply the pool Box ID")
            before = await deployment_box(lab, warm_id)
            require(before["organization"] == WARM_POOL_OWNER and before["state"] == "started"
                    and before["runner_id"] == lab.runner_id and not before["pending"]
                    and not before["control"].get("managed") and not before["pins"],
                    "the seeded warm Box is not ready and unbound")
            box = await managed_box(cleanup, rt, image, proxy_name, name=name)
            require(box.id != warm_id, "bound create claimed the warm Box")
            await lab.readback(box, binding)
            created = await deployment_box(lab, box.id)
            require(created["shape"] == before["shape"], "the warm Box did not match the requested shape")
            require(await deployment_box(lab, warm_id) == before, "bound create mutated the warm Box")
            events = await control.evidence("warm-create", box.id)
            creates = [event for event in events if event["operation"] == "create" and event["delivered"]]
            boots = [event for event in events if event["operation"] == "bootstrap" and event["delivered"]]
            require(len(creates) == len(boots) == 1 and not creates[0]["credential_present"]
                    and boots[0]["credential_present"],
                    "expected one fresh stopped placeholder followed by one credential-bearing bootstrap")
            require(not await control.evidence("warm-create", warm_id), "the warm Box received managed dispatch")

            control_name = e2e_box_name()
            options = boxlite.BoxOptions(image=image)
            bound_box_lifetime(options)
            cleanup.push_async_callback(cleanup_box, rt, control_name)
            ordinary = await rt.create(options, name=control_name)
            require(ordinary.id == warm_id, "the ordinary create control could not claim the seeded warm Box")


async def test_managed_proxy_deployment_refuses_legacy_write_during_apply(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    registry = rt.outbound_proxies()
    proxy_a, proxy_b = e2e_box_name(), e2e_box_name()
    async with AsyncExitStack() as cleanup:
        for name in (proxy_a, proxy_b):
            cleanup.push_async_callback(remove_registration, registry, name)
        binding_a = await register_proxy(isolated_org, registry, proxy_a, lab.variants["https-anonymous"])
        binding_b = await register_proxy(isolated_org, registry, proxy_b, lab.variants["http-anonymous"])
        box = await managed_box(cleanup, rt, image, proxy_a)
        epoch, stale = await lab.readback(box, binding_a)
        settled = await replace_policy(
            isolated_org, box, stale, {"mode": "enabled", "allow_net": [f"{lab.target_tcp_ip}/32"], "proxy": proxy_a},
        )
        current_epoch, revision = await lab.readback(box, binding_a)
        require(settled.status == 200 and current_epoch == epoch and stale != revision,
                "could not establish distinct settled and stale revisions")
        async with controlled_run(lab, deployment_runners) as (control, _):
            await control.step("observe-box", box_id=box.id)
            original = await deployment_box(lab, box.id)
            stale_update = {"mode": "enabled", "allow_net": [], "proxy": proxy_b}
            stale_settled = await replace_policy(isolated_org, box, stale, stale_update)
            require(stale_settled.status == 412 and await deployment_box(lab, box.id) == original
                    and not await control.evidence("stale-settled", box.id),
                    "settled stale write changed persisted state or dispatched Runner work")
            await control.step("drop-prepare-reply", box_id=box.id)
            # Wait for the original transaction to end before the legacy write asks for the same row lock.
            deferred = await replace_policy(
                isolated_org, box, revision, {"mode": "enabled", "allow_net": [], "proxy": proxy_b},
            )
            require(deferred.status == 409 and json.loads(deferred.body).get("code") == "outbound_application_unconfirmed",
                    "the managed request did not finish with an unconfirmed update")
            before = await deployment_box(lab, box.id)
            pending = before["control"].get("managed", {}).get("pending")
            require(pending and {pin["kind"] for pin in before["pins"]} == {"committed", "pending"},
                    "the lost prepare receipt did not leave a durable pending attempt and both pins")
            observed = await runner_receipt(lab, box.id, epoch)
            require(observed["pending_attempt"] == pending["attempt_id"]
                    and observed["installed"]["snapshot"]["revision"] == revision,
                    "the Runner has not staged this attempt over the installed predecessor")

            denied = await replace_policy(isolated_org, box, revision, {"mode": "disabled", "allow_net": []})
            require(denied.status == 409 and json.loads(denied.body).get("code") == "outbound_update_blocked",
                    "pending legacy write returned an unexpected result")
            stale_pending = await replace_policy(isolated_org, box, stale, stale_update)
            require(stale_pending.status == 409 and json.loads(stale_pending.body).get("code") == "outbound_update_blocked",
                    "unresolved work did not take precedence over the same stale revision")
            require(await deployment_box(lab, box.id) == before,
                    "pending legacy write mutated persisted policy, work or pins")
            receipt = await runner_receipt(lab, box.id, epoch)
            require(all(receipt[field] == observed[field] for field in ("pending_attempt", "installed", "durable")),
                    "pending legacy write changed authenticated Runner state")
            events = await control.evidence("legacy-write-blocked", box.id)
            prepares = [event for event in events if event["operation"] == "prepare"]
            require(prepares and all(event["runner_id"] == lab.runner_id and event["delivered"]
                                     and not event["reply_forwarded"] and event.get("attempt_id") == pending["attempt_id"]
                                     for event in prepares) and not any(event["operation"] == "apply" for event in events),
                    "Runner evidence did not confirm prepared work with no apply dispatch")

            await control.step("resume-prepare", box_id=box.id)
            async with asyncio.timeout(120):
                await wait_for_confirmed_proxy(box, binding_b)
            new_epoch, new_revision = await lab.readback(box, binding_b)
            require(new_epoch == epoch and new_revision == pending["candidate"]["snapshot"]["revision"],
                    "reconciliation did not commit the original pending revision in the same epoch")


@pytest.mark.parametrize("fault", ["missing-retire-reply", "irreconcilable-seal", "held-release"])
async def test_managed_proxy_deployment_recovers_on_second_runner(
    managed_lab, deployment_runners, rt, image, isolated_org, fault,
):
    lab = managed_lab
    captures = lab.tcp_faults
    require(captures is not None, "configure independent target capture for the recovery window")
    registry, name = rt.outbound_proxies(), e2e_box_name()
    proxy = lab.variants["https-anonymous"]
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, name, proxy)
        box = await managed_box(cleanup, rt, image, name)
        old_epoch, _ = await lab.readback(box, binding)
        positive = await literal_https_probe(box, lab, proxy)
        require(await captures.syn.packets(*positive[:2]), "recovery target capture missed the positive control")
        async with controlled_run(lab, deployment_runners) as (control, replacement):
            await control.step("arm-recovery", box_id=box.id, fault=fault, old_epoch=old_epoch)
            before = await deployment_box(lab, box.id)
            require(before["runner_id"] == lab.runner_id and {pin["kind"] for pin in before["pins"]}
                    == ({"committed"} if fault == "held-release" else {"committed", "pending"}),
                    "the recovery fixture did not preserve the required predecessor and references")
            started = time.time_ns()
            await control.step("reassign", box_id=box.id)
            await control.step("await-recovery-barrier", box_id=box.id, fault=fault)
            blocked = await deployment_box(lab, box.id)
            events = await control.evidence(fault, box.id)
            before_replacement = [event for event in events if event["runner_id"] == replacement.runner_id]
            if fault != "held-release":
                retired = [event for event in events if event["runner_id"] == lab.runner_id
                           and event["operation"] == "retire" and event["delivered"]]
                require(retired and any(event["reply_forwarded"] for event in retired) == (fault == "irreconcilable-seal"),
                        "old Runner retirement evidence did not exercise the specified fault")
                require(blocked["old_runner_id"] == lab.runner_id and blocked["pins"] == before["pins"],
                        "ambiguous retirement released old assignment evidence or references")
                managed = blocked["control"].get("managed", {})
                retirement = managed.get("retirement", {})
                require(retirement.get("terminated") is (fault == "irreconcilable-seal")
                        and retirement.get("resolved") is not True,
                        "durable retirement state did not retain the expected unresolved boundary")
                if fault == "irreconcilable-seal":
                    sealed = retirement["evidence"]
                    sealed_revision = sealed["durable"]["snapshot"]["revision"]
                    pending_revision = managed["pending"]["candidate"]["snapshot"]["revision"]
                    require(sealed_revision not in {blocked["control"]["revision"], pending_revision}
                            and sealed["rollback"] is None and not managed.get("restoration"),
                            "the sealed record was eligible for normal reconciliation")
                require(not before_replacement, "an unresolved old epoch contacted the replacement Runner")
                require(not await captures.syn.packets(started, time.time_ns()),
                        "unresolved recovery reached the target")
                return

            boot = blocked["control"].get("bootstrap")
            require(blocked["runner_id"] == replacement.runner_id and not blocked["old_runner_id"]
                    and boot and boot.get("epoch") and boot["epoch"] != old_epoch
                    and boot["key"]["runner_id"] == replacement.runner_id,
                    "replacement did not reach the exact held bootstrap epoch")
            retired = [index for index, event in enumerate(events) if event["runner_id"] == lab.runner_id
                       and event["operation"] == "retire" and event["delivered"] and event["reply_forwarded"]]
            booted = [index for index, event in enumerate(events) if event["runner_id"] == replacement.runner_id
                      and event["operation"] == "bootstrap" and event["delivered"]]
            require(retired and len(booted) == 1 and retired[0] < booted[0],
                    "replacement bootstrap was not ordered after the old Runner retirement receipt")
            require(len(blocked["pins"]) == 1 and blocked["pins"][0]["kind"] == "committed"
                    and blocked["pins"][0]["registration_id"] == before["pins"][0]["registration_id"]
                    and blocked["pins"][0]["revision"] == before["pins"][0]["revision"]
                    and blocked["pins"][0]["runtime_epoch"] == boot["epoch"],
                    "the held gate did not retain the exact reference on the new epoch")
            receipt = await runner_receipt(replacement, box.id, boot["epoch"], bootstrap_key=boot["key"])
            require(receipt.get("outcome") == "confirmed", "replacement did not authenticate its bootstrap receipt")
            public = await box.network.managed_proxy_status()
            require(public.get("application_state") == "pending" and public.get("runtime_readback") == "unknown",
                    "a held gate was exposed as confirmed")
            marker = uuid4().hex
            probe = await control.step(
                "probe-held-guest", box_id=box.id, epoch=boot["epoch"], marker=marker,
                target_origin=lab.target_origin,
            )
            require(probe.get("box_id") == box.id and probe.get("runner_id") == replacement.runner_id
                    and probe.get("epoch") == boot["epoch"]
                    and probe.get("marker") == marker and probe.get("completed") is True,
                    "the actual replacement Guest did not complete its held-gate probe")
            require(not lab.observations(marker) and not await captures.syn.packets(started, time.time_ns()),
                    "the replacement Guest reached the target while its gate was held")
            events = await control.evidence("held-release", box.id)
            require(not any(event["runner_id"] == replacement.runner_id and event["operation"] == "release-gate"
                            and event["delivered"] for event in events), "release reached Runner before the held probe")
            await control.step("release-recovery", box_id=box.id, generation=boot["generation"], epoch=boot["epoch"])
            await control.step("await-recovery-settled", box_id=box.id)
            releases = [event for event in await control.evidence("released", box.id)
                        if event["runner_id"] == replacement.runner_id
                        and event["operation"] == "release-gate" and event["delivered"]]
            require(releases and all(event.get("epoch") == boot["epoch"]
                                    and event.get("generation") == boot["generation"] for event in releases),
                    "gate release did not reach the exact epoch and generation")
            epoch, _ = await replacement.readback(box, binding)
            require(epoch == boot["epoch"], "recovery confirmed a different epoch")
            settled = await deployment_box(lab, box.id)
            require(not settled["control"].get("bootstrap")
                    and len(settled["pins"]) == 1
                    and settled["pins"][0]["kind"] == "committed"
                    and settled["pins"][0]["runtime_epoch"] == epoch,
                    "recovery did not settle the replacement reference")
            await literal_https_probe(box, replacement, proxy)
