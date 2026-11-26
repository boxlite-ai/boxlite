"""Dev acceptance for protected V2 process recovery and final-restart placement."""

import asyncio
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
import re
from uuid import UUID

import pytest

from conftest import e2e_box_name
from managed_outbound import ManagedOutboundLab, query_postgres_json
from managed_outbound_deployment import controlled_run, deployment_box, load_deployment
from preview import require
from test_managed_outbound import managed_box, remove_registration, wait_for_confirmed_proxy


async def verify_test_organization(lab, commit):
    gate = await query_postgres_json(lab.postgres_service, "commit", commit, """
        SELECT jsonb_build_object('organization', dev_acceptance_organization, 'public_open', enabled)
        FROM outbound_proxy_admission
        WHERE singleton AND dev_acceptance_commit = :'commit' AND dev_acceptance_until > clock_timestamp();
    """)
    require(isinstance(gate, dict) and gate["public_open"] is False and gate["organization"],
            "the bounded dev test organization must have access with public admission closed")
    return gate["organization"]


@pytest.mark.e2e
@pytest.mark.managed_outbound
async def test_protected_v2_release_acceptance(pytestconfig, e2e_auth, rt, image):
    output = os.environ.get("BOXLITE_PROTECTED_V2_ACCEPTANCE_OUTPUT")
    if not output:
        pytest.skip("run the protected V2 dev acceptance workflow")
    commit = os.environ["BOXLITE_PROTECTED_V2_ACCEPTANCE_COMMIT"]
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "invalid acceptance commit")
    config_path = pytestconfig.getoption("--managed-outbound-config")
    require(config_path, "configure the existing dev protected outbound test organization")
    config = json.loads(Path(config_path).read_text())
    lab = ManagedOutboundLab.load(config_path)
    require(e2e_auth.url.rstrip("/") == lab.api_origin and e2e_auth.path_prefix == lab.organization_prefix
            and e2e_auth.auth == "api-key", "expected the existing isolated dev API identity")
    deployment = load_deployment(config.get("deployment"), lab)
    organization = await verify_test_organization(lab, commit)

    proxy = e2e_box_name()
    registry = rt.outbound_proxies()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, proxy)
        await registry.create(proxy, lab.variants["https-anonymous"].endpoint)
        async with controlled_run(lab, deployment) as (control, _):
            name = e2e_box_name()
            await control.step("prepare-protected-v2-release", name=name)
            box = await managed_box(cleanup, rt, image, proxy, name=name)
            async with asyncio.timeout(60):
                await wait_for_confirmed_proxy(box, proxy)
            before = await deployment_box(lab, box.id)
            managed = before["control"]["managed"]
            epoch = managed["epoch"]
            attempt = managed["launch"]["key"]["attempt_id"]
            require(before["organization"] == organization and before["runner_id"] == lab.runner_id
                    and before["pins"] and all(pin["runner_id"] == lab.runner_id for pin in before["pins"]),
                    "the test organization must own the exact bound V2 epoch")

            target = {"box_id": box.id, "epoch": epoch, "attempt_id": attempt}
            interruption = await control.step("interrupt-protected-v2-release", **target)
            require(all(interruption.get(key) == value for key, value in target.items())
                    and interruption.get("runner_id") == lab.runner_id
                    and interruption.get("process_exit_signal") == "SIGKILL",
                    "expected observed abnormal exit of the exact unsealed protected process")
            ambiguous = await deployment_box(lab, box.id)
            require(ambiguous["pins"] == before["pins"], "uncertain termination released protected references")
            await control.step("settle-protected-v2-release", **target)
            events = await control.evidence("protected-v2-release", box.id)
            require(any(
                event["runner_id"] == lab.runner_id and event["operation"] == "retire-terminated"
                and event.get("epoch") == epoch and event.get("attempt_id") == attempt
                and event["delivered"] and event["reply_forwarded"]
                for event in events
            ), "exact terminated-epoch retirement was not observed")
            after = await deployment_box(lab, box.id)
            require(all(pin["runtime_epoch"] != epoch for pin in after["pins"]),
                    "acknowledged epoch retirement still owns a proxy reference")

            name = e2e_box_name()
            restarted = await control.step("verify-protected-v2-final-restart", name=name)
            process_id = str(UUID(restarted["process_id"]))
            previous_process_id = str(UUID(restarted["previous_process_id"]))
            require(process_id != previous_process_id, "final restart must identify a new Runner process")
            new_box = await managed_box(cleanup, rt, image, proxy, name=name)
            async with asyncio.timeout(60):
                await wait_for_confirmed_proxy(new_box, proxy)
            placed = await deployment_box(lab, new_box.id)
            require(placed["organization"] == organization and placed.get("state") == "started"
                    and placed["runner_id"] == restarted.get("runner_id") and placed["runner_id"] in control.runner_ids
                    and placed["control"].get("managed") and placed["pins"],
                    "the test organization did not place a protected Box on the restarted V2 Runner")
            runner = await query_postgres_json(lab.postgres_service, "runner_id", placed["runner_id"], """
                SELECT jsonb_build_object(
                    'version', "apiVersion", 'process', "protectedProcessId", 'digest', "protectedExecutableDigest"
                ) FROM runner
                WHERE id = :'runner_id' AND "lastChecked" >= now() - interval '60 seconds';
            """)
            require(isinstance(runner, dict) and runner["version"] == "2" and runner["process"] == process_id
                    and isinstance(runner["digest"], str) and re.fullmatch(r"[a-f0-9]{64}", runner["digest"]),
                    "placement did not match the authenticated final V2 process")
            require(await verify_test_organization(lab, commit) == organization, "the dev acceptance scope changed")

    Path(output).write_text(json.dumps({
        "version": 1,
        "stage": "dev",
        "commit": commit,
        "executableDigest": runner["digest"],
        "abnormalExitRollback": "passed",
        "finalRestartAdmission": "passed",
    }), encoding="utf-8")
