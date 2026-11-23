"""Check the managed proxy acceptance harness with an isolated TLS target."""
from http.client import HTTPSConnection
import asyncio
import base64
from contextlib import suppress
from dataclasses import replace
from datetime import datetime
from ipaddress import IPv4Address, IPv6Address
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import sys
from threading import Thread
import time
from uuid import uuid4

import pytest

from managed_outbound import (
    ManagedOutboundLab, PacketCapture, ProtectedTarget, ProxyVariant, bridge_messages, public_proxy_diagnostics,
    verify_guest_inspection,
)
from managed_outbound_deployment import DeploymentControl, connect_attempts, dhcp_evidence, guest_link_evidence, runner_receipt
from test_managed_outbound import (
    GUEST_BUSINESS_DNS, GUEST_HTTPS, GUEST_UDP, GUEST_UDP_UNBIND, HELD_TCP_PROBE_SECONDS, ROTATION_CONFIRM_SECONDS,
    negotiation_events, quic_probe_command, tls_leaf_in_window,
)

sys.path.insert(0, str(Path(__file__).parents[1] / "fixtures"))
from managed_outbound_target import KEEP_ALIVE_IDLE_SECONDS, datagram_listener, target_server
from managed_outbound_proxy import AcceptanceProxy, TUNNEL_IDLE_SECONDS, VARIANTS, proxy_tls
from managed_outbound_dns import DNS_MESSAGE, DNSObserver, direct_dns_servers, doh_server, name_wire, query_gateway
from managed_outbound_connect import connect_records


@pytest.fixture(autouse=True)
def verify_runner_saw_all_boxes():
    yield


@pytest.fixture
def local_tls(tmp_path):
    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("openssl is needed to create the test TLS certificate")
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:alias.example",
                    "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True, timeout=15)
    return cert, key


def make_lab(target_port, log, variants):
    return ManagedOutboundLab(
        api_origin="https://api.example", organization_prefix="acceptance", direct_source="127.0.0.1",
        target_origin=f"https://localhost:{target_port}", target_log=log, target_tcp_ip="127.0.0.1",
        target_udp_ip="127.0.0.1", target_udp_port=0,
        inventory_url="https://api.example/api/box/for-runner", runner_origin="https://runner.example",
        runner_id="", postgres_service="", variants=variants, inventory_token="", runner_key="",
    )


def test_managed_rotation_probe_fits_fixture_idle_deadlines():
    assert ROTATION_CONFIRM_SECONDS < HELD_TCP_PROBE_SECONDS
    assert HELD_TCP_PROBE_SECONDS < min(TUNNEL_IDLE_SECONDS, KEEP_ALIVE_IDLE_SECONDS)


def test_managed_runner_dns_observer_records_real_udp_tcp_and_bootstrap(tmp_path):
    log_path = tmp_path / "runner-dns.jsonl"
    zone, bootstrap = "acceptance.example", "proxy.acceptance.example"
    observer_address, ipv6 = IPv4Address("192.0.2.9"), IPv6Address("2001:db8::9")
    private = f"private-{uuid4().hex}.{zone}"
    with log_path.open("wb") as log:
        observer = DNSObserver(zone, observer_address.packed, ipv6.packed, log.fileno(), frozenset({"127.0.0.1"}),
                               {bootstrap: IPv4Address("192.0.2.10").packed}, IPv4Address("10.37.0.9").packed)
        with direct_dns_servers("127.0.0.1", 0, observer) as (tcp, udp):
            workers = [(server, Thread(target=server.serve_forever)) for server in (udp, tcp)]
            for _, worker in workers:
                worker.start()
            try:
                port = tcp.server_address[1]
                first, second = (f"answer-{uuid4().hex}.{zone}" for _ in range(2))
                for transport, name, record, expected in (("udp", first, "A", str(observer_address)),
                                                         ("tcp", second, "AAAA", str(ipv6)),
                                                         ("udp", bootstrap, "A", "192.0.2.10"),
                                                         ("udp", private, "A", "10.37.0.9")):
                    answer = query_gateway(transport, "127.0.0.1", port, name, record)
                    assert answer["rcode"] == 0 and answer["answers"] == [expected]
            finally:
                for server, worker in workers:
                    server.shutdown()
                    worker.join(timeout=5)
    events = [json.loads(row) for row in log_path.read_text().splitlines()]
    assert [(row["name"], row["transport"], row["type"]) for row in events] == [
        (first, "udp", "A"), (second, "tcp", "AAAA"), (bootstrap, "udp", "A"), (private, "udp", "A"),
    ]
    assert events[-1]["address"] == "10.37.0.9"


def test_managed_doh_observer_serves_real_tls_answers_and_corrupts_only_marked_ids(tmp_path, local_tls):
    log_path = tmp_path / "doh.jsonl"
    zone = "acceptance.example"
    ipv4, ipv6 = IPv4Address("192.0.2.9"), IPv6Address("2001:db8::9")
    private = IPv4Address("10.37.0.9")
    cert, key = local_tls
    with log_path.open("wb") as log:
        observer = DNSObserver(zone, ipv4.packed, ipv6.packed, log.fileno(), frozenset({"127.0.0.1"}), {}, private.packed)
        with doh_server("127.0.0.1", 0, cert, key, observer) as server:
            worker = Thread(target=server.serve_forever)
            worker.start()
            try:
                for outcome in ("answer", "wrong-id", "private", "stall"):
                    name = f"{outcome}-{uuid4().hex}.{zone}"
                    wire = struct.pack("!6H", 93, 0x0100, 1, 0, 0, 0) + name_wire(name) + struct.pack("!HH", 1, 1)
                    connection = HTTPSConnection("localhost", server.server_port, timeout=2,
                                                 context=ssl.create_default_context(cafile=str(cert)))
                    try:
                        connection.request("POST", "/dns-query", wire, {"Content-Type": DNS_MESSAGE})
                        if outcome == "stall":
                            with pytest.raises(TimeoutError):
                                connection.getresponse()
                            continue
                        response = connection.getresponse()
                        body = response.read()
                        assert response.status == 200 and response.getheader("Content-Type") == DNS_MESSAGE
                        assert struct.unpack_from("!H", body)[0] == (92 if outcome == "wrong-id" else 93)
                        assert body.endswith(private.packed if outcome == "private" else ipv4.packed)
                    finally:
                        connection.close()
            finally:
                server.shutdown()
                worker.join(timeout=5)
    events = [json.loads(row) for row in log_path.read_text().splitlines()]
    assert [row["outcome"] for row in events] == ["answer", "wrong-id", "answer", "stall"]
    assert events[2]["address"] == str(private)
    assert all(row["source"] == "127.0.0.1" and row["sni"] == "localhost" for row in events)


def test_managed_connect_trace_counts_refused_and_mapped_dials_inside_the_window():
    destination = IPv4Address("192.0.2.9")
    native = 'connect(5, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.9")}, 16)'
    mapped = 'connect(5, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "::ffff:192.0.2.9", &sin6_addr)}, 28)'
    rows = connect_records([
        f"99.99999 {native} = 0",
        f"100.01 {native} = -1 ECONNREFUSED (Connection refused)",
        f"100.02 {mapped} <unfinished ...>",
        '100.03 connect(6, {sa_family=AF_UNIX, sun_path="fixture"}, 32) = 0',
        f"100.04 {native.replace('443', '80')} = 0",
    ], destination, 443, 100_000_000_000, 101_000_000_000)
    assert [(row["family"], row["result"]) for row in rows] == [("inet", "ECONNREFUSED"), ("inet6", "unfinished")]
    identity = dict(runner_id="runner", box_id="box", epoch="epoch", port=443, address=str(destination))
    report = {**identity, "complete": True, "from_ns": 100_000_000_000, "through_ns": 101_000_000_000, "attempts": rows}
    check = ("runner", "box", "epoch", str(destination), 443, 100_000_000_000, 101_000_000_000)
    assert connect_attempts(report, *check) == rows
    with pytest.raises(AssertionError, match="exact Box epoch and probe window"):
        connect_attempts({**report, "through_ns": 100_000_000_001}, *check)
    with pytest.raises(ValueError, match="undecodable IP endpoint"):
        connect_records(["100.5 connect(5, {sa_family=AF_INET, ...}, 16) = 0"], destination, 443,
                        100_000_000_000, 101_000_000_000)


@pytest.mark.parametrize(("phase", "fields", "invalid"), [
    ("completed", {"write_started_ns": 3, "write_completed_ns": 4, "accepted_bytes": 64, "header_bytes": 4},
     {"write_completed_ns": 6}),
    ("queued", {"frame_dropped": True, "accepted_bytes": 0, "header_bytes": 0}, {"write_started_ns": 4}),
    ("partial", {"write_started_ns": 3, "closed_ns": 6, "accepted_bytes": 0, "header_bytes": 4,
                 "peer_payload_bytes": 0, "outcome": "uncertain"}, {"accepted_bytes": 64}),
])
def test_managed_guest_link_evidence_rejects_wrong_frame_order_or_length(phase, fields, invalid):
    report = dict(runner_id="runner", box_id="box", epoch="epoch", marker="marked", phase=phase,
                  complete=True, generation="old", old_writes_after_seal=0, queued_ns=2, sealed_ns=5, declared_bytes=64,
                  **fields)
    check = ("runner", "box", "epoch", "marked", phase, 1, 7)
    guest_link_evidence(report, *check)
    with pytest.raises(AssertionError, match="frame|partial write"):
        guest_link_evidence({**report, **invalid}, *check)


def test_managed_dhcp_requires_exact_transaction_and_guest_delivery():
    request = dict(type="request", xid=41, client="02:00:00:00:00:01", address="192.168.127.2", time_ns=3)
    ack = {**request, "type": "ack", "server": "192.168.127.1", "received_by_guest": True, "time_ns": 4}
    report = dict(runner_id="runner", box_id="box", epoch="epoch", complete=True, request=request, ack=ack)
    check = ("runner", "box", "epoch", request["address"], ack["server"], 1, 5)
    dhcp_evidence(report, *check)
    for change in ({"xid": 42}, {"received_by_guest": False}, {"time_ns": 6}):
        with pytest.raises(AssertionError, match="matching DHCP lease acknowledgement"):
            dhcp_evidence({**report, "ack": {**ack, **change}}, *check)


def test_managed_business_dns_probe_sets_hostname_without_guest_lookup(tmp_path, local_tls):
    cert, key = local_tls
    marker = uuid4().hex
    log_path = tmp_path / "business.jsonl"
    with target_server("127.0.0.1", 0, cert, key, log_path) as target:
        worker = Thread(target=target.serve_forever)
        worker.start()
        try:
            result = subprocess.run(
                [sys.executable, "-c", GUEST_BUSINESS_DNS, "127.0.0.1", str(target.server_port), "alias.example", marker, "8"],
                env={**os.environ, "SSL_CERT_FILE": str(cert)}, capture_output=True, check=True, timeout=10,
            )
            assert json.loads(result.stdout)["marker"] == marker
        finally:
            target.shutdown()
            worker.join(timeout=5)
    row = json.loads(log_path.read_text())
    assert (row["marker"], row["host"], row["sni"]) == (marker, f"alias.example:{target.server_port}", "alias.example")


@pytest.mark.skipif(os.environ.get("BOXLITE_E2E_TEST_PCAP") != "1", reason="requires libpcap headers and a C compiler")
async def test_managed_packet_capture_filters_tcp_syn_and_closed_port_rst(tmp_path):
    source = Path(__file__).parents[1] / "fixtures" / "managed_outbound_capture.c"
    binary, pcap = tmp_path / "packet-capture", tmp_path / "traffic.pcap"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", str(source), "-lpcap", "-o", str(binary)],
                   check=True, capture_output=True, timeout=20)
    runner, target = "192.0.2.7", "192.0.2.9"
    packets = []
    for index, (origin, destination, origin_port, destination_port, flags) in enumerate([
        (runner, target, 12345, 443, 0x02),
        (runner, target, 12345, 443, 0x10),
        (runner, target, 12345, 8443, 0x02),
        (target, runner, 443, 12345, 0x14),
        (target, runner, 8443, 12345, 0x14),
    ], start=1):
        ethernet = bytes(12) + b"\x08\x00"
        ipv4 = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 40, 0, 0, 64, 6, 0,
                           IPv4Address(origin).packed, IPv4Address(destination).packed)
        tcp = struct.pack("!HHIIBBHHH", origin_port, destination_port, 0, 0, 0x50, flags, 1024, 0, 0)
        packet = ethernet + ipv4 + tcp
        packets.append(struct.pack("<IIII", 100, index, len(packet), len(packet)) + packet)
    for index, port in enumerate((443, 8443), start=6):
        ipv4 = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 29, 0, 0, 64, 17, 0,
                           IPv4Address(runner).packed, IPv4Address(target).packed)
        udp = struct.pack("!HHHH", 12345, port, 9, 0) + b"x"
        packet = ethernet + ipv4 + udp
        packets.append(struct.pack("<IIII", 100, index, len(packet), len(packet)) + packet)
    pcap.write_bytes(struct.pack("<IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 96, 1) + b"".join(packets))
    for kind, expected, peer in (("syn", 100_000_001_000, []), ("rst", 100_000_004_000, [runner]),
                                 ("udp", 100_000_006_000, [])):
        path = tmp_path / f"{kind}.jsonl"
        subprocess.run([str(binary), "replay", str(pcap), kind, target, "443", str(path), *peer],
                       check=True, capture_output=True, timeout=10)
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        assert rows[0]["live"] is False
        assert rows[1:] == [{"event": "packet", "time_ns": expected}]
        with pytest.raises(AssertionError, match="did not start live"):
            await PacketCapture(path, kind, target, 443, next(iter(peer), "")).packets(expected, expected)


async def test_managed_tcp_capture_requires_continuous_lossless_evidence(tmp_path):
    path = tmp_path / "capture.jsonl"
    capture = PacketCapture(path, "syn", "192.0.2.9", 443)
    start = {"event": "start", "live": True, "kind": "syn", "address": capture.address,
             "port": 443, "peer": "", "time_ns": 1}
    drained = {"event": "drained", "time_ns": 100, "kernel_drops": 0, "interface_drops": 0}

    def write(*events):
        path.write_text("".join(json.dumps(event) + "\n" for event in events))

    write(start, {"event": "packet", "time_ns": 10}, drained)
    assert await capture.packets(2, 99) == [10]
    write(start, {**drained, "kernel_drops": 1})
    with pytest.raises(AssertionError, match="reported packet loss"):
        await capture.packets(2, 99)
    write(start, {**drained, "time_ns": 3_000_000_000})
    with pytest.raises(AssertionError, match="gap during the probe"):
        await capture.packets(2, 99)


def test_managed_fault_requires_structured_public_diagnostic_codes():
    assert public_proxy_diagnostics({"application_state": "confirmed", "message": "proxy_timeout"}) == set()
    assert public_proxy_diagnostics({"diagnostic": {"code": "proxy_timeout"}}) == set()
    assert public_proxy_diagnostics({"proxy": {"diagnostics": [{"code": "proxy_timeout"}]}}) == set()
    assert public_proxy_diagnostics({"proxy": {"diagnostic": {"code": "proxy_timeout"}}}) == {"proxy_timeout"}
    with pytest.raises(AssertionError, match="invalid diagnostic"):
        public_proxy_diagnostics({"proxy": {"diagnostic": "proxy_timeout"}})


@pytest.mark.parametrize(("fault", "error"), [
    ("valid", None),
    ("other-run", "different action or run"),
    ("missing-observer", "synchronized live observer"),
    ("other-box", "unscoped or malformed"),
])
async def test_managed_deployment_controller_scopes_runner_evidence(tmp_path, fault, error):
    script = tmp_path / "controller"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"fault = {fault!r}\n"
        "request = json.load(sys.stdin)\n"
        "assert request['barrier'] == 'held-release' and request['organization'] == 'isolated'\n"
        "runners = [request['primary_runner_id'], request['replacement_runner_id']]\n"
        "print(json.dumps(dict(action=request['action'],\n"
        "    run_id='unrelated' if fault == 'other-run' else request['run_id'],\n"
        "    ready=runners[:1] if fault == 'missing-observer' else runners,\n"
        "    events=[dict(box_id='unrelated' if fault == 'other-box' else request['box_id'],\n"
        "                 runner_id=runners[1], operation='release-gate', delivered=False,\n"
        "                 reply_forwarded=False, credential_present=False)])))\n"
    )
    script.chmod(0o700)
    control = DeploymentControl(script, "isolated", ("old-runner", "replacement-runner"))
    if error:
        with pytest.raises(AssertionError, match=error):
            await control.evidence("held-release", "TestBoxId001")
    else:
        [event] = await control.evidence("held-release", "TestBoxId001")
        assert event["operation"] == "release-gate" and event["delivered"] is False


@pytest.mark.parametrize(("fault", "error"), [
    ("valid", None),
    ("other-name", "named public request observer"),
    ("missing-public-observer", "named public request observer"),
    ("two-posts", "exactly one correlated"),
    ("wrong-box", "exactly one correlated"),
    ("missing-candidate", "synchronized live observer"),
    ("unscoped-runner", "unscoped or malformed"),
])
async def test_managed_deployment_correlates_named_create_evidence(tmp_path, fault, error):
    script = tmp_path / "create-controller"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"fault = {fault!r}\n"
        "request = json.load(sys.stdin)\n"
        "runners = [request['primary_runner_id'], request['replacement_runner_id'], 'candidate']\n"
        "post = dict(status=503, reply_forwarded=True)\n"
        "if fault == 'wrong-box': post['box_id'] = 'other-identifier'\n"
        "events = [dict(box_id='TestBoxId001', runner_id='foreign', operation='create',\n"
        "               delivered=True, reply_forwarded=False, credential_present=False)]\n"
        "assert request['action'] == 'create-evidence' and request['box_id'] is None\n"
        "print(json.dumps(dict(action=request['action'], run_id=request['run_id'],\n"
        "    name='another' if fault == 'other-name' else request['name'],\n"
        "    public_ready=fault != 'missing-public-observer',\n"
        "    public_posts=[post, post] if fault == 'two-posts' else [post],\n"
        "    ready=runners[:2] if fault == 'missing-candidate' else [*runners, 'foreign'],\n"
        "    events=events if fault == 'unscoped-runner' else [])))\n"
    )
    script.chmod(0o700)
    control = DeploymentControl(script, "isolated", ("old-runner", "replacement-runner"))
    if error:
        with pytest.raises(AssertionError, match=error):
            await control.create_evidence("e2e-named-create", candidate="candidate")
    else:
        post, events = await control.create_evidence("e2e-named-create", candidate="candidate")
        assert post["status"] == 503 and post["reply_forwarded"] and not events


async def test_managed_deployment_requires_exact_authenticated_runner_receipt(tmp_path, local_tls, monkeypatch):
    cert, key = local_tls
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    monkeypatch.setenv("SSL_CERT_FILE", str(cert))
    box_id, epoch, runner = "TestBoxId001", "replacement-epoch", "replacement-runner"
    boot_key = {"runner_id": runner, "attempt_id": "attempt"}
    requests = []
    sample = {"box_id": box_id, "receipt": {"epoch": epoch, "runner_id": runner}}

    async def respond(reader, writer):
        headers = (await reader.readuntil(b"\r\n\r\n")).decode().split("\r\n")
        fields = dict(line.lower().split(": ", 1) for line in headers[1:] if ": " in line)
        body = json.loads(await reader.readexactly(int(fields["content-length"])))
        requests.append((headers[0].split()[1], fields["authorization"], fields["x-boxlite-runner-id"], body))
        data = json.dumps(sample).encode()
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data)
        await writer.drain()
        writer.close()
        with suppress(ConnectionResetError):
            await writer.wait_closed()

    async with await asyncio.start_server(respond, "127.0.0.1", 0, ssl=tls) as server:
        port = server.sockets[0].getsockname()[1]
        lab = replace(make_lab(port, tmp_path / "target.log", {}), runner_origin=f"https://localhost:{port}",
                      runner_id=runner, runner_key="synthetic-fixture-key")
        assert await runner_receipt(lab, box_id, epoch) == sample["receipt"]
        sample["receipt"] = {"epoch": epoch, "key": boot_key, "outcome": "confirmed"}
        assert (await runner_receipt(lab, box_id, epoch, bootstrap_key=boot_key))["outcome"] == "confirmed"
        sample["receipt"]["epoch"] = "older-epoch"
        with pytest.raises(AssertionError, match="identity differs"):
            await runner_receipt(lab, box_id, epoch, bootstrap_key=boot_key)
    assert requests[0] == (
        f"/v1/boxes/{box_id}/network/outbound/managed-route", "bearer synthetic-fixture-key", runner,
        {"runner_id": runner, "epoch": epoch, "command": {"operation": "inspect"}},
    )
    assert requests[1] == (
        f"/v1/boxes/{box_id}/network/outbound/bootstrap/receipt", "bearer synthetic-fixture-key", runner, boot_key,
    )


def test_managed_runtime_evidence_uses_the_box_log_target_and_time_window(tmp_path):
    box_id = "n8p0t5m2x1q9"
    directory = tmp_path / box_id / "logs"
    directory.mkdir(parents=True)
    (directory / "boxlite-shim.log.2026-11-22").write_text(
        "2026-11-22T11:59:59.000Z TRACE gvproxy: outbound dial = proxy_timeout\n"
        "2026-11-22T12:00:00.000Z TRACE gvproxy: outbound dial = proxy_auth_failed\n"
        "2026-11-22T12:00:00.001Z TRACE other_component: outbound dial = proxy_timeout\n"
        "2026-11-22T12:00:00.002Z INFO gvproxy: allowNet TCP: blocked (no matching rule) dst_port=443 dst_ip=192.0.2.9\n"
        "2026-11-22T12:00:00.003Z TRACE gvproxy: incomplete line"
    )
    started = int(datetime.fromisoformat("2026-11-22T12:00:00Z").timestamp()) * 1_000_000_000
    assert list(bridge_messages(tmp_path, box_id, started, started + 1_000_000_000)) == [
        "outbound dial = proxy_auth_failed", "allowNet TCP: blocked (no matching rule) dst_port=443 dst_ip=192.0.2.9",
    ]


def test_managed_external_dns_probe_reports_real_udp_refusal():
    fixture = Path(__file__).parents[1] / "fixtures" / "managed_outbound_dns.py"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    command = [sys.executable, str(fixture), "probe", "udp", "127.0.0.1", str(port),
               f"answer-{uuid4().hex}.acceptance.example", "A", "--accept-blocked"]
    reply = subprocess.run(command, check=True, capture_output=True, timeout=10)
    assert json.loads(reply.stdout) == {"blocked": True}


def test_managed_quic_probe_pins_the_address_and_disables_http_fallback():
    marker = uuid4().hex
    command = quic_probe_command("https://h3.acceptance.example:8443", "192.0.2.9", marker)
    assert command[0] == "-q" and "--http3-only" in command
    assert command[command.index("--noproxy") + 1] == "*"
    assert command[command.index("--resolve") + 1] == "h3.acceptance.example:8443:192.0.2.9"
    assert command[-1] == f"https://h3.acceptance.example:8443/probe/{marker}"


async def test_managed_proxy_tracks_the_selected_leaf_when_tls_name_or_trust_fails(tmp_path, local_tls):
    cert, key = local_tls
    path = tmp_path / "tls-selection.jsonl"

    async def close_connection(_reader, writer):
        writer.close()
        await writer.wait_closed()

    with path.open("wb") as observations:
        server = await asyncio.start_server(close_connection, "127.0.0.1", 0,
                                            ssl=proxy_tls(cert, key, tls_observations=observations.fileno()))
        async with server, asyncio.timeout(5):
            port = server.sockets[0].getsockname()[1]
            trusted = ssl.create_default_context(cafile=str(cert))
            start = time.time_ns()
            _, writer = await asyncio.open_connection("127.0.0.1", port, ssl=trusted, server_hostname="localhost")
            writer.close()
            await writer.wait_closed()
            healthy = ProxyVariant("https-anonymous", f"https://localhost:{port}", "127.0.0.1", path, None)
            leaf = tls_leaf_in_window(healthy, start, time.time_ns())
            for name, context in (("wrong.acceptance.example", trusted), ("localhost", ssl.create_default_context())):
                start = time.time_ns()
                with pytest.raises(ssl.SSLCertVerificationError):
                    await asyncio.open_connection("127.0.0.1", port, ssl=context, server_hostname=name)
                rejected = ProxyVariant("https-anonymous", f"https://{name}:{port}", "127.0.0.1", path, None)
                assert tls_leaf_in_window(rejected, start, time.time_ns()) == leaf


async def test_managed_proxy_socks_downgrade_distinguishes_close_from_a_followup(tmp_path):
    path = tmp_path / "socks-downgrade.jsonl"
    with path.open("wb") as observations:
        fixture = AcceptanceProxy("socks5-credential", frozenset({"127.0.0.1"}), frozenset(),
                                  observations.fileno(), (b"synthetic-user", b"synthetic-key"), fault="socks-downgrade")
        server = await asyncio.start_server(fixture.handle, "127.0.0.1", 0)
        async with server, asyncio.timeout(5):
            port = server.sockets[0].getsockname()[1]
            variant = ProxyVariant(fixture.variant, f"socks5://localhost:{port}", "127.0.0.1", path, None)
            start = time.time_ns()
            for followup in (False, True):
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(b"\x05\x01\x02")
                assert await reader.readexactly(2) == b"\x05\x00"
                if followup:
                    writer.write(b"\x05\x01\x00\x01")
                    await writer.drain()
                    assert not await reader.read()
                writer.close()
                await writer.wait_closed()
            events = negotiation_events(variant, "socks_downgrade", start, time.time_ns())
            assert [(row["offered_methods"], row["selected_method"], row["client_closed"]) for row in events] == [
                ([2], 0, True), ([2], 0, False),
            ]


def test_managed_target_observes_https_source_and_excludes_credentials(tmp_path, local_tls):
    cert, key = local_tls
    log = tmp_path / "target.jsonl"

    with target_server("127.0.0.1", 0, cert, key, log) as target:
        thread = Thread(target=target.serve_forever)
        thread.start()
        context = ssl.create_default_context(cafile=str(cert))
        connection = HTTPSConnection("localhost", target.server_port, context=context, timeout=5)
        marker = uuid4().hex
        since = time.time_ns()
        try:
            connection.request("GET", f"/probe/{marker}", headers={"Authorization": "Bearer synthetic-check"})
            reply = connection.getresponse()
            assert reply.status == 200
            assert reply.read() == marker.encode()
        finally:
            connection.close()
            target.shutdown()
            thread.join(timeout=5)

        until = time.time_ns()
        lab = make_lab(target.server_port, log, {})
        lab.observe(marker, "127.0.0.1", since, until)
        with pytest.raises(AssertionError, match="expected source"):
            lab.observe(marker, "127.0.0.2", since, until)
        with pytest.raises(AssertionError, match="one independently observed"):
            lab.observe(uuid4().hex, "127.0.0.1", since, until)

        empty_proxy_log = tmp_path / "proxy.jsonl"
        empty_proxy_log.touch()
        proxy = ProxyVariant("http-anonymous", "http://proxy.example", "127.0.0.1", empty_proxy_log, None)
        lab = make_lab(target.server_port, log, {proxy.listener: proxy})
        with pytest.raises(AssertionError, match="exactly one first-hop"):
            lab.observe(marker, proxy.source, since, until, proxy)
    assert "synthetic-check" not in log.read_text()


def test_managed_target_compares_workload_secret_without_echoing_it(tmp_path, local_tls):
    cert, key = local_tls
    log = tmp_path / "target.jsonl"
    secret = "synthetic-workload-token"
    with target_server("127.0.0.1", 0, cert, key, log, workload_secret=secret) as target:
        thread = Thread(target=target.serve_forever)
        thread.start()
        lab = make_lab(target.server_port, log, {})
        context = ssl.create_default_context(cafile=str(cert))
        try:
            for headers, expected in [({"Authorization": f"Bearer {secret}"}, True),
                                      ({}, False), ({"Authorization": "Bearer synthetic-wrong-token"}, False)]:
                marker = uuid4().hex
                since = time.time_ns()
                connection = HTTPSConnection("localhost", target.server_port, context=context, timeout=5)
                try:
                    connection.request("GET", f"/probe/{marker}", headers=headers)
                    reply = connection.getresponse()
                    assert reply.status == 200
                    assert reply.read() == marker.encode()
                finally:
                    connection.close()
                until = time.time_ns()
                lab.observe(marker, lab.direct_source, since, until, secret_matches=expected)
                with pytest.raises(AssertionError, match="workload secret comparison"):
                    lab.observe(marker, lab.direct_source, since, until, secret_matches=not expected)
        finally:
            target.shutdown()
            thread.join(timeout=5)
    assert secret not in log.read_text()
    assert "synthetic-wrong-token" not in log.read_text()


async def test_managed_held_probe_reuses_the_target_connection(tmp_path, local_tls):
    cert, key = local_tls
    log = tmp_path / "held-target.jsonl"
    first, second = uuid4().hex, uuid4().hex
    with target_server("127.0.0.1", 0, cert, key, log) as target:
        thread = Thread(target=target.serve_forever)
        thread.start()
        lab = make_lab(target.server_port, log, {})
        since = time.time_ns()
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", GUEST_HTTPS, f"{lab.target_origin}/probe/{first}", second,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, "SSL_CERT_FILE": str(cert)},
            )
            async with asyncio.timeout(10):
                assert (await process.stdout.readline()).decode().strip() == first
                observed = lab.observe(first, lab.direct_source, since, time.time_ns())
                assert not lab.observations(second)
                since = time.time_ns()
                stdout, stderr = await process.communicate(b"continue\n")
                assert (process.returncode, stdout.decode().strip(), stderr) == (0, second, b"")
                resumed = lab.observe(second, lab.direct_source, since, time.time_ns())
                assert observed["connection_id"] == resumed["connection_id"]
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            target.shutdown()
            thread.join(timeout=5)


def test_managed_guest_verifier_requires_evidence_and_rejects_encoded_credentials():
    marker, secret = uuid4().hex, uuid4().hex
    record = base64.b64encode(b"ordinary-probe-value").decode()
    evidence = {"complete": marker, "environment": [record], "files": [record], "process": [record]}
    verify_guest_inspection(json.dumps(evidence), "", marker, (secret,))
    with pytest.raises(AssertionError, match="missing evidence or its completion marker"):
        verify_guest_inspection(json.dumps(evidence), "", uuid4().hex, (secret,))
    with pytest.raises(AssertionError, match="output disclosed"):
        verify_guest_inspection(json.dumps(evidence), secret, marker, (secret,))
    evidence["process"] = [base64.b64encode(f"prefix-{secret}-suffix".encode()).decode()]
    with pytest.raises(AssertionError, match="inspection disclosed"):
        verify_guest_inspection(json.dumps(evidence), "", marker, (secret,))


def test_managed_target_records_actual_udp_datagram(tmp_path):
    log = tmp_path / "udp.jsonl"
    marker = uuid4().hex.encode()
    with log.open("wb") as stream, datagram_listener("127.0.0.1", 0, stream.fileno()) as port:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(2)
            probe.sendto(marker, ("127.0.0.1", port))
            payload, peer = probe.recvfrom(33)
            assert (payload, peer) == (marker, ("127.0.0.1", port))
    observation = json.loads(log.read_text())
    assert observation["protocol"] == "udp"
    assert observation["source"] == "127.0.0.1"
    assert observation["marker"] == marker.decode()


async def test_managed_delayed_reply_probe_detects_delivery_to_the_old_guest_port(tmp_path):
    log = tmp_path / "udp-delayed.jsonl"
    releases = tmp_path / "release"
    releases.mkdir()
    held, late, fresh, blocked = (uuid4().hex for _ in range(4))
    with log.open("wb") as stream, datagram_listener("127.0.0.1", 0, stream.fileno(), release_dir=releases) as port:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", GUEST_UDP_UNBIND, "127.0.0.1", str(port), "127.0.0.1", str(port),
            held, late, fresh, blocked, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(8):
                initial = json.loads(await process.stdout.readline())
                assert initial["held"] == held
                first = json.loads(log.read_text())
                assert (first["protocol"], first["marker"], first["source_port"]) == ("udp-held", held, initial["guest_port"])
                (releases / held).touch()
                while len(lines := log.read_text().splitlines()) == 1:
                    await asyncio.sleep(0.1)
                delayed = json.loads(lines[1])
                assert (delayed["protocol"], delayed["marker"], delayed["source_port"]) == (
                    "udp-delayed-reply", late, initial["guest_port"],
                )
                stdout, stderr = await process.communicate(b"check-unbound\n")
                assert process.returncode != 0 and not stdout
                assert b"old Guest socket received a datagram after unbind" in stderr
                assert len(log.read_text().splitlines()) == 2
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


def test_managed_protected_target_requires_an_owned_private_address_and_independent_capture(tmp_path):
    log, capture = tmp_path / "private.jsonl", tmp_path / "private-syn.jsonl"
    log.touch()
    capture.touch()
    config = {"address": "10.88.0.42", "origin": "https://owned.acceptance.example:8443", "source": "10.88.0.1",
              "target_log": str(log), "capture_log": str(capture)}
    target = ProtectedTarget.load(config, "192.0.2.9", set())
    assert (target.capture.address, target.capture.port, target.capture.kind) == ("10.88.0.42", 8443, "syn")
    for address in ("169.254.1.23", "127.0.0.1", "192.168.127.42", "192.0.2.9"):
        with pytest.raises(AssertionError, match="owned RFC1918"):
            ProtectedTarget.load({**config, "address": address}, "192.0.2.9", set())
    with pytest.raises(AssertionError, match="separate HTTPS and SYN logs"):
        ProtectedTarget.load({**config, "capture_log": str(log)}, "192.0.2.9", set())


async def test_managed_guest_waits_for_cutover_signal_before_sending_second_udp_datagram(tmp_path):
    log = tmp_path / "udp-cutover.jsonl"
    first, second = uuid4().hex, uuid4().hex
    with log.open("wb") as stream, datagram_listener("127.0.0.1", 0, stream.fileno()) as port:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", GUEST_UDP, "127.0.0.1", str(port), first, second,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(10):
                assert await process.stdout.readline() == b"echo\n"
                assert [json.loads(row)["marker"] for row in log.read_text().splitlines()] == [first]
                stdout, stderr = await process.communicate(b"continue\n")
                assert (process.returncode, stdout, stderr) == (0, b"echo\n", b"")
                assert [json.loads(row)["marker"] for row in log.read_text().splitlines()] == [first, second]
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


def http_connect_request(target_port, credential):
    authority = f"127.0.0.1:{target_port}".encode()
    request = b"CONNECT " + authority + b" HTTP/1.1\r\nHost: " + authority + b"\r\n"
    if credential:
        request += b"Proxy-Authorization: Basic " + base64.b64encode(b":".join(credential)) + b"\r\n"
    return request + b"\r\n"


async def test_managed_proxy_resumes_held_https_after_rotation_idle(tmp_path, local_tls):
    cert, key = local_tls
    target_log, proxy_log = tmp_path / "held-target.jsonl", tmp_path / "held-proxy.jsonl"
    first, second = uuid4().hex, uuid4().hex
    with target_server("127.0.0.1", 0, cert, key, target_log) as target, proxy_log.open("wb") as log:
        worker = Thread(target=target.serve_forever)
        worker.start()
        target_port = target.server_port
        fixture = AcceptanceProxy("http-anonymous", frozenset({"127.0.0.1"}),
                                  frozenset({("127.0.0.1", target_port)}), log.fileno(), None)
        try:
            server = await asyncio.start_server(fixture.handle, "127.0.0.1", 0)
            async with server, asyncio.timeout(60):
                proxy_port = server.sockets[0].getsockname()[1]
                variant = ProxyVariant(fixture.variant, f"http://localhost:{proxy_port}", "127.0.0.1", proxy_log, None)
                lab = make_lab(target_port, target_log, {variant.listener: variant})
                started = time.time_ns()
                reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
                try:
                    writer.write(http_connect_request(target_port, None))
                    assert (await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200 ")
                    await writer.start_tls(ssl.create_default_context(cafile=str(cert)), server_hostname="localhost")

                    async def probe(marker):
                        request = (f"GET /probe/{marker} HTTP/1.1\r\nHost: localhost:{target_port}\r\n"
                                   "Connection: keep-alive\r\n\r\n")
                        writer.write(request.encode("ascii"))
                        await writer.drain()
                        assert (await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200 ")
                        assert await reader.readexactly(32) == marker.encode("ascii")

                    await probe(first)
                    initial = lab.observe(first, variant.source, started, time.time_ns(), variant)
                    # The controller can wait for both Runner confirmations without sending traffic.
                    await asyncio.sleep(46)
                    resumed_at = time.time_ns()
                    await probe(second)
                    resumed = lab.observe(second, variant.source, resumed_at, time.time_ns())
                    assert resumed["connection_id"] == initial["connection_id"]
                finally:
                    writer.close()
                    await asyncio.gather(writer.wait_closed(), return_exceptions=True)
        finally:
            target.shutdown()
            worker.join(timeout=5)


async def proxy_request(scheme, proxy_port, target_port, credential, client_tls, *, sni="localhost", methods=None):
    reader, writer = await asyncio.open_connection(
        "127.0.0.1", proxy_port, ssl=client_tls, server_hostname=sni if client_tls else None,
    )
    try:
        if scheme == "socks5":
            if methods is None:
                methods = b"\x02" if credential else b"\x00"
            writer.write(bytes([5, len(methods)]) + methods)
            assert await reader.readexactly(2) == (b"\x05\x02" if credential else b"\x05\x00")
            if credential:
                writer.write(b"\x01" + b"".join(bytes([len(value)]) + value for value in credential))
                assert await reader.readexactly(2) == b"\x01\x00"
            writer.write(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + target_port.to_bytes(2, "big"))
            assert (await reader.readexactly(10))[:2] == b"\x05\x00"
        else:
            writer.write(http_connect_request(target_port, credential))
            assert (await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200 ")
        writer.write(b"probe")
        await writer.drain()
        assert await reader.readexactly(5) == b"reply"
    finally:
        writer.close()
        await writer.wait_closed()


async def echo_probe(reader, writer):
    try:
        if await reader.readexactly(5) == b"probe":
            writer.write(b"reply")
            await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


@pytest.mark.parametrize("label", VARIANTS)
async def test_managed_first_hop_observes_real_proxy_negotiation(tmp_path, local_tls, label):
    scheme, mode = label.split("-")
    credential = (b"synthetic-user", b"synthetic-password") if mode == "credential" else None
    cert, key = local_tls
    server_tls = proxy_tls(cert, key) if scheme == "https" else None
    client_tls = ssl.create_default_context(cafile=str(cert)) if server_tls else None
    log = tmp_path / "proxy.jsonl"
    target = await asyncio.start_server(echo_probe, "127.0.0.1", 0)
    target_port = target.sockets[0].getsockname()[1]
    with log.open("wb") as stream:
        fixture = AcceptanceProxy(label, frozenset({"127.0.0.1"}), frozenset({("127.0.0.1", target_port)}),
                                  stream.fileno(), credential)
        proxy = await asyncio.start_server(fixture.handle, "127.0.0.1", 0, ssl=server_tls)
        async with target, proxy, asyncio.timeout(5):
            port = proxy.sockets[0].getsockname()[1]
            expected = ProxyVariant(label, f"{scheme}://localhost:{port}", "127.0.0.1", log, None)
            lab = make_lab(target_port, log, {label: expected})
            start = time.time_ns()
            await proxy_request(scheme, port, target_port, credential, client_tls)
            end = time.time_ns()
            lab.observe_connect(expected, target_port, start, end, end)
            other_label = "http-credential" if label == "http-anonymous" else "http-anonymous"
            other_log = tmp_path / "other.jsonl"
            other_log.touch()
            other = ProxyVariant(other_label, "http://other.example", "127.0.0.1", other_log, None)
            wrong_listener_lab = make_lab(target_port, log, {label: expected, other_label: other})
            with pytest.raises(AssertionError, match="selected listener"):
                wrong_listener_lab.observe_connect(other, target_port, start, end, end)
            with pytest.raises(AssertionError, match="exactly one first-hop"):
                lab.observe_connect(expected, target_port, end + 1, end + 1, time.time_ns())
            with pytest.raises(AssertionError, match="unexpected new first-hop CONNECT"):
                lab.observe_connect(None, target_port, start, end, end)

            if label == "socks5-credential":
                start = time.time_ns()
                await proxy_request(scheme, port, target_port, credential, client_tls, methods=b"\x00\x02")
                end = time.time_ns()
                with pytest.raises(AssertionError, match="offer and select"):
                    lab.observe_connect(expected, target_port, start, end, end)
            if scheme == "https":
                start = time.time_ns()
                await proxy_request(scheme, port, target_port, credential, client_tls, sni="alias.example")
                end = time.time_ns()
                with pytest.raises(AssertionError, match="registered proxy hostname"):
                    lab.observe_connect(expected, target_port, start, end, end)

    for secret in credential or ():
        assert secret not in log.read_bytes()


@pytest.mark.parametrize(("mode", "outcome"), [
    ("wrong-credential", "auth_rejected"),
    ("stall", "negotiation_stalled"),
    ("malformed", "malformed_reply"),
])
async def test_managed_proxy_fault_observed_before_upstream_connection(tmp_path, mode, outcome):
    unexpected = asyncio.Event()

    async def watch_upstream(reader, writer):
        unexpected.set()
        writer.close()
        await writer.wait_closed()

    credential = (b"synthetic-user", b"synthetic-password")
    target = await asyncio.start_server(watch_upstream, "127.0.0.1", 0)
    target_address = target.sockets[0].getsockname()
    control = await asyncio.start_server(echo_probe, "127.0.0.1", 0)
    control_address = control.sockets[0].getsockname()
    log = tmp_path / "fault.jsonl"
    with log.open("wb") as stream:
        fixture = AcceptanceProxy(
            "http-credential", frozenset({"127.0.0.1"}), frozenset({target_address, control_address}),
            stream.fileno(), credential,
            fault=None if mode == "wrong-credential" else mode, fault_destination=target_address,
        )
        proxy = await asyncio.start_server(fixture.handle, "127.0.0.1", 0)
        async with target, control, proxy, asyncio.timeout(5):
            proxy_port = proxy.sockets[0].getsockname()[1]
            await proxy_request("http", proxy_port, control_address[1], credential, None)
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            try:
                client = (credential[0], b"different-password") if mode == "wrong-credential" else credential
                writer.write(http_connect_request(target_address[1], client))
                await writer.drain()
                if mode == "stall":
                    with pytest.raises(TimeoutError):
                        await asyncio.wait_for(reader.read(1), timeout=0.1)
                else:
                    response = await reader.readuntil(b"\r\n\r\n")
                    expected = b"HTTP/1.1 407 " if mode == "wrong-credential" else b"fixture invalid CONNECT response"
                    assert response.startswith(expected)
            finally:
                writer.close()
                await writer.wait_closed()
            await proxy_request("http", proxy_port, control_address[1], credential, None)

        assert not unexpected.is_set()
    before, event, after = (json.loads(line) for line in log.read_text().splitlines())
    assert [before["outcome"], event["outcome"], after["outcome"]] == ["connected", outcome, "connected"]
    assert (event["destination_ip"], event["destination_port"]) == target_address
    assert event["authenticated"] is (mode != "wrong-credential")
    variant = ProxyVariant(fixture.variant, f"http://localhost:{proxy_port}", "127.0.0.1", log, None)
    lab = make_lab(target_address[1], log, {variant.listener: variant})
    lab.observe_connect(variant, target_address[1], before["time_ns"], event["time_ns"], after["time_ns"], outcome=outcome)
    assert all(value not in log.read_bytes() for value in (*credential, b"different-password"))
