"""Fault control and independent evidence for the isolated deployment cases."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from ipaddress import ip_address
import json
import os
from pathlib import Path
import re
from uuid import UUID, uuid4

from managed_outbound import checked_url, query_box_json, query_postgres_json
from preview import http, require


@dataclass(frozen=True)
class DeploymentControl:
    executable: Path
    organization: str
    runner_ids: tuple[str, str]
    run_id: str = field(default_factory=lambda: uuid4().hex)

    async def step(self, action, **fields):
        request = dict(fields, action=action, run_id=self.run_id, organization=self.organization,
                       primary_runner_id=self.runner_ids[0], replacement_runner_id=self.runner_ids[1])
        proc = await asyncio.create_subprocess_exec(
            str(self.executable), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            output, _ = await asyncio.wait_for(proc.communicate(json.dumps(request).encode()), timeout=60)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
        require(proc.returncode == 0 and 0 < len(output) <= 65536, f"deployment controller failed at {action}")
        try:
            result = json.loads(output)
        except (ValueError, UnicodeError):
            raise AssertionError(f"deployment controller returned invalid JSON at {action}") from None
        require(isinstance(result, dict) and result.get("run_id") == self.run_id and result.get("action") == action,
                f"deployment controller returned evidence for a different action or run at {action}")
        return result

    async def evidence(self, barrier, box_id, *, candidate=None):
        observation = await self.step("evidence", barrier=barrier, box_id=box_id)
        return self._events(observation, box_id, candidate)

    async def create_evidence(self, name, box_id=None, *, candidate=None):
        observation = await self.step("create-evidence", name=name, box_id=box_id)
        require(observation.get("name") == name and observation.get("public_ready") is True,
                "create evidence missed the named public request observer")
        posts = observation.get("public_posts")
        require(isinstance(posts, list) and len(posts) == 1 and isinstance(posts[0], dict)
                and posts[0].get("box_id") == box_id and type(posts[0].get("status")) is int
                and type(posts[0].get("reply_forwarded")) is bool,
                "expected exactly one correlated public create request and response")
        return posts[0], self._events(observation, box_id, candidate)

    async def connect_window(self, box_id, epoch, address, port, started_ns, completed_ns):
        result = await self.step("connect-evidence", box_id=box_id, epoch=epoch, address=address, port=port,
                                 started_ns=started_ns, completed_ns=completed_ns)
        return connect_attempts(result, self.runner_ids[0], box_id, epoch, address, port, started_ns, completed_ns)

    def _events(self, observation, box_id, candidate):
        runners = (*self.runner_ids, candidate) if candidate else self.runner_ids
        ready, events = observation.get("ready"), observation.get("events")
        require(isinstance(ready, list) and all(runner in ready for runner in runners) and isinstance(events, list),
                "Runner evidence is missing a synchronized live observer")
        for event in events:
            require(isinstance(event, dict) and isinstance(event.get("box_id"), str)
                    and (box_id is None or event["box_id"] == box_id) and event.get("runner_id") in runners
                    and isinstance(event.get("operation"), str)
                    and type(event.get("delivered")) is bool and type(event.get("reply_forwarded")) is bool
                    and type(event.get("credential_present")) is bool,
                    "Runner evidence includes an unscoped or malformed observation")
        return events


def connect_attempts(report, runner_id, box_id, epoch, address, port, started_ns, completed_ns):
    require(report.get("runner_id") == runner_id and report.get("box_id") == box_id and report.get("epoch") == epoch
            and report.get("address") == address and report.get("port") == port
            and report.get("complete") is True and type(report.get("from_ns")) is int
            and type(report.get("through_ns")) is int and report["from_ns"] <= started_ns <= completed_ns
            <= report["through_ns"], "connect trace did not cover the exact Box epoch and probe window")
    attempts = report.get("attempts")
    require(isinstance(attempts, list), "connect trace omitted the attempted destination records")
    for entry in attempts:
        require(isinstance(entry, dict) and type(entry.get("time_ns")) is int
                and started_ns <= entry["time_ns"] <= completed_ns and entry.get("port") == port
                and entry.get("family") in {"inet", "inet6"} and isinstance(entry.get("result"), str),
                "connect trace has an unscoped or malformed attempt")
        try:
            peer = ip_address(entry.get("address"))
        except ValueError:
            raise AssertionError("connect trace has an invalid destination address") from None
        require(str(getattr(peer, "ipv4_mapped", None) or peer) == address
                and peer.version == (4 if entry["family"] == "inet" else 6),
                "connect trace recorded a different destination or address family")
    return attempts


def guest_link_evidence(report, runner_id, box_id, epoch, marker, phase, started_ns, completed_ns):
    identity = {"runner_id": runner_id, "box_id": box_id, "epoch": epoch, "marker": marker, "phase": phase}
    require(all(report.get(key) == value for key, value in identity.items()) and report.get("complete") is True
            and isinstance(report.get("generation"), str) and bool(report["generation"])
            and type(report.get("old_writes_after_seal")) is int and report["old_writes_after_seal"] == 0,
            "Guest-link evidence missed the marker, epoch, generation or fence")
    queued, sealed = report.get("queued_ns"), report.get("sealed_ns")
    start, end = report.get("write_started_ns"), report.get("write_completed_ns")
    declared, accepted, header = (report.get(field) for field in ("declared_bytes", "accepted_bytes", "header_bytes"))
    require(type(queued) is int and type(sealed) is int and started_ns <= queued <= sealed <= completed_ns
            and all(type(size) is int for size in (declared, accepted, header)) and 0 < declared <= 65535
            and 0 <= accepted <= declared, "invalid Guest-link timestamps or frame byte counts")
    if phase == "completed":
        require(type(start) is int and type(end) is int and queued <= start <= end <= sealed
                and accepted == declared and header == 4, "the completed frame did not finish before the fence")
    elif phase == "queued":
        require(start is None and end is None and accepted == header == 0 and report.get("frame_dropped") is True,
                "the queued old frame was not dropped before reaching the writer")
    else:
        closed = report.get("closed_ns")
        require(phase == "partial" and type(start) is int and type(closed) is int and queued <= start <= sealed
                <= closed <= completed_ns and end is None and header == 4 and accepted < declared
                and report.get("peer_payload_bytes") == 0 and report.get("outcome") == "uncertain",
                "the peer did not close a header-only partial write as uncertain")


def dhcp_evidence(report, runner_id, box_id, epoch, lease_ip, gateway, started_ns, completed_ns):
    identity = {"runner_id": runner_id, "box_id": box_id, "epoch": epoch}
    require(all(report.get(key) == value for key, value in identity.items()) and report.get("complete") is True,
            "DHCP capture did not cover the attested Box and epoch")
    request, ack = report.get("request"), report.get("ack")
    require(isinstance(request, dict) and isinstance(ack, dict) and request.get("type") == "request"
            and ack.get("type") == "ack" and type(request.get("xid")) is int and 0 < request["xid"] < 2**32
            and ack.get("xid") == request["xid"] and isinstance(request.get("client"), str)
            and re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", request["client"]) is not None
            and ack.get("client") == request["client"] and request.get("address") == ack.get("address") == lease_ip
            and ack.get("server") == gateway and ack.get("received_by_guest") is True
            and type(request.get("time_ns")) is int and type(ack.get("time_ns")) is int
            and started_ns <= request["time_ns"] <= ack["time_ns"] <= completed_ns,
            "the bound Guest did not receive a matching DHCP lease acknowledgement")


@asynccontextmanager
async def controlled_run(lab, deployment_runners):
    executable, replacement = deployment_runners
    control = DeploymentControl(executable, lab.organization_prefix, (lab.runner_id, replacement.runner_id))
    try:
        yield control, replacement
    finally:
        await control.step("cleanup")


def load_deployment(config, lab):
    require(isinstance(config, dict), "configure the managed outbound deployment controller")
    try:
        executable = Path(config["controller"])
        require(executable.is_absolute() and executable.is_file() and os.access(executable, os.X_OK),
                "provide an absolute path to an executable isolated deployment controller")
        next_runner = config["replacement_runner"]
        replacement = replace(
            lab, runner_id=str(UUID(next_runner["runner_id"])),
            runner_origin=checked_url(next_runner["runner_origin"], "https", path_allowed=False),
            inventory_url=checked_url(next_runner["inventory_url"], "https", path_allowed=True),
            inventory_token=os.environ["BOXLITE_E2E_REPLACEMENT_INVENTORY_TOKEN"],
            runner_key=os.environ["BOXLITE_E2E_REPLACEMENT_RUNNER_KEY"],
        )
    except (KeyError, TypeError, ValueError):
        raise AssertionError("invalid replacement Runner deployment configuration") from None
    require(replacement.runner_id != lab.runner_id and replacement.runner_origin != lab.runner_origin
            and replacement.runner_key and replacement.inventory_token,
            "deployment recovery requires two distinct authenticated Runners")
    return executable, replacement


async def deployment_box_ids(lab, name):
    require(re.fullmatch(r"e2e-[a-zA-Z0-9-]+", name) is not None, "invalid acceptance Box name")
    return await query_postgres_json(lab.postgres_service, "box_name", name, '''
        SELECT COALESCE(jsonb_agg(b.id ORDER BY b.id), '[]'::jsonb) FROM box b WHERE b.name = :'box_name';
    ''')


async def deployment_box(lab, box_id):
    query = '''
        SELECT jsonb_build_object(
            'organization', b."organizationId", 'state', b.state, 'desired_state', b."desiredState",
            'runner_id', b."runnerId", 'old_runner_id', b."prevRunnerId", 'pending', b.pending,
            'shape', jsonb_build_array(b.region, b.class, b.image, b.cpu, b.mem, b.disk, b.gpu, b."osUser"),
            'policy', jsonb_build_array(b."outboundEnabled", b."outboundAllowNet"),
            'control', COALESCE(b."outboundControl", '{}'::jsonb),
            'pins', COALESCE((
                SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind, r.registration_id, r.revision, r.attempt_id)
                FROM (
                    SELECT kind, registration_id, revision, runner_id, runtime_epoch, attempt_id
                    FROM outbound_proxy_reference WHERE box_id = b.id
                ) r
            ), '[]'::jsonb)
        ) FROM box b WHERE b.id = :'box_id';
    '''
    return await query_box_json(lab.postgres_service, box_id, query)


async def runner_receipt(lab, box_id, epoch, *, bootstrap_key=None):
    base = f"{lab.runner_origin}/v1/boxes/{box_id}/network/outbound"
    if bootstrap_key is None:
        url = f"{base}/managed-route"
        body = {"runner_id": lab.runner_id, "epoch": epoch, "command": {"operation": "inspect"}}
    else:
        url = f"{base}/bootstrap/receipt"
        body = bootstrap_key
    reply = await http(url, "POST", lab.runner_headers(), json.dumps(body).encode())
    require(reply.status == 200, f"authenticated Runner evidence returned HTTP {reply.status}")
    envelope = json.loads(reply.body)
    require(isinstance(envelope, dict), "Runner receipt is not a JSON object")
    receipt = envelope.get("receipt")
    require(envelope.get("box_id") == box_id and isinstance(receipt, dict) and receipt.get("epoch") == epoch,
            "Runner receipt identity differs from the requested Box and epoch")
    require(receipt.get("runner_id") == lab.runner_id if bootstrap_key is None else receipt.get("key") == bootstrap_key,
            "Runner receipt does not authenticate the selected operation")
    return receipt
