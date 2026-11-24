"""Exercise registered proxy routes through the Cloud SDK, Runner and Guest."""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import replace
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.parse import urlsplit
from uuid import uuid4

import boxlite
from boxlite.errors import ManagedCreateError
import pytest

from conftest import bound_box_lifetime, collect_stream, drain, e2e_box_name, wait_until_unlisted
from e2e_auth import api_key_permissions, discover_path_prefix, load_profile
from managed_outbound import (
    ManagedOutboundLab, checked_url, observation_rows, public_proxy_diagnostics, read_credential,
    read_workload_secret, require_bridge_message, require_redacted, verify_guest_inspection,
)
from managed_outbound_deployment import controlled_run, load_deployment
from preview import http, require


pytestmark = [pytest.mark.e2e, pytest.mark.managed_outbound]

ROTATION_CONFIRM_SECONDS = 120
HELD_TCP_PROBE_SECONDS = 270
GATEWAY_DNS_IPV4 = "192.168.127.1"

GUEST_HTTPS = '''
import http.client
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
connection = http.client.HTTPSConnection(url.hostname, url.port, timeout=35)

def probe(path, keep_alive=False):
    headers = {'Connection': 'keep-alive'} if keep_alive else {}
    connection.request('GET', path, headers=headers)
    response = connection.getresponse()
    if response.status != 200:
        raise SystemExit(1)
    print(response.read(33).decode('ascii'), flush=True)

try:
    probe(url.path, keep_alive=len(sys.argv) == 3)
    if len(sys.argv) == 3:
        original = connection.sock
        if original is None or sys.stdin.readline() != 'continue\\n':
            raise SystemExit(1)
        if connection.sock is not original:
            raise SystemExit(1)
        probe('/probe/' + sys.argv[2])
finally:
    connection.close()
'''

GUEST_UDP = '''
import errno
import socket
import sys

address, port, *markers = sys.argv[1:]
unreachable = (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES, errno.EPERM)

def exchange(probe, text):
    marker = text.encode('ascii')
    try:
        probe.sendall(marker)
        if probe.recv(33) != marker:
            raise ValueError('unexpected UDP echo')
    except TimeoutError:
        print('no-echo', flush=True)
    except OSError as exc:
        if exc.errno not in unreachable:
            raise
        print('no-echo', flush=True)
    else:
        print('echo', flush=True)

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
    probe.settimeout(3)
    try:
        probe.connect((address, int(port)))
    except OSError as exc:
        if exc.errno not in unreachable:
            raise
        print('no-echo', flush=True)
    else:
        exchange(probe, markers[0])
        if len(markers) == 2:
            if sys.stdin.readline() != 'continue\\n':
                raise SystemExit(1)
            exchange(probe, markers[1])
'''

GUEST_UDP_UNBIND = '''
import errno
import json
import socket
import sys

address, port, unlisted, unlisted_port, held, late, fresh, blocked = sys.argv[1:]
permitted = (address, int(port))

def expect_echo(probe, body, marker):
    probe.sendall(body.encode('ascii'))
    if probe.recv(33) != marker.encode('ascii'):
        raise RuntimeError('missing exact UDP echo')

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as old:
    old.settimeout(3)
    old.connect(permitted)
    expect_echo(old, f'hold:{held}:{late}', held)
    print(json.dumps({'held': held, 'guest_port': old.getsockname()[1]}), flush=True)
    if sys.stdin.readline() != 'check-unbound\\n':
        raise SystemExit(1)
    try:
        old.recv(33)
    except TimeoutError:
        pass
    else:
        raise RuntimeError('old Guest socket received a datagram after unbind')

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as current:
        current.settimeout(3)
        current.connect(permitted)
        expect_echo(current, fresh, fresh)
        new_port = current.getsockname()[1]

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as denied:
        denied.settimeout(3)
        try:
            denied.connect((unlisted, int(unlisted_port)))
            denied.sendall(blocked.encode('ascii'))
            denied.recv(33)
        except TimeoutError:
            pass
        except OSError as exc:
            if exc.errno not in (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EACCES, errno.EPERM):
                raise
        else:
            raise RuntimeError('unlisted UDP destination answered after unbind')

    print(json.dumps({'fresh': fresh, 'guest_port': new_port, 'late_delivered': False, 'unlisted_delivered': False}), flush=True)
'''

GUEST_INSPECTION = '''
import base64
import json
import os
from pathlib import Path
import sys

def encode(data):
    return base64.b64encode(data).decode('ascii')

def read_records(paths):
    records = []
    for path in paths:
        try:
            if path.is_file():
                with path.open('rb') as stream:
                    data = stream.read(65537)
                if len(data) > 65536:
                    raise SystemExit('Guest inspection record exceeds its size limit')
                if data:
                    records.append(encode(data))
        except (FileNotFoundError, PermissionError):
            continue
    return records

files = [Path('/etc/hosts'), Path('/etc/environment')]
process = [Path('/proc') / pid / name for pid in ('self', '1') for name in ('environ', 'cmdline')]
print(json.dumps({
    'environment': [encode(k + b'=' + v) for k, v in os.environb.items()],
    'files': read_records(files),
    'process': read_records(process),
    'complete': sys.argv[1],
}))
'''

GUEST_BUSINESS_DNS = '''
import http.client
import json
import socket
import ssl
import sys
import time

address, port, name, marker, timeout = sys.argv[1:]
authority = name if port == '443' else f'{name}:{port}'
started = time.monotonic()
received = None
try:
    with socket.create_connection((address, int(port)), timeout=float(timeout)) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=name) as tunnel:
            tunnel.sendall(f'GET /probe/{marker} HTTP/1.1\\r\\nHost: {authority}\\r\\nConnection: close\\r\\n\\r\\n'.encode())
            response = http.client.HTTPResponse(tunnel)
            response.begin()
            if response.status != 200:
                raise ValueError('unexpected HTTPS status')
            received = response.read(33).decode('ascii')
except (ConnectionError, TimeoutError, ssl.SSLEOFError, http.client.RemoteDisconnected):
    pass
print(json.dumps({'marker': received, 'elapsed': time.monotonic() - started}))
'''


@pytest.fixture(scope="session")
async def managed_lab(pytestconfig):
    lab = ManagedOutboundLab.load(pytestconfig.getoption("--managed-outbound-config"))
    await lab.preflight()
    return lab


@pytest.fixture(scope="session")
async def deployment_runners(pytestconfig, managed_lab):
    config = json.loads(Path(pytestconfig.getoption("--managed-outbound-config")).read_text())
    executable, replacement = load_deployment(config.get("deployment"), managed_lab)
    await replacement.preflight()
    return executable, replacement


@pytest.fixture
def isolated_org(managed_lab, e2e_auth):
    require(e2e_auth.url.rstrip("/") == managed_lab.api_origin
            and e2e_auth.path_prefix == managed_lab.organization_prefix and e2e_auth.auth == "api-key",
            "SDK identity does not target the isolated Cloud acceptance organization")
    return e2e_auth


async def register_proxy(ctx, registry, name, variant):
    checked_url(ctx.url, "https", path_allowed=False)
    require(ctx.auth == "api-key", "managed proxy acceptance requires the isolated organization's API key")
    cli = os.environ.get("BOXLITE_E2E_CLI") or shutil.which("boxlite")
    require(cli is not None, "managed proxy acceptance requires the deployed BoxLite CLI")
    args = [cli, "--url", ctx.url, "--path-prefix", ctx.path_prefix,
            "outbound-proxy", "create", name, variant.endpoint]
    payload, credential = None, {}
    if variant.credential_file is not None:
        payload, credential = read_credential(variant.credential_file)
        args.append("--credential-stdin")
    result = await asyncio.to_thread(
        subprocess.run, args, input=payload, capture_output=True, timeout=30,
        env={**os.environ, "BOXLITE_API_KEY": ctx.token},
    )
    require(not any(value.encode() in stream for value in credential.values()
                    for stream in (result.stdout, result.stderr)), "CLI output disclosed a proxy credential")
    require(result.returncode == 0, f"CLI proxy registration failed with exit {result.returncode}")
    registration = await registry.get(name)
    require(registration.keys() == {"name", "url", "revision", "credential_configured"}
            and registration["name"] == name and registration["url"].rstrip("/") == variant.endpoint
            and registration["credential_configured"] is (payload is not None),
            "registry readback did not match the redacted registration")
    return {"name": name, "revision": registration["revision"]}


async def remove_registration(registry, name):
    if any(entry["name"] == name for entry in await registry.list()):
        result = await registry.remove(name)
        require(result.get("state") == "accepted", f"proxy registration {name} remains after cleanup")


async def cleanup_box(rt, name):
    # Exact-name lookup also covers a create whose reply was lost.
    ids = [info.id for info in await rt.list_info() if info.name == name]
    for box_id in ids:
        await rt.remove(box_id, force=True)
    remaining = await wait_until_unlisted(rt, ids) if ids else []
    require(not remaining, f"managed acceptance Box {name} remains after cleanup")


async def managed_box(cleanup, rt, image, proxy, *, secrets=None, network=None, name=None):
    name = name or e2e_box_name()
    options = boxlite.BoxOptions(image=image, secrets=secrets, network=network)
    bound_box_lifetime(options)
    cleanup.push_async_callback(cleanup_box, rt, name)
    return await rt.create_with_outbound_proxy(options, proxy, name)


async def observe_request(box, lab, client, proxy=None, *, authorization=None, secret_matches=None, secrets=()):
    marker = uuid4().hex
    url = f"{lab.target_origin}/probe/{marker}"
    since = time.time_ns()
    async with asyncio.timeout(45):
        if client == "curl":
            command = ["-q", "--noproxy", "*", "--max-time", "35", "--fail", "--silent"]
            if authorization is not None:
                command.extend(["--header", f"Authorization: {authorization}"])
            execution = await box.exec("curl", [*command, url])
        else:
            execution = await box.exec("python3", ["-c", GUEST_HTTPS, url])
        output, stderr = await drain(execution)
        require_redacted(output, stderr, secrets)
        require((await execution.wait()).exit_code == 0 and output.strip() == marker,
                f"{client} did not receive the controlled HTTPS marker")
    source = lab.direct_source if proxy is None else proxy.source
    lab.observe(marker, source, since, time.time_ns(), proxy, secret_matches=secret_matches)


@asynccontextmanager
async def retain_https_connection(box, lab, proxy):
    first, second = uuid4().hex, uuid4().hex
    since = time.time_ns()
    async with asyncio.timeout(HELD_TCP_PROBE_SECONDS):
        execution = await box.exec("python3", ["-c", GUEST_HTTPS, f"{lab.target_origin}/probe/{first}", second],
                                   timeout_secs=HELD_TCP_PROBE_SECONDS)
        output = asyncio.create_task(drain(execution))
        try:
            async with asyncio.timeout(45):
                while not lab.observations(first):
                    require(not output.done(), "Guest closed the held TCP probe before the target observed it")
                    await asyncio.sleep(0.2)
            initial = lab.observe(first, proxy.source, since, time.time_ns(), proxy)
            yield

            since = time.time_ns()
            await execution.stdin().send_input(b"continue\n")
            stdout, _ = await output
            require((await execution.wait()).exit_code == 0 and stdout.splitlines() == [first, second],
                    "the held Guest connection did not receive both target markers")
            resumed = lab.observe(second, proxy.source, since, time.time_ns())
            connection_id = initial.get("connection_id")
            require(connection_id and resumed.get("connection_id") == connection_id,
                    "the post-rotation request did not reuse the original target connection")
        finally:
            output.cancel()
            await asyncio.gather(output, return_exceptions=True)


async def udp_probe(box, lab, expected):
    marker = uuid4().hex
    async with asyncio.timeout(10):
        execution = await box.exec("python3", ["-c", GUEST_UDP, lab.target_udp_ip, str(lab.target_udp_port), marker])
        output, _ = await drain(execution)
        require((await execution.wait()).exit_code == 0 and output.strip() == expected,
                f"Guest UDP probe did not complete with {expected}")
    return marker


async def wait_for_confirmed_proxy(box, expected_proxy):
    while True:
        status = await box.network.managed_proxy_status()
        installed = status.get("installed") or {}
        if installed.get("proxy") == expected_proxy and status.get("application_state") == "confirmed":
            return
        await asyncio.sleep(0.5)


async def require_bracketed_capture(capture, before, fault, after):
    packets = await capture.packets(before[0], after[1])
    require(all(any(start <= packet <= end for packet in packets) for start, end in (before, after)),
            "packet capture missed a positive control")
    require(not any(fault[0] <= packet <= fault[1] for packet in packets),
            "the controlled destination received traffic during the blocked probe")


def require_udp_ingress(lab, marker):
    events = lab.observations(marker)
    require(len(events) == 1 and events[0].get("protocol") == "udp"
            and events[0].get("source") == lab.direct_source,
            "UDP collector did not observe the expected unbound probe")


@pytest.mark.parametrize("variant_name", [
    "http-anonymous", "http-credential", "https-anonymous", "https-credential", "socks5-anonymous", "socks5-credential",
])
async def test_managed_proxy_uses_registered_source(managed_lab, rt, image, isolated_org, variant_name):
    lab = managed_lab
    variant = lab.variants[variant_name]
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(isolated_org, registry, name, variant)
        control = await managed_box(cleanup, rt, image, None)
        bound = await managed_box(cleanup, rt, image, name)
        for client in ("curl", "python"):
            for box, proxy, listener in ((control, None, None), (bound, expected, variant)):
                before = await lab.readback(box, proxy)
                await observe_request(box, lab, client, listener)
                require(await lab.readback(box, proxy) == before,
                        "Runner epoch or policy revision changed during the observed request")

        result = await registry.remove(name)
        require(result.get("state") == "rejected" and result.get("http_status") == 409,
                "a referenced proxy registration must reject deletion")
        epoch, previous = await lab.readback(bound, expected)
        release = await bound.network.set_managed_proxy(None)
        require(release.get("state") == "accepted", "managed proxy unbind did not confirm release")
        after = await lab.readback(bound, None)
        require(after[0] == epoch and after[1] != previous and after[1] == release.get("revision"),
                "unbind must install its acknowledged revision in the same Runner epoch")
        await observe_request(bound, lab, "curl")
        require(await lab.readback(bound, None) == after, "unbind changed during the observed request")


async def test_managed_proxy_rotation_converges_both_boxes(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    first = lab.variants["https-credential"]
    second = next(variant for variant in lab.variants.values() if variant.source != first.source)
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        before_proxy = await register_proxy(isolated_org, registry, name, first)
        boxes = [await managed_box(cleanup, rt, image, name) for _ in range(2)]
        before = {}
        for box in boxes:
            before[box.id] = await lab.readback(box, before_proxy)
            await observe_request(box, lab, "curl", first)
            require(await lab.readback(box, before_proxy) == before[box.id],
                    "initial policy changed during observation")

        after_proxy = {"name": name, "revision": before_proxy["revision"] + 1}
        installed_routes = {}
        async with retain_https_connection(boxes[0], lab, first):
            require(await lab.readback(boxes[0], before_proxy) == before[boxes[0].id],
                    "installed route changed before rotation")
            if second.credential_file is None:
                updated = await registry.update(name, url=second.endpoint, clear_credential=True)
            else:
                _, credential = read_credential(second.credential_file)
                updated = await registry.update(name, url=second.endpoint,
                                                credential=boxlite.ProxyCredential(**credential))
            require(updated.get("state") == "accepted", "registry rotation was not accepted")
            require((await registry.get(name)).get("revision") == after_proxy["revision"],
                    "registry rotation did not create exactly one revision")

            # One registry update starts convergence on both Boxes.
            async with asyncio.timeout(ROTATION_CONFIRM_SECONDS), asyncio.TaskGroup() as confirmations:
                for box in boxes:
                    confirmations.create_task(wait_for_confirmed_proxy(box, after_proxy))
            for box in boxes:
                after = await lab.readback(box, after_proxy)
                require(after[0] == before[box.id][0] and after[1] != before[box.id][1],
                        "registry rotation must install a new policy revision in the original Runner epoch")
                installed_routes[box.id] = after
        require(await lab.readback(boxes[0], after_proxy) == installed_routes[boxes[0].id],
                "rotated policy changed during the held TCP request")

        ctx = isolated_org
        for box in boxes:
            after = installed_routes[box.id]
            reply = await http(ctx.url_for(ctx.v1(f"boxes/{box.id}/network/outbound")), "PUT",
                               {**ctx.auth_headers(content_type=True), "If-Match": f'"{before[box.id][1]}"'},
                               json.dumps({"mode": "enabled", "allow_net": [], "proxy": None}).encode())
            require(reply.status == 412, f"stale settled revision returned HTTP {reply.status}, expected 412")
            require(await lab.readback(box, after_proxy) == after, "stale policy write changed the installed revision")
            await observe_request(box, lab, "curl", second)
            require(await lab.readback(box, after_proxy) == after, "rotated policy changed during observation")


async def test_managed_proxy_drops_external_udp(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(isolated_org, registry, name, lab.variants["https-credential"])
        control = await managed_box(cleanup, rt, image, None)
        bound = await managed_box(cleanup, rt, image, name)
        control_state = await lab.readback(control, None)
        bound_state = await lab.readback(bound, expected)

        first = await udp_probe(control, lab, "echo")
        blocked = await udp_probe(bound, lab, "no-echo")
        last = await udp_probe(control, lab, "echo")

        for marker in (first, last):
            require_udp_ingress(lab, marker)
        require(await lab.readback(control, None) == control_state, "UDP control changed during observation")
        require(await lab.readback(bound, expected) == bound_state, "bound UDP policy changed during observation")
        require(not lab.observations(blocked), "UDP from the bound Box arrived at the owned destination")


async def test_managed_proxy_blocks_udp_sent_on_an_existing_socket_after_binding(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(isolated_org, registry, name, lab.variants["https-credential"])
        control = await managed_box(cleanup, rt, image, None)
        switching = await managed_box(cleanup, rt, image, None)
        control_state = await lab.readback(control, None)
        before = await lab.readback(switching, None)
        require_udp_ingress(lab, await udp_probe(control, lab, "echo"))

        run_marker = uuid4().hex[:30]
        first, blocked = f"{run_marker}01", f"{run_marker}02"
        async with asyncio.timeout(85):
            execution = await switching.exec("python3", ["-c", GUEST_UDP, lab.target_udp_ip,
                                             str(lab.target_udp_port), first, blocked], timeout_secs=85)
            output = asyncio.create_task(drain(execution))
            try:
                async with asyncio.timeout(10):
                    while not lab.observations(first):
                        require(not output.done(), "Guest exited before its initial UDP datagram reached the target")
                        await asyncio.sleep(0.2)
                require_udp_ingress(lab, first)
                require(await lab.readback(switching, None) == before, "UDP control revision changed before binding")
                result = await switching.network.set_managed_proxy(name)
                require(result.get("state") == "accepted", "UDP cutover binding was not confirmed")
                after = await lab.readback(switching, expected)
                require(after[0] == before[0] and after[1] != before[1] and after[1] == result.get("revision"),
                        "UDP cutover did not install the acknowledged revision in the same epoch")
                await execution.stdin().send_input(b"continue\n")
                stdout, _ = await output
                require((await execution.wait()).exit_code == 0 and stdout.splitlines() == ["echo", "no-echo"],
                        "the same Guest UDP socket did not echo before binding and fail after confirmation")
                require(await lab.readback(switching, expected) == after, "UDP cutover revision changed during probe")
            finally:
                output.cancel()
                await asyncio.gather(output, return_exceptions=True)

        require_udp_ingress(lab, await udp_probe(control, lab, "echo"))
        require(not lab.observations(blocked), "post-acknowledgement UDP reached the target")
        require(await lab.readback(control, None) == control_state, "unbound UDP control changed during cutover")


async def guest_json_lines(stream):
    buffer = ""
    async for chunk in stream:
        buffer += chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            yield json.loads(line)
    require(not buffer, "Guest probe left an incomplete event")


async def udp_echo_window(box, lab):
    start = time.time_ns()
    marker = await udp_probe(box, lab, "echo")
    end = time.time_ns()
    require_udp_ingress(lab, marker)
    return start, end


async def test_managed_proxy_unbind_discards_delayed_udp_and_preserves_allowlist(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    fixture = lab.udp_unbind
    require(fixture is not None, "configure both UDP targets, the delayed reply trigger, and the unlisted capture")
    unlisted = replace(lab, target_udp_ip=fixture.unlisted_address, target_udp_port=fixture.unlisted_port,
                       target_log=fixture.unlisted_log)
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    policy = {"mode": "enabled", "allow_net": [f"{lab.target_udp_ip}/32"]}
    network = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(**policy))
    ctx = isolated_org
    held, late, fresh, blocked = (uuid4().hex for _ in range(4))
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(ctx, registry, name, lab.variants["https-credential"])
        control = await managed_box(cleanup, rt, image, None)
        switching = await managed_box(cleanup, rt, image, None, network=network)
        control_state = await lab.readback(control, None)
        initial = await lab.readback(switching, None)
        policy_url = ctx.url_for(ctx.v1(f"boxes/{switching.id}/network/outbound"))
        original_policy = await http(policy_url, headers=ctx.auth_headers())
        require(original_policy.status == 200 and json.loads(original_policy.body) == policy
                and original_policy.headers.get("etag") == f'"{initial[1]}"', "initial Box omitted its installed UDP allowlist")
        before = await udp_echo_window(control, unlisted)

        async with asyncio.timeout(120):
            args = [lab.target_udp_ip, str(lab.target_udp_port), fixture.unlisted_address, str(fixture.unlisted_port),
                    held, late, fresh, blocked]
            execution = await switching.exec("python3", ["-c", GUEST_UDP_UNBIND, *args], timeout_secs=120)
            events = guest_json_lines(execution.stdout())
            stderr = asyncio.create_task(collect_stream(execution.stderr()))
            try:
                first = await anext(events)
                old = lab.observations(held)
                require(first.get("held") == held and type(first.get("guest_port")) is int
                        and len(old) == 1 and old[0].get("protocol") == "udp-held"
                        and old[0].get("source") == lab.direct_source,
                        "the initial UDP flow lacked an exact Guest echo and held target peer")
                require(await lab.readback(switching, None) == initial, "initial UDP route changed before binding")
                binding = await switching.network.set_managed_proxy(name)
                require(binding.get("state") == "accepted", "managed bind did not confirm the UDP cutover")
                # The bridge uses forwarder.UDPConnTrackTimeout for its old flow.
                require(time.time_ns() - old[0]["time_ns"] < 90_000_000_000,
                        "the old UDP flow could have expired before the bind was acknowledged")
                bound = await lab.readback(switching, expected)
                require(bound[0] == initial[0] and bound[1] != initial[1] and bound[1] == binding.get("revision"),
                        "managed bind did not install the acknowledged revision in the original epoch")
                result = await switching.network.set_managed_proxy(None)
                require(result.get("state") == "accepted", "managed unbind did not confirm the UDP cutover")
                released = await lab.readback(switching, None)
                require(released[0] == bound[0] and released[1] != bound[1] and released[1] == result.get("revision"),
                        "managed unbind did not install the acknowledged revision in the original epoch")
                snapshot = await http(policy_url, headers=ctx.auth_headers())
                require(snapshot.status == 200 and json.loads(snapshot.body) == policy
                        and snapshot.headers.get("etag") == f'"{released[1]}"', "unbind changed the installed UDP allowlist")
                require(not lab.observations(late), "fixture released the delayed reply before confirmed unbind")

                trigger = fixture.release_dir / held
                started = time.time_ns()
                os.close(os.open(trigger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
                cleanup.callback(trigger.unlink, missing_ok=True)
                async with asyncio.timeout(12):
                    while not (delayed := lab.observations(late)):
                        await asyncio.sleep(0.2)
                require(len(delayed) == 1 and delayed[0].get("protocol") == "udp-delayed-reply"
                        and delayed[0].get("source") == old[0]["source"]
                        and type(old[0].get("source_port")) is int and delayed[0].get("source_port") == old[0]["source_port"]
                        and started <= delayed[0]["time_ns"] <= time.time_ns(),
                        "delayed reply was not sent to the observed old peer after unbind")

                await execution.stdin().send_input(b"check-unbound\n")
                final = await anext(events)
                require(await anext(events, None) is None and (await execution.wait()).exit_code == 0,
                        "UDP cutover probe did not finish cleanly")
                require(final.get("fresh") == fresh and type(final.get("guest_port")) is int
                        and final["guest_port"] != first["guest_port"] and final.get("late_delivered") is False
                        and final.get("unlisted_delivered") is False, "Guest did not confirm the old and fresh UDP boundaries")
                completed = time.time_ns()
                require_udp_ingress(lab, fresh)
                require(lab.observations(fresh)[0]["time_ns"] >= delayed[0]["time_ns"],
                        "fresh UDP flow opened before the late reply was attempted")
            finally:
                await events.aclose()
                stderr.cancel()
                await asyncio.gather(stderr, return_exceptions=True)

        after = await udp_echo_window(control, unlisted)
        await require_bracketed_capture(fixture.unlisted_capture, before, (started, completed), after)
        require(not unlisted.observations(blocked), "unlisted UDP reached its destination after unbind")
        require(await lab.readback(switching, None) == released, "UDP probes changed the unbound policy")
        require(await lab.readback(control, None) == control_state, "UDP control path changed during unbind")


def named_dns_rows(path, name):
    return [row for row in observation_rows(path) if row.get("name") == name]


def dns_fixture_source():
    return (Path(__file__).parents[1] / "fixtures" / "managed_outbound_dns.py").read_text()


async def execute_network_probe(box, source, args, *, timeout=20):
    async with asyncio.timeout(timeout):
        execution = await box.exec("python3", ["-c", source, *args])
        output, _ = await drain(execution)
        require((await execution.wait()).exit_code == 0, "Guest probe failed before returning its observation")
        return json.loads(output)


async def direct_dns_control(box, dns, source, transport, expected_address):
    name = f"answer-{uuid4().hex}.{dns.zone}"
    since = time.time_ns()
    result = await execute_network_probe(box, source, ["probe", transport, GATEWAY_DNS_IPV4, "53", name, "A"])
    require(result["rcode"] == 0 and result["answers"] == [expected_address], "direct DNS control could not resolve its name")
    require(any(row.get("source") == dns.runner_source and row.get("type") == "A"
                and row.get("outcome") == "answer" and since <= row["time_ns"] <= time.time_ns()
                for row in named_dns_rows(dns.runner_log, name)), "Runner observer missed the direct DNS control")
    require(not named_dns_rows(dns.doh_log, name), "unbound DNS control used the pinned DoH listener")


async def observe_managed_dns(box, lab, source, entry, outcome, proxy):
    dns = lab.dns
    endpoint = urlsplit(dns.origin)
    expected_outcome = "answer" if outcome == "proxy-stall" else outcome
    name = f"{expected_outcome}-{uuid4().hex}.{dns.zone}"
    marker = uuid4().hex
    types = ["A", "AAAA"] if entry == "business" and outcome == "answer" else ["AAAA"] if entry == "tcp" else ["A"]
    started = time.time_ns()
    if entry == "business":
        result = await execute_network_probe(box, GUEST_BUSINESS_DNS, [dns.guest_business_ip, "443", name, marker, "8"])
    else:
        result = await execute_network_probe(box, source, ["probe", entry, GATEWAY_DNS_IPV4, "53", name, types[0]])
    completed = time.time_ns()

    rows = named_dns_rows(dns.doh_log, name)
    if outcome == "proxy-stall":
        require(not rows, "the stalled CONNECT reached the DoH listener")
        lab.observe_connect(proxy, endpoint.port or 443, started, completed, completed,
                            address=dns.address, outcome="negotiation_stalled")
    else:
        require(sorted(row.get("type", "") for row in rows) == types,
                "the pinned DoH listener missed the exact DNS questions")
        require(all(row.get("transport") == "doh" and row.get("outcome") == expected_outcome
                    and row.get("source") == proxy.source and row.get("sni") == endpoint.hostname
                    and row.get("host") == endpoint.netloc and started <= row["time_ns"] <= completed
                    for row in rows), "DoH source, TLS identity or fault did not match the bound probe")
        lab.observe_connect(proxy, endpoint.port or 443, started, max(row["time_ns"] for row in rows), completed,
                            address=dns.address, count=len(types))
    require(not named_dns_rows(dns.runner_log, name), "the Runner resolved the bound workload name directly")

    if entry == "business":
        lab.observe_connect(None, 443, started, completed, completed, address=dns.guest_business_ip)
        if outcome == "answer":
            require(result["marker"] == marker, "inspected HTTPS did not resolve the marked target through DoH")
            lab.observe(marker, proxy.source, started, completed, proxy, hostname=name)
        else:
            require(result["marker"] is None and not lab.observations(marker), "business request succeeded despite the DNS fault")
            lab.observe_connect(None, 443, started, completed, completed)
    elif outcome == "answer":
        address = dns.answer_ipv6 if entry == "tcp" else lab.target_tcp_ip
        require(result["rcode"] == 0 and result["answers"] == [address], "Guest gateway did not return the marked DNS answer")
    else:
        require(result["rcode"] == 2 and not result["answers"], "Guest gateway must return SERVFAIL with no answer")
    return result["elapsed"], name


@pytest.mark.parametrize(("outcome", "seeded"), [
    ("answer", False),
    *[(fault, seeded) for fault in ("wrong-id", "stall", "proxy-stall") for seeded in (False, True)],
])
async def test_managed_proxy_dns_paths(managed_lab, rt, image, isolated_org, outcome, seeded):
    lab = managed_lab
    dns = lab.dns
    require(dns is not None, "configure the pinned DoH and Runner DNS observation settings")
    require(urlsplit(lab.target_origin).port in (None, 443)
            and (dns.address, urlsplit(dns.origin).port or 443) != (lab.target_tcp_ip, 443),
            "the inspected business and DoH probes need separate destination tuples and HTTPS business port 443")
    require(dns.guest_business_ip not in {dns.address, lab.target_tcp_ip},
            "use a separate owned Guest TCP destination to prove the inspected hostname selects the target")
    source = dns_fixture_source()
    proxy = lab.variants["https-anonymous"]
    rules = [f"*.{dns.zone}"]
    if seeded:
        rules.append(f"{dns.address}/32")
    network = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=rules))
    registry = rt.outbound_proxies()
    async with AsyncExitStack() as cleanup:
        name = e2e_box_name()
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, name, proxy)
        control = await managed_box(cleanup, rt, image, None)
        bound = await managed_box(cleanup, rt, image, name, network=network)
        control_state = await lab.readback(control, None)
        before = await lab.readback(bound, binding)
        probe_box, probe_proxy, probe_binding, probe_state = bound, proxy, binding, before
        if outcome == "proxy-stall":
            name = e2e_box_name()
            probe_proxy = dns.stalled_proxy
            cleanup.push_async_callback(remove_registration, registry, name)
            probe_binding = await register_proxy(isolated_org, registry, name, probe_proxy)
            probe_box = await managed_box(cleanup, rt, image, name, network=network)
            probe_state = await lab.readback(probe_box, probe_binding)

        expected_diagnostics = set()
        require(not await outbound_diagnostics(isolated_org, probe_box), "fresh DNS probe has a TCP diagnostic")
        if seeded:
            # Both dedicated listeners refuse destinations outside their configured tuple list.
            seed_port = 2 if urlsplit(dns.origin).port == 1 else 1
            result = await execute_network_probe(
                probe_box, GUEST_BUSINESS_DNS,
                [dns.address, str(seed_port), urlsplit(dns.origin).hostname, uuid4().hex, "10"],
            )
            require(result["marker"] is None, "diagnostic seed unexpectedly reached the DoH host")
            expected_diagnostics = {"proxy_handshake_failed"}
            require(await outbound_diagnostics(isolated_org, probe_box) == expected_diagnostics,
                    "same-installation TCP seed did not report the expected diagnostic")

        for entry in ("udp", "tcp", "business"):
            transport = "tcp" if entry == "tcp" else "udp"
            await direct_dns_control(control, dns, source, transport, lab.target_tcp_ip)
            started = time.time_ns()
            initial, healthy_name = await observe_managed_dns(bound, lab, source, entry, "answer", proxy)
            names = [healthy_name]
            if outcome != "answer":
                require(await outbound_diagnostics(isolated_org, probe_box) == expected_diagnostics,
                        "TCP diagnostic differs before the DNS-only fault")
                elapsed, fault_name = await observe_managed_dns(probe_box, lab, source, entry, outcome, probe_proxy)
                require(await outbound_diagnostics(isolated_org, probe_box) == expected_diagnostics,
                        "DNS-only fault changed the TCP diagnostic")
                final, recovered_name = await observe_managed_dns(bound, lab, source, entry, "answer", proxy)
                names.extend((fault_name, recovered_name))
                overhead = min(2.0, max(initial, final) + 0.25)
                require(elapsed <= 5 + overhead, f"{entry} DNS fault exceeded its lookup budget")
                if outcome in ("stall", "proxy-stall"):
                    require(elapsed >= 4.75, f"{entry} DNS stall ended before exercising the lookup deadline")
            completed = time.time_ns()
            for listener in {proxy, probe_proxy}:
                bootstrap = urlsplit(listener.endpoint).hostname
                require(any(row.get("source") == dns.runner_source and row.get("type") == "A"
                            and started <= row["time_ns"] <= completed
                            for row in named_dns_rows(dns.runner_log, bootstrap)),
                        "Runner observer missed uncached proxy bootstrap DNS in the probe window")
            await direct_dns_control(control, dns, source, transport, lab.target_tcp_ip)
            require(all(not named_dns_rows(dns.runner_log, name) for name in names),
                    "Runner DNS observer saw a bound name before its closing control")
            if outcome == "proxy-stall":
                require(not named_dns_rows(dns.doh_log, fault_name), "DoH observer received a late query after the proxy stall")
            require(await lab.readback(control, None) == control_state, "unbound DNS control changed during observation")
            require(await lab.readback(bound, binding) == before, "healthy DNS binding changed during observation")
            require(await lab.readback(probe_box, probe_binding) == probe_state, "DNS probe changed the confirmed binding")


def quic_probe_command(origin, address, marker):
    target = urlsplit(origin)
    return ["-q", "--http3-only", "--noproxy", "*", "--fail", "--silent", "--max-time", "8",
            "--resolve", f"{target.hostname}:{target.port or 443}:{address}",
            "--write-out", r"\n%{http_version}\n%{response_code}", f"{origin}/probe/{marker}"]


async def external_udp_probe(box, lab, protocol, *, blocked):
    observations = lab.external_udp
    marker = uuid4().hex
    started = time.time_ns()
    if protocol == "dns":
        marker = f"answer-{marker}.{lab.dns.zone}"
        args = ["probe", "udp", observations.dns_address, str(observations.dns_port), marker, "A"]
        if blocked:
            args.append("--accept-blocked")
        result = await execute_network_probe(box, dns_fixture_source(), args)
        if blocked:
            require(result.get("blocked") is True, "bound Guest received a direct external DNS reply")
        else:
            require(result["rcode"] == 0 and result["answers"] == [lab.target_tcp_ip],
                    "the direct external DNS control did not return its owned answer")
    else:
        async with asyncio.timeout(20):
            command = quic_probe_command(observations.quic_origin, observations.quic_address, marker)
            execution = await box.exec("curl", command)
            output, _ = await drain(execution)
            code = (await execution.wait()).exit_code
        parts = output.rsplit("\n", 2)
        require(len(parts) == 3, f"HTTP/3 curl did not produce its transfer evidence, exit {code}")
        body, version, status = parts
        if blocked:
            require(code in (7, 28, 95) and not body and version in ("", "0") and status == "000",
                    "bound Guest did not report a QUIC connection failure")
        else:
            require(code == 0 and version == "3" and status == "200" and body == f"/probe/{marker}",
                    "the unbound control did not get its marker over HTTP/3")
    return started, time.time_ns(), marker


def external_udp_application_rows(observations, protocol, marker):
    if protocol == "dns":
        return named_dns_rows(observations.dns_log, marker)
    return [row for row in observation_rows(observations.quic_log)
            if row.get("request", {}).get("uri") == f"/probe/{marker}"]


@pytest.mark.parametrize("protocol", ["dns", "quic"])
async def test_managed_proxy_refuses_external_udp_protocol(managed_lab, rt, image, isolated_org, protocol):
    lab = managed_lab
    observations = lab.external_udp
    require(observations is not None, "configure the direct DNS, QUIC and packet observers")
    capture = observations.dns_capture if protocol == "dns" else observations.quic_capture
    name = e2e_box_name()
    registry = rt.outbound_proxies()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(isolated_org, registry, name, lab.variants["https-credential"])
        control = await managed_box(cleanup, rt, image, None)
        bound = await managed_box(cleanup, rt, image, name)
        unbound_state = await lab.readback(control, None)
        bound_state = await lab.readback(bound, binding)

        before = await external_udp_probe(control, lab, protocol, blocked=False)
        fault = await external_udp_probe(bound, lab, protocol, blocked=True)
        after = await external_udp_probe(control, lab, protocol, blocked=False)
        await require_bracketed_capture(capture, before[:2], fault[:2], after[:2])
        for check in (before, after):
            events = external_udp_application_rows(observations, protocol, check[2])
            require(len(events) == 1, f"the external {protocol} observer missed its marked control")
            event, = events
            if protocol == "dns":
                require(event.get("source") == lab.direct_source and event.get("transport") == "udp"
                        and event.get("type") == "A" and event.get("outcome") == "answer",
                        "the DNS observer did not record the unbound UDP path")
            else:
                request = event["request"]
                require(request.get("remote_ip") == lab.direct_source and request.get("proto") == "HTTP/3.0"
                        and event.get("status") == 200, "the QUIC observer did not record the unbound HTTP/3 path")
        require(not external_udp_application_rows(observations, protocol, fault[2]),
                f"the bound {protocol} request reached the external application")
        require(await lab.readback(bound, binding) == bound_state, "external UDP probe changed the installed binding")
        require(await lab.readback(control, None) == unbound_state, "external UDP control changed its installed revision")


async def literal_https_probe(box, lab, proxy=None, *, expected_failure=False, address=None):
    target = urlsplit(lab.target_origin)
    marker = uuid4().hex
    started = time.time_ns()
    result = await execute_network_probe(
        box, GUEST_BUSINESS_DNS, [address or lab.target_tcp_ip, str(target.port or 443), target.hostname, marker, "36"],
        timeout=45,
    )
    completed = time.time_ns()
    if expected_failure:
        require(result["marker"] is None and not lab.observations(marker), "faulty proxy reached the controlled target")
    else:
        require(result["marker"] == marker, "healthy literal HTTPS control missed the target marker")
        lab.observe(marker, proxy.source if proxy else lab.direct_source, started, completed, proxy)
    return started, completed, result["elapsed"]


async def calibrate_connect_trace(trace, box, lab):
    closed = lab.tcp_faults.refused
    endpoint = urlsplit(lab.tcp_faults.refused_proxy.endpoint)
    epoch, _ = await lab.readback(box, None)
    await trace.step("start-connect-trace", box_id=box.id, epoch=epoch)
    started = time.time_ns()
    result = await execute_network_probe(box, GUEST_BUSINESS_DNS, [
        endpoint.hostname, str(closed.port), urlsplit(lab.target_origin).hostname, uuid4().hex, "5",
    ])
    completed = time.time_ns()
    attempts = await trace.connect_window(box.id, epoch, endpoint.hostname, closed.port, started, completed)
    require(result["marker"] is None and await closed.packets(started, completed)
            and any(attempt["result"] in {"ECONNREFUSED", "EINPROGRESS"} for attempt in attempts),
            "connect observer missed the unbound closed-port calibration")


async def test_managed_proxy_rejects_legacy_write_and_preserves_allowlist_on_unbind(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    proxy = lab.variants["https-credential"]
    registry = rt.outbound_proxies()
    ctx = isolated_org
    name = e2e_box_name()
    allowlist = [f"{lab.target_tcp_ip}/32"]
    network = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=allowlist))
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        binding = await register_proxy(ctx, registry, name, proxy)
        box = await managed_box(cleanup, rt, image, name, network=network)
        installed = await lab.readback(box, binding)
        policy_url = ctx.url_for(ctx.v1(f"boxes/{box.id}/network/outbound"))
        before = await http(policy_url, headers=ctx.auth_headers())
        require(before.status == 200 and json.loads(before.body) == {"mode": "enabled", "allow_net": allowlist}
                and before.headers.get("etag") == f'"{installed[1]}"', "bound Box omitted its installed allowlist")

        reply = await http(policy_url, "PUT", {**ctx.auth_headers(content_type=True), "If-Match": f'"{installed[1]}"'},
                           json.dumps({"mode": "disabled", "allow_net": []}).encode())
        require(reply.status == 409 and json.loads(reply.body).get("code") == "outbound_update_blocked",
                "policy-only client did not get the expected refusal for a bound Box")
        denied = await http(policy_url, headers=ctx.auth_headers())
        require(denied.status == 200 and json.loads(denied.body) == json.loads(before.body)
                and denied.headers.get("etag") == before.headers["etag"], "denied legacy write changed the public policy")
        require(await lab.readback(box, binding) == installed, "denied legacy write changed the authenticated binding")
        healthy_before = await literal_https_probe(box, lab, proxy)

        captures = lab.tcp_faults
        require(captures is not None, "configure target TCP capture for the disabled binding check")
        target = urlsplit(lab.target_origin)
        port = target.port or 443
        for mode, rules in (("disabled", []), ("enabled", allowlist)):
            replacement = {"mode": mode, "allow_net": rules, "proxy": name}
            reply = await http(
                policy_url, "PUT", {**ctx.auth_headers(content_type=True), "If-Match": f'"{installed[1]}"'},
                json.dumps(replacement).encode(),
            )
            require(reply.status == 200 and json.loads(reply.body) == replacement,
                    f"explicit proxy replacement did not settle {mode} mode")
            previous = installed
            installed = await lab.readback(box, binding)
            require(installed[0] == previous[0] and installed[1] != previous[1],
                    "changing the egress mode did not retain the bound epoch and advance policy")
            if mode == "disabled":
                started = time.time_ns()
                probe = await execute_network_probe(
                    box, GUEST_BUSINESS_DNS, [lab.target_tcp_ip, str(port), target.hostname, uuid4().hex, "5"],
                )
                disabled_window = (started, time.time_ns())
                require(probe["marker"] is None, "disabled binding delivered new business traffic")
                lab.observe_connect(None, port, disabled_window[0], disabled_window[1], disabled_window[1])
        healthy_after = await literal_https_probe(box, lab, proxy)
        await require_bracketed_capture(captures.syn, healthy_before[:2], disabled_window, healthy_after[:2])

        result = await box.network.set_managed_proxy(None)
        require(result.get("state") == "accepted", "SDK did not confirm unbind of the allowlisted Box")
        unbound = await lab.readback(box, None)
        require(unbound[0] == installed[0] and unbound[1] != installed[1] and unbound[1] == result.get("revision"),
                "unbind did not settle the acknowledged revision in the original epoch")
        final = await http(policy_url, headers=ctx.auth_headers())
        require(final.status == 200 and json.loads(final.body) == json.loads(before.body)
                and final.headers.get("etag") == f'"{unbound[1]}"', "SDK unbind changed the public allowlist")
        await literal_https_probe(box, lab)
        require(await lab.readback(box, None) == unbound, "unbound policy changed during observation")


async def require_literal_dial_trace(trace, box, epoch, window, *, observed=(), absent=()):
    started, completed = window[:2]
    for address, port in observed:
        require(await trace.connect_window(box.id, epoch, address, port, started, completed),
                f"healthy control did not dial {address}:{port}")
    for address, port in absent:
        require(not await trace.connect_window(box.id, epoch, address, port, started, completed),
                f"refused probe attempted to dial {address}:{port}")


async def test_managed_proxy_allowlist_refuses_unlisted_literal_before_connect(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    captures = lab.tcp_faults
    require(captures is not None and captures.bridge_log_dir is not None and captures.anonymous_listener_address,
            "configure target capture, the anonymous proxy ingress IPv4, and per-Box shim logs")
    registry = rt.outbound_proxies()
    proxy = lab.variants["https-anonymous"]
    name = e2e_box_name()
    require(lab.target_tcp_ip != "192.0.2.254", "allowlist refusal needs an unlisted owned HTTPS target")
    network = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=["192.0.2.254/32"]))
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(isolated_org, registry, name, proxy)
        permitted = await managed_box(cleanup, rt, image, name)
        restricted = await managed_box(cleanup, rt, image, name, network=network)
        direct = await managed_box(cleanup, rt, image, None)
        control_state = await lab.readback(permitted, expected)
        restricted_state = await lab.readback(restricted, expected)
        trace, _ = await cleanup.enter_async_context(controlled_run(lab, deployment_runners))
        await calibrate_connect_trace(trace, direct, lab)
        await trace.step("start-connect-trace", box_id=permitted.id, epoch=control_state[0])
        await trace.step("start-connect-trace", box_id=restricted.id, epoch=restricted_state[0])

        before = await literal_https_probe(permitted, lab, proxy)
        fault = await literal_https_probe(restricted, lab, expected_failure=True)
        after = await literal_https_probe(permitted, lab, proxy)
        await require_bracketed_capture(captures.syn, before[:2], fault[:2], after[:2])
        port = captures.syn.port
        proxy_peer = (captures.anonymous_listener_address, urlsplit(proxy.endpoint).port or 443)
        for window in (before, after):
            await require_literal_dial_trace(trace, permitted, control_state[0], window, observed=(proxy_peer,))
        await require_literal_dial_trace(trace, restricted, restricted_state[0], fault,
                                         absent=(proxy_peer, (lab.target_tcp_ip, port)))
        lab.observe_connect(None, port, fault[0], fault[1], fault[1])
        await require_bridge_message(
            captures.bridge_log_dir, restricted.id, fault[0], fault[1],
            lambda message: message.startswith("allowNet TCP: blocked (no matching rule) ")
            and {f"dst_ip={lab.target_tcp_ip}", f"dst_port={port}"} <= set(message.split()),
            "Runtime did not record the expected allowlist refusal for the exclusive target tuple",
        )
        require(await lab.readback(permitted, expected) == control_state, "control binding changed during policy refusal")
        require(await lab.readback(restricted, expected) == restricted_state, "blocked request changed the installed binding")


async def test_managed_proxy_refuses_owned_private_literal_before_connect(
    managed_lab, deployment_runners, rt, image, isolated_org,
):
    lab = managed_lab
    private = lab.protected_target
    captures = lab.tcp_faults
    require(private is not None and captures is not None and captures.bridge_log_dir is not None
            and captures.anonymous_listener_address,
            "configure the owned private target, anonymous proxy ingress IPv4, live SYN capture, and Runner shim logs")
    target = replace(lab, target_tcp_ip=private.address, target_origin=private.origin,
                     target_log=private.target_log, direct_source=private.source)
    registry = rt.outbound_proxies()
    proxy = lab.variants["https-anonymous"]
    name = e2e_box_name()
    allowlist = [f"{private.address}/32", f"{lab.target_tcp_ip}/32", f"{captures.refused_proxy.source}/32"]
    network = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=allowlist))
    ctx = isolated_org
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(ctx, registry, name, proxy)
        control = await managed_box(cleanup, rt, image, None, network=network)
        bound = await managed_box(cleanup, rt, image, name, network=network)
        control_state = await lab.readback(control, None)
        bound_state = await lab.readback(bound, expected)
        policy_url = ctx.url_for(ctx.v1(f"boxes/{bound.id}/network/outbound"))
        policy = await http(policy_url, headers=ctx.auth_headers())
        require(policy.status == 200 and json.loads(policy.body) == {"mode": "enabled", "allow_net": allowlist}
                and policy.headers.get("etag") == f'"{bound_state[1]}"', "bound Box did not install the explicit private rule")
        trace, _ = await cleanup.enter_async_context(controlled_run(lab, deployment_runners))
        await calibrate_connect_trace(trace, control, lab)
        await trace.step("start-connect-trace", box_id=bound.id, epoch=bound_state[0])

        first_proxy = await literal_https_probe(bound, lab, proxy)
        before = await literal_https_probe(control, target)
        fault = await literal_https_probe(bound, target, expected_failure=True)
        after = await literal_https_probe(control, target)
        last_proxy = await literal_https_probe(bound, lab, proxy)
        await require_bracketed_capture(private.capture, before[:2], fault[:2], after[:2])
        proxy_peer = (captures.anonymous_listener_address, urlsplit(proxy.endpoint).port or 443)
        target_peer = (private.address, private.capture.port)
        for window in (first_proxy, last_proxy):
            await require_literal_dial_trace(trace, bound, bound_state[0], window, observed=(proxy_peer,))
        for window in (before, after):
            await require_literal_dial_trace(trace, control, control_state[0], window, observed=(target_peer,))
        await require_literal_dial_trace(trace, bound, bound_state[0], fault,
                                         absent=(proxy_peer, target_peer))
        target.observe_connect(None, private.capture.port, fault[0], fault[1], fault[1], address=private.address)
        tls_leaf_in_window(proxy, first_proxy[0], first_proxy[1])
        tls_leaf_in_window(proxy, last_proxy[0], last_proxy[1])
        require(not negotiation_events(proxy, "tls_selection", fault[0], fault[1]),
                "private address refusal was preceded by a TLS connection to the proxy")
        await require_bridge_message(captures.bridge_log_dir, bound.id, fault[0], fault[1],
                                     lambda message: message == "outbound dial = proxy_handshake_failed",
                                     "Runtime did not report an early connector refusal for the private probe")
        require(await lab.readback(control, None) == control_state, "private target control changed its policy")
        require(await lab.readback(bound, expected) == bound_state, "private address probe changed the binding")


async def outbound_diagnostics(ctx, box):
    reply = await http(ctx.url_for(ctx.v1(f"boxes/{box.id}/network/outbound/status")), headers=ctx.auth_headers())
    require(reply.status == 200, f"public outbound status returned HTTP {reply.status} after the probe")
    return public_proxy_diagnostics(json.loads(reply.body))


def negotiation_events(proxy, event, start, end):
    return [row for row in observation_rows(proxy.observations)
            if row.get("event") == event and start <= row["time_ns"] <= end]


def tls_leaf_in_window(proxy, start, end):
    rows = negotiation_events(proxy, "tls_selection", start, end)
    require(len(rows) == 1 and rows[0].get("sni") == urlsplit(proxy.endpoint).hostname,
            "proxy TLS observer did not isolate the expected ClientHello SNI")
    fingerprint = rows[0].get("certificate_sha256")
    require(isinstance(fingerprint, str) and len(fingerprint) == 64, "TLS selection lacks the certificate fingerprint")
    return fingerprint


@pytest.mark.parametrize(("fault", "diagnostic"), [
    ("auth", "proxy_auth_failed"), ("refused", "proxy_unreachable"),
    ("stall", "proxy_timeout"), ("malformed", "proxy_handshake_failed"),
    ("tls-name", "proxy_handshake_failed"), ("tls-trust", "proxy_handshake_failed"),
    ("socks-downgrade", "proxy_auth_failed"),
])
async def test_managed_proxy_business_tcp_faults(
    managed_lab, deployment_runners, rt, image, isolated_org, fault, diagnostic,
):
    lab = managed_lab
    captures = lab.tcp_faults
    require(captures is not None and captures.bridge_log_dir is not None,
            "configure TCP fault listeners, independent target capture, and per-Box shim logs")
    healthy_variant = {"auth": "https-credential", "socks-downgrade": "socks5-credential"}.get(fault, "https-anonymous")
    healthy = lab.variants[healthy_variant]
    faulty = {"refused": captures.refused_proxy, "stall": captures.stalled_proxy,
              "malformed": captures.malformed_proxy}.get(fault)
    if fault == "auth":
        _, correct = read_credential(healthy.credential_file)
        _, rejected = read_credential(captures.bad_credentials)
        require(correct != rejected, "the wrong-credential probe requires different synthetic credentials")
        faulty = replace(healthy, credential_file=captures.bad_credentials)
    negotiation = captures.negotiation
    if fault in ("tls-name", "tls-trust", "socks-downgrade"):
        require(negotiation is not None, "configure the independent TLS and SOCKS5 fault listeners")
        faulty = {"tls-name": replace(healthy, endpoint=negotiation.wrong_name_endpoint),
                  "tls-trust": negotiation.untrusted_proxy, "socks-downgrade": negotiation.downgrade_proxy}[fault]
    registry = rt.outbound_proxies()
    async with AsyncExitStack() as cleanup:
        control_name, fault_name = e2e_box_name(), e2e_box_name()
        cleanup.push_async_callback(remove_registration, registry, control_name)
        cleanup.push_async_callback(remove_registration, registry, fault_name)
        control_binding = await register_proxy(isolated_org, registry, control_name, healthy)
        fault_binding = await register_proxy(isolated_org, registry, fault_name, faulty)
        control = await managed_box(cleanup, rt, image, control_name)
        bound = await managed_box(cleanup, rt, image, fault_name)
        direct = await managed_box(cleanup, rt, image, None)
        control_state = await lab.readback(control, control_binding)
        bound_state = await lab.readback(bound, fault_binding)
        trace, _ = await cleanup.enter_async_context(controlled_run(lab, deployment_runners))
        await calibrate_connect_trace(trace, direct, lab)
        await trace.step("start-connect-trace", box_id=bound.id, epoch=bound_state[0])
        initial_codes = await outbound_diagnostics(isolated_org, bound)
        require(not initial_codes, "fresh fault Box already has a TCP diagnostic")

        first_start, first_end, first_elapsed = await literal_https_probe(control, lab, healthy)
        fault_start, _, fault_elapsed = await literal_https_probe(bound, lab, expected_failure=True)
        observed_codes = await outbound_diagnostics(isolated_org, bound)
        await asyncio.sleep(max(0, 30 - fault_elapsed))
        if observed_codes == initial_codes:
            observed_codes = await outbound_diagnostics(isolated_org, bound)
        fault_end = time.time_ns()
        last_start, last_end, last_elapsed = await literal_https_probe(control, lab, healthy)

        await require_bracketed_capture(captures.syn, (first_start, first_end), (fault_start, fault_end), (last_start, last_end))
        require(not await trace.connect_window(bound.id, bound_state[0], lab.target_tcp_ip, captures.syn.port,
                                               fault_start, fault_end), "bound probe attempted a direct target dial")
        if fault == "refused":
            require(await captures.refused.packets(fault_start, fault_end), "closed proxy port produced no observed TCP reset")
            lab.observe_connect(None, captures.syn.port, fault_start, fault_end, fault_end)
        elif fault in ("tls-name", "tls-trust"):
            leaf = tls_leaf_in_window(healthy, first_start, first_end)
            require(tls_leaf_in_window(healthy, last_start, last_end) == leaf,
                    "the trusted proxy leaf changed across the TLS fault probe")
            selected = tls_leaf_in_window(faulty, fault_start, fault_end)
            if fault == "tls-name":
                require(selected == leaf, "wrong-name probe did not receive the leaf trusted by both controls")
            else:
                require(selected == negotiation.untrusted_fingerprint and selected != leaf,
                        "trust probe did not receive the audited matching-name leaf")
            lab.observe_connect(None, captures.syn.port, fault_start, fault_end, fault_end)
        elif fault == "socks-downgrade":
            events = negotiation_events(faulty, "socks_downgrade", fault_start, fault_end)
            require(len(events) == 1 and events[0].get("offered_methods") == [2]
                    and events[0].get("selected_method") == 0 and events[0].get("client_closed") is True,
                    "SOCKS5 client did not refuse the unoffered no-auth method before sending CONNECT")
            lab.observe_connect(None, captures.syn.port, fault_start, fault_end, fault_end)
        else:
            outcome = {"auth": "auth_rejected", "stall": "negotiation_stalled", "malformed": "malformed_reply"}[fault]
            lab.observe_connect(healthy if fault == "auth" else faulty, captures.syn.port,
                                fault_start, fault_end, fault_end, outcome=outcome)
        overhead = min(2.0, max(first_elapsed, last_elapsed) + 0.25)
        require(fault_elapsed <= 30 + overhead, "business TCP failure exceeded its setup deadline")
        if fault == "stall":
            require(fault_elapsed >= 29.75, "business TCP stall ended before exercising the setup deadline")
        require(await lab.readback(bound, fault_binding) == bound_state, "fault changed the installed proxy revision")
        require(await lab.readback(control, control_binding) == control_state, "control binding changed during observation")
        await require_bridge_message(captures.bridge_log_dir, bound.id, fault_start, fault_end,
                                     lambda message: message == f"outbound dial = {diagnostic}",
                                     f"Runtime did not record {diagnostic} for the probe")
        require(observed_codes - initial_codes == {diagnostic},
                f"public outbound status did not expose a fresh {diagnostic} for the observed failure")


async def test_managed_proxy_keeps_credentials_out_of_guest(managed_lab, rt, image, isolated_org):
    lab = managed_lab
    variant = lab.variants["https-credential"]
    workload_secret = read_workload_secret(lab.workload_secret_file)
    _, credential = read_credential(variant.credential_file)
    secret_values = (*credential.values(), workload_secret)
    registry = rt.outbound_proxies()
    name = e2e_box_name()
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        expected = await register_proxy(isolated_org, registry, name, variant)
        secret = boxlite.Secret(name="acceptance-workload", value=workload_secret,
                                hosts=[urlsplit(lab.target_origin).hostname],
                                headers={"Authorization": "Bearer {value}"})
        bound = await managed_box(cleanup, rt, image, name, secrets=[secret])
        control = await managed_box(cleanup, rt, image, name)
        before = await lab.readback(bound, expected)
        marker = uuid4().hex
        async with asyncio.timeout(45):
            execution = await bound.exec("python3", ["-c", GUEST_INSPECTION, marker])
            stdout, stderr = await drain(execution)
            verify_guest_inspection(stdout, stderr, marker, secret_values)
            require((await execution.wait()).exit_code == 0, "Guest inspection did not complete")
        require(await lab.readback(bound, expected) == before, "installed route changed during Guest inspection")

        for box, header, matches in ((bound, "Bearer placeholder", True), (bound, None, False),
                                     (control, f"Bearer {uuid4().hex}", False)):
            before = await lab.readback(box, expected)
            await observe_request(box, lab, "curl", variant, authorization=header,
                                  secret_matches=matches, secrets=secret_values)
            require(await lab.readback(box, expected) == before,
                    "installed route changed during workload secret probe")


async def registry_identity(owner, variable):
    profile_name = os.environ.get(variable)
    require(bool(profile_name), f"configure the acceptance API key profile in {variable}")
    profile = load_profile(profile_name)
    token = profile.get("api_key")
    require(token and profile.get("url", "").rstrip("/") == owner.url.rstrip("/"),
            "registry probe identity must be an API key on the acceptance API origin")
    prefix = await asyncio.to_thread(discover_path_prefix, owner.url, token)
    require(bool(prefix) and prefix != "default", "registry probe identity needs an explicit organization prefix")
    permissions = await asyncio.to_thread(api_key_permissions, owner.url, token)
    return replace(owner, profile_name=profile_name, token=token, path_prefix=prefix), permissions


async def registry_request(identity, method, path, body=None, *, scope=None):
    route = (scope or identity).v1(path)
    return await http(identity.url_for(route), method, identity.auth_headers(content_type=body is not None),
                      json.dumps(body).encode() if body is not None else None)


async def require_rejected_binding(cleanup, runtime, image, proxy_name):
    name = e2e_box_name()
    options = boxlite.BoxOptions(image=image)
    bound_box_lifetime(options)
    cleanup.push_async_callback(cleanup_box, runtime, name)
    with pytest.raises(ManagedCreateError) as rejected:
        await runtime.create_with_outbound_proxy(options, proxy_name, name)
    error = rejected.value
    require(error.admission == "rejected" and error.http_status == 404 and error.box_id is None,
            "a missing registration must reject managed creation without allocating a Box ID")
    require(all(box.name != name for box in await runtime.list_info()),
            "the rejected managed create left a Box in its organization")


async def test_managed_proxy_registry_rejects_unauthorized_changes(managed_lab, rt, image, isolated_org):
    owner = isolated_org
    worker, worker_permissions = await registry_identity(owner, "BOXLITE_E2E_MANAGED_WORKER_PROFILE")
    foreign, foreign_permissions = await registry_identity(owner, "BOXLITE_E2E_MANAGED_FOREIGN_PROFILE")
    mutations = {"write:proxies", "delete:proxies"}
    require(worker.path_prefix == owner.path_prefix and not mutations.intersection(worker_permissions),
            "worker must belong to the acceptance organization and lack both proxy mutation grants")
    require(foreign.path_prefix != owner.path_prefix and mutations <= foreign_permissions,
            "foreign identity must have both proxy mutation grants in its own acceptance organization")
    require({"write:boxes", "delete:boxes"} <= foreign_permissions,
            "foreign acceptance identity needs Box create and cleanup grants")

    registry = rt.outbound_proxies()
    name, candidate = e2e_box_name(), e2e_box_name()
    resource = f"proxies/{name}"
    variant = managed_lab.variants["https-credential"]
    patch = {"url": managed_lab.variants["http-anonymous"].endpoint, "credential": None}
    async with AsyncExitStack() as cleanup:
        cleanup.push_async_callback(remove_registration, registry, name)
        cleanup.push_async_callback(remove_registration, registry, candidate)
        await register_proxy(owner, registry, name, variant)
        before = await registry.get(name)

        worker_read = await registry_request(worker, "GET", resource)
        require(worker_read.status == 200 and json.loads(worker_read.body) == before,
                "worker could not read the authorized redacted registration")
        for method, path, body in (("POST", "proxies", {"name": candidate, "url": patch["url"]}),
                                    ("PATCH", resource, patch), ("DELETE", resource, None)):
            reply = await registry_request(worker, method, path, body)
            require(reply.status == 403, f"registry {method} without grants returned HTTP {reply.status}")

        foreign_read = await registry_request(foreign, "GET", "proxies")
        require(foreign_read.status == 200, "foreign identity could not read its own registry")
        for method, body in (("GET", None), ("PATCH", patch), ("DELETE", None)):
            wrong_scope = await registry_request(foreign, method, resource, body, scope=owner)
            require(wrong_scope.status == 403, f"foreign {method} against owner scope returned HTTP {wrong_scope.status}")
            hidden = await registry_request(foreign, method, resource, body)
            require(hidden.status == 404, f"foreign {method} in its own scope returned HTTP {hidden.status}")

        require(await registry.get(name) == before, "unauthorized requests changed the owner registration")
        require(all(entry["name"] != candidate for entry in await registry.list()),
                "unauthorized create added a registration")
        await require_rejected_binding(cleanup, rt, image, candidate)
        foreign_runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
            url=foreign.url, credential=boxlite.ApiKeyCredential(foreign.token), path_prefix=foreign.path_prefix,
        ))
        await require_rejected_binding(cleanup, foreign_runtime, image, name)
        require(await registry.get(name) == before, "rejected binding changed the owner registration")
