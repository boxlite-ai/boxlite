"""Configured Cloud observations for the managed outbound acceptance cases."""
from __future__ import annotations

import asyncio
from base64 import b64decode
from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from ipaddress import IPv4Address, IPv4Network, IPv6Address, ip_address
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.parse import urlsplit
from uuid import UUID

from preview import http, require


@dataclass(frozen=True)
class ProxyVariant:
    listener: str
    endpoint: str
    source: str
    observations: Path
    credential_file: Path | None


@dataclass(frozen=True)
class DNSObservations:
    origin: str
    address: str
    zone: str
    guest_business_ip: str
    answer_ipv6: str
    doh_log: Path
    runner_log: Path
    runner_source: str
    stalled_proxy: ProxyVariant

    @classmethod
    def load(cls, config, variants):
        origin = checked_url(config["url"], "https", path_allowed=True)
        require(urlsplit(origin).path == "/dns-query", "configure the pinned DoH /dns-query URL")
        entry = config["stalled_proxy"]
        stalled = ProxyVariant("https-anonymous", checked_url(entry["endpoint"], "https", path_allowed=False),
                               str(ip_address(entry["source"])), observation_path(entry["proxy_log"]), None)
        require(all(stalled.endpoint != variant.endpoint and stalled.observations != variant.observations
                    for variant in variants.values()), "the stalled DoH proxy requires its own listener and log")
        logs = [observation_path(config[key]) for key in ("doh_log", "runner_log")]
        require(logs[0] != logs[1], "DoH and Runner DNS require independent observation logs")
        zone = config["zone"].rstrip(".").lower()
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        require(len(zone) <= 198 and re.fullmatch(rf"{label}(?:\.{label})+", zone) is not None,
                "configure a dedicated DNS test zone")
        return cls(origin, str(IPv4Address(config["address"])), zone, str(IPv4Address(config["guest_business_ip"])),
                   str(IPv6Address(config["answer_ipv6"])), *logs, str(IPv4Address(config["runner_source"])), stalled)


@dataclass(frozen=True)
class PacketCapture:
    log: Path
    kind: str
    address: str
    port: int
    peer: str = ""

    async def packets(self, started, completed):
        async with asyncio.timeout(8):
            while True:
                rows = list(observation_rows(self.log))
                if rows:
                    require(rows[0].get("event") == "start" and rows[0].get("live") is True
                            and rows[0].get("kind") == self.kind and rows[0].get("address") == self.address
                            and rows[0].get("port") == self.port and rows[0].get("peer") == self.peer
                            and rows[0]["time_ns"] <= started,
                            "Packet capture did not start live on the expected tuple before the probe")
                if any(row.get("event") == "drained" and row["time_ns"] >= completed for row in rows):
                    break
                await asyncio.sleep(0.2)
        checkpoints = [row for row in rows if row.get("event") == "drained"]
        require(all(row.get("kernel_drops") == row.get("interface_drops") == 0 for row in checkpoints),
                "Packet capture reported packet loss")
        checkpoints = [rows[0]["time_ns"], *(row["time_ns"] for row in checkpoints)]
        require(all(0 <= after - before <= 2_000_000_000 for before, after in zip(checkpoints, checkpoints[1:])
                    if before <= completed and after >= started), "Packet capture has a gap during the probe window")
        return [row["time_ns"] for row in rows if row.get("event") == "packet" and started <= row["time_ns"] <= completed]


@dataclass(frozen=True)
class ProtectedTarget:
    address: str
    origin: str
    source: str
    target_log: Path
    capture: PacketCapture

    @classmethod
    def load(cls, config, public_ip, logs):
        address = IPv4Address(config["address"])
        private_ranges = (IPv4Network("10.0.0.0/8"), IPv4Network("172.16.0.0/12"), IPv4Network("192.168.0.0/16"))
        require(str(address) != public_ip and any(address in prefix for prefix in private_ranges)
                and address not in IPv4Network("192.168.127.0/24"), "configure a separate owned RFC1918 HTTPS target")
        origin = checked_url(config["origin"], "https", path_allowed=False)
        source = str(IPv4Address(config["source"]))
        target_log, capture_log = (observation_path(config[key]) for key in ("target_log", "capture_log"))
        require(len({*logs, target_log, capture_log}) == len(logs) + 2,
                "the protected target requires separate HTTPS and SYN logs")
        capture_ip = str(IPv4Address(config.get("capture_address", str(address))))
        return cls(str(address), origin, source, target_log,
                   PacketCapture(capture_log, "syn", capture_ip, urlsplit(origin).port or 443))


@dataclass(frozen=True)
class UdpUnbindObservations:
    release_dir: Path
    unlisted_address: str
    unlisted_port: int
    unlisted_log: Path
    unlisted_capture: PacketCapture

    @classmethod
    def load(cls, config, allowed_address, target_log):
        release = Path(config["release_dir"]).resolve()
        require(release.is_dir() and os.access(release, os.W_OK), "configure a writable private UDP release directory")
        address = str(IPv4Address(config["unlisted_address"]))
        require(address != allowed_address, "unlisted UDP target needs a different IPv4 address from the allowlist")
        port = config["unlisted_port"]
        require(type(port) is int and 1 <= port <= 65535, "invalid unlisted UDP target port")
        log, capture = (observation_path(config[key]) for key in ("unlisted_log", "unlisted_capture_log"))
        require(len({target_log, log, capture}) == 3, "unlisted UDP destination needs independent listener and capture logs")
        capture_ip = str(IPv4Address(config.get("unlisted_capture_address", address)))
        return cls(release, address, port, log, PacketCapture(capture, "udp", capture_ip, port))


@dataclass(frozen=True)
class ExternalUdpObservations:
    dns_address: str
    dns_port: int
    dns_log: Path
    dns_capture: PacketCapture
    quic_address: str
    quic_origin: str
    quic_log: Path
    quic_capture: PacketCapture

    @classmethod
    def load(cls, config, dns, existing_udp):
        require(dns is not None, "external DNS acceptance needs the configured acceptance DNS zone")
        dns_address = str(IPv4Address(config["dns_address"]))
        dns_port = config["dns_port"]
        require(type(dns_port) is int and 1 <= dns_port <= 65535, "invalid external DNS port")
        quic_origin = checked_url(config["quic_origin"], "https", path_allowed=False)
        quic_address = str(IPv4Address(config["quic_address"]))
        quic_port = urlsplit(quic_origin).port or 443
        require(len({existing_udp, (dns_address, dns_port), (quic_address, quic_port)}) == 3,
                "UDP echo, external DNS and QUIC need separate destination tuples")
        dns_log, quic_log = (observation_path(config[key]) for key in ("dns_log", "quic_log"))
        dns_capture_log, quic_capture_log = (observation_path(config[key]) for key in ("dns_capture_log", "quic_capture_log"))
        require(len({dns.runner_log, dns.doh_log, dns_log, quic_log, dns_capture_log, quic_capture_log}) == 6,
                "external UDP requires independent application and packet observation logs")
        dns_capture_ip = str(IPv4Address(config.get("dns_capture_address", dns_address)))
        quic_capture_ip = str(IPv4Address(config.get("quic_capture_address", quic_address)))
        return cls(dns_address, dns_port, dns_log, PacketCapture(dns_capture_log, "udp", dns_capture_ip, dns_port),
                   quic_address, quic_origin, quic_log, PacketCapture(quic_capture_log, "udp", quic_capture_ip, quic_port))


@dataclass(frozen=True)
class NegotiationFaults:
    wrong_name_endpoint: str
    untrusted_proxy: ProxyVariant
    untrusted_fingerprint: str
    downgrade_proxy: ProxyVariant

    @classmethod
    def load(cls, config, variants):
        healthy_tls = next(variant for variant in variants if variant.listener == "https-anonymous")
        healthy_socks = next(variant for variant in variants if variant.listener == "socks5-credential")
        wrong_name = checked_url(config["wrong_name_endpoint"], "https", path_allowed=False)
        alias, healthy = urlsplit(wrong_name), urlsplit(healthy_tls.endpoint)
        require(alias.hostname != healthy.hostname and (alias.port or 443) == (healthy.port or 443),
                "wrong-name TLS probe needs a distinct name on the trusted listener's port")
        trust = config["untrusted_proxy"]
        untrusted = ProxyVariant("https-anonymous", checked_url(trust["endpoint"], "https", path_allowed=False),
                                 str(IPv4Address(trust["source"])), observation_path(trust["proxy_log"]), None)
        socks = config["downgrade_proxy"]
        downgrade = ProxyVariant("socks5-credential", checked_url(socks["endpoint"], "socks5", path_allowed=False),
                                 str(IPv4Address(socks["source"])), observation_path(socks["proxy_log"]),
                                 healthy_socks.credential_file)
        require(wrong_name not in {untrusted.endpoint, *(variant.endpoint for variant in variants)},
                "wrong-name alias must be unique to the identity probe")
        openssl = shutil.which("openssl")
        require(openssl is not None, "openssl is required to verify the untrusted fixture's leaf and hostname")
        certificate = trust["certificate_file"]
        result = subprocess.run([openssl, "verify", "-CAfile", trust["ca_file"], "-verify_hostname",
                                 urlsplit(untrusted.endpoint).hostname, certificate], capture_output=True, timeout=10)
        require(result.returncode == 0, "the untrusted test leaf must match its endpoint and verify with its fixture CA")
        result = subprocess.run([openssl, "x509", "-in", certificate, "-outform", "DER"], capture_output=True, timeout=10)
        require(result.returncode == 0 and result.stdout, "could not read the untrusted test leaf fingerprint")
        return cls(wrong_name, untrusted, sha256(result.stdout).hexdigest(), downgrade)


@dataclass(frozen=True)
class TcpFaultObservations:
    syn: PacketCapture
    refused: PacketCapture
    refused_proxy: ProxyVariant
    stalled_proxy: ProxyVariant
    malformed_proxy: ProxyVariant
    bad_credentials: Path
    negotiation: NegotiationFaults | None = None
    bridge_log_dir: Path | None = None

    @classmethod
    def load(cls, config, target_ip, target_origin, variants):
        def fault_listener(name):
            entry = config[name]
            return ProxyVariant("https-anonymous", checked_url(entry["endpoint"], "https", path_allowed=False),
                                str(IPv4Address(entry["source"])), observation_path(entry["proxy_log"]), None)

        stalled, malformed = fault_listener("stalled_proxy"), fault_listener("malformed_proxy")
        listeners = [*variants, stalled, malformed]
        negotiation = NegotiationFaults.load(config["negotiation"], listeners) if "negotiation" in config else None
        if negotiation is not None:
            listeners.extend((negotiation.untrusted_proxy, negotiation.downgrade_proxy))
        require(len({listener.observations for listener in listeners}) == len(listeners)
                and len({listener.endpoint for listener in listeners}) == len(listeners),
                "each TCP fault listener requires its own endpoint and observation log")
        refused_endpoint = checked_url(config["refused_endpoint"], "http", path_allowed=False)
        refused_url = urlsplit(refused_endpoint)
        refused_log = observation_path(config["refused_log"])
        syn_log = observation_path(config["syn_log"])
        require(refused_log != syn_log and refused_endpoint not in {listener.endpoint for listener in listeners},
                "closed-port evidence requires its own endpoint and log")
        refused_ip = str(IPv4Address(refused_url.hostname))
        refused = PacketCapture(refused_log, "rst", str(IPv4Address(config.get("refused_capture_address", refused_ip))),
                                refused_url.port or 80, str(IPv4Address(config["refused_peer"])))
        refused_proxy = ProxyVariant("http-anonymous", refused_endpoint, refused_ip, refused_log, None)
        syn_ip = str(IPv4Address(config.get("syn_capture_address", target_ip)))
        bridge_dir = Path(config["bridge_log_dir"]).resolve() if "bridge_log_dir" in config else None
        if bridge_dir is not None:
            require(bridge_dir.is_dir(), "configure the live per-Box shim log directory")
        return cls(PacketCapture(syn_log, "syn", syn_ip, urlsplit(target_origin).port or 443), refused,
                   refused_proxy, stalled, malformed, Path(config["bad_credentials"]), negotiation, bridge_dir)


@dataclass(frozen=True)
class ManagedOutboundLab:
    api_origin: str
    organization_prefix: str
    target_origin: str
    target_tcp_ip: str
    target_udp_ip: str
    target_udp_port: int
    target_log: Path
    direct_source: str
    inventory_url: str
    runner_origin: str
    runner_id: str
    postgres_service: str
    variants: dict[str, ProxyVariant]
    inventory_token: str = field(repr=False)
    runner_key: str = field(repr=False)
    workload_secret_file: Path | None = None
    dns: DNSObservations | None = None
    tcp_faults: TcpFaultObservations | None = None
    external_udp: ExternalUdpObservations | None = None
    protected_target: ProtectedTarget | None = None
    udp_unbind: UdpUnbindObservations | None = None

    @classmethod
    def load(cls, path):
        try:
            config = json.loads(Path(path).read_text())
            variants = {}
            for scheme in ("http", "https", "socks5"):
                for auth in ("anonymous", "credential"):
                    label = f"{scheme}-{auth}"
                    entry = config["variants"][label]
                    endpoint = checked_url(entry["endpoint"], scheme, path_allowed=False)
                    credential = Path(entry["credential_file"]) if auth == "credential" else None
                    if credential is not None:
                        read_credential(credential)
                    observations = Path(entry["proxy_log"]).resolve()
                    require(observations.is_file() and os.access(observations, os.R_OK),
                            f"proxy observation log for {label} is unavailable")
                    variants[label] = ProxyVariant(label, endpoint, str(ip_address(entry["source"])),
                                                   observations, credential)
            require(len({variant.observations for variant in variants.values()}) == len(variants),
                    "each proxy listener requires a separate observation log")
            require(len({variant.endpoint for variant in variants.values()}) == len(variants),
                    "each proxy listener requires a separate endpoint")
            direct = str(ip_address(config["direct_source"]))
            sources = {value.source for value in variants.values()}
            require(direct not in sources,
                    "expected direct and proxy sources must differ")
            require(len(sources) >= 2, "registry rotation requires two distinguishable proxy exits")
            service = config["postgres_service"]
            require(re.fullmatch(r"[A-Za-z0-9_-]+", service) is not None,
                    "provide the PostgreSQL service name for read-only acceptance state")
            require(shutil.which("psql") is not None, "psql is required for epoch lookup")
            target_log = Path(config["target_log"])
            require(target_log.is_file() and os.access(target_log, os.R_OK), "target observation log is unavailable")
            prefix = config["organization_prefix"]
            require(re.fullmatch(r"[A-Za-z0-9_-]+", prefix) is not None,
                    "provide the isolated acceptance organization's routing prefix")
            udp_port = config["target_udp_port"]
            require(type(udp_port) is int and 1 <= udp_port <= 65535, "invalid UDP target port")
            secret_file = config.get("workload_secret_file")
            dns_config = config.get("dns")
            dns = DNSObservations.load(dns_config, variants) if dns_config is not None else None
            tcp_config = config.get("tcp_faults")
            external_config = config.get("external_udp")
            target_origin = checked_url(config["target_origin"], "https", path_allowed=False)
            target_ip = str(IPv4Address(config["target_tcp_ip"]))
            target_udp_ip = str(IPv4Address(config["target_udp_ip"]))
            protected_config = config.get("protected_target")
            unbind_config = config.get("udp_unbind")
            lab = cls(
                api_origin=checked_url(config["api_origin"], "https", path_allowed=False),
                organization_prefix=prefix,
                target_origin=target_origin,
                target_tcp_ip=target_ip,
                target_udp_ip=target_udp_ip,
                target_udp_port=udp_port,
                target_log=target_log,
                direct_source=direct,
                inventory_url=checked_url(config["inventory_url"], "https", path_allowed=True),
                runner_origin=checked_url(config["runner_origin"], "https", path_allowed=False),
                runner_id=str(UUID(config["runner_id"])),
                postgres_service=service,
                variants=variants,
                inventory_token=os.environ["BOXLITE_E2E_MANAGED_INVENTORY_TOKEN"],
                runner_key=os.environ["BOXLITE_E2E_MANAGED_RUNNER_KEY"],
                workload_secret_file=Path(secret_file) if secret_file is not None else None,
                dns=dns,
                tcp_faults=TcpFaultObservations.load(
                    tcp_config, target_ip, target_origin, [*variants.values(), *([dns.stalled_proxy] if dns else [])],
                ) if tcp_config is not None else None,
                external_udp=ExternalUdpObservations.load(external_config, dns, (target_udp_ip, udp_port))
                if external_config is not None else None,
                protected_target=ProtectedTarget.load(protected_config, target_ip, {target_log.resolve()})
                if protected_config is not None else None,
                udp_unbind=UdpUnbindObservations.load(unbind_config, target_udp_ip, target_log.resolve())
                if unbind_config is not None else None,
            )
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise AssertionError(f"invalid managed outbound fixture configuration ({type(exc).__name__})") from None
        require(lab.inventory_token and lab.runner_key, "the acceptance Runner credentials are required")
        return lab

    async def preflight(self):
        for_runner = await http(self.inventory_url, headers={"Authorization": f"Bearer {self.inventory_token}"})
        require(for_runner.status == 200, f"Runner inventory returned HTTP {for_runner.status}")
        capability = await http(f"{self.runner_origin}/v1/outbound-proxy/bootstrap", headers=self.runner_headers())
        require(capability.status == 200, f"Runner protected capability returned HTTP {capability.status}")
        info = json.loads(capability.body)
        require(info.get("runner_id") == self.runner_id and info.get("version") == 1
                and "managed-route" in info.get("operations", []) and "unbound-start" in info.get("operations", []),
                "expected an enrolled HTTPS V0 Runner with managed and unbound bootstrap")

    def runner_headers(self):
        return {"Authorization": f"Bearer {self.runner_key}", "X-BoxLite-Runner-Id": self.runner_id,
                "Content-Type": "application/json"}

    async def readback(self, box, expected_proxy):
        inventory = await http(self.inventory_url, headers={"Authorization": f"Bearer {self.inventory_token}"})
        require(inventory.status == 200, f"Runner inventory returned HTTP {inventory.status}")
        matches = [item for item in json.loads(inventory.body) if item["id"] == box.id]
        require(len(matches) == 1, f"Box {box.id} was not assigned exactly once to the expected Runner")
        status = await box.network.managed_proxy_status()
        effective = status.get("installed")
        require(status.get("application_state") == "confirmed" and status.get("runtime_readback") == "authenticated"
                and isinstance(effective, dict) and "proxy" in effective and effective["proxy"] == expected_proxy
                and status.get("revision") == effective.get("policy_revision"),
                f"Box {box.id} lacks exact confirmed installed proxy status")

        epoch, binding, revision = await self.read_epoch(box.id)
        receipt = await http(f"{self.runner_origin}/v1/boxes/{box.id}/network/outbound/managed-route", "POST",
                             self.runner_headers(), json.dumps({"runner_id": self.runner_id, "epoch": epoch,
                                                                "command": {"operation": "inspect"}}).encode())
        require(receipt.status == 200, f"Runner inspect returned HTTP {receipt.status}")
        envelope = json.loads(receipt.body)
        require(envelope.get("box_id") == box.id and isinstance(envelope.get("receipt"), dict),
                "Runner inspect did not return a receipt for the requested Box")
        native = envelope["receipt"]
        installed = native.get("installed")
        require(native.get("runner_id") == self.runner_id and native.get("epoch") == epoch
                and "pending_attempt" in native and native["pending_attempt"] is None
                and "unbind_settlement" in native and native["unbind_settlement"] is None
                and isinstance(installed, dict) and installed == native.get("durable")
                and "binding" in installed and installed["binding"] == binding
                and (binding is None if expected_proxy is None else
                     isinstance(binding, dict) and binding.get("epoch") == epoch
                     and binding.get("registration_revision") == str(expected_proxy["revision"]))
                and installed["snapshot"]["revision"] == revision == effective["policy_revision"],
                f"Box {box.id} lacks matching authenticated installed and durable evidence")
        return epoch, revision

    async def read_epoch(self, box_id):
        # The read-only database lookup supplies the epoch required by Runner
        # inspect. The authenticated response establishes the installed state.
        query = '''
            SELECT json_build_array("runnerId", "outboundControl"->'managed'->>'epoch',
                "outboundControl"->'managed'->'binding', "outboundControl"->>'revision')
            FROM box WHERE id = :'box_id';
        '''
        assigned, epoch, binding, revision = await query_box_json(self.postgres_service, box_id, query)
        require(assigned == self.runner_id and isinstance(epoch, str) and bool(epoch),
                f"Box {box_id} has no managed epoch on the expected Runner")
        return epoch, binding, revision

    def observations(self, marker):
        return [row for row in observation_rows(self.target_log) if row.get("marker") == marker]

    def observe(self, marker, source, since, until, proxy=None, *, secret_matches=None, hostname=None):
        target = urlsplit(self.target_origin)
        matches = self.observations(marker)
        require(len(matches) == 1, "expected one independently observed HTTPS probe")
        observation, = matches
        authority = hostname or (target.hostname if target.port in (None, 443) else target.netloc)
        require(observation.get("protocol") == "https" and observation.get("source") == source
                and observation.get("host") == authority
                and observation.get("sni") == (hostname or target.hostname) and since <= observation["time_ns"] <= until,
                "target did not observe the expected source, Host and SNI in the probe window")
        self.observe_connect(proxy, target.port or 443, since, observation["time_ns"], until)
        if secret_matches is not None:
            require(observation.get("secret_matches") is secret_matches,
                    "target did not record the expected workload secret comparison")
        return observation

    def observe_connect(self, proxy, port, since, arrived, until, *, address=None, outcome="connected", count=1):
        target_ip = address or self.target_tcp_ip
        variants = set(self.variants.values())
        if self.dns is not None:
            variants.add(self.dns.stalled_proxy)
        if self.tcp_faults is not None:
            variants.update((self.tcp_faults.stalled_proxy, self.tcp_faults.malformed_proxy))
            if self.tcp_faults.negotiation is not None:
                negotiation = self.tcp_faults.negotiation
                variants.update((negotiation.untrusted_proxy, negotiation.downgrade_proxy))
        connects = []
        for variant in variants:
            for event in observation_rows(variant.observations):
                if (event.get("destination_ip") == target_ip and event.get("destination_port") == port
                        and since <= event["time_ns"] <= until):
                    connects.append((variant, event))
        if proxy is None:
            require(not connects, "unexpected new first-hop CONNECT during the probe")
            return
        message = "expected exactly one first-hop CONNECT for the probe" if count == 1 else "unexpected first-hop CONNECT count"
        require(len(connects) == count, message)
        scheme, mode = proxy.listener.split("-")
        uses_credentials = mode == "credential"
        authenticated = uses_credentials and outcome != "auth_rejected"
        auth = ("rfc1929" if scheme == "socks5" else "basic") if uses_credentials else "none"
        for listener, event in connects:
            require(listener == proxy and event.get("listener") == proxy.listener and event.get("scheme") == scheme
                    and event.get("method") == "CONNECT" and event.get("outcome") == outcome
                    and event["time_ns"] <= arrived,
                    "first-hop CONNECT did not match the selected listener, protocol and destination")
            require(event.get("auth") == auth and event.get("authenticated") is authenticated,
                    "first-hop authentication did not match the registered proxy variant")
            if outcome == "auth_rejected" and auth == "basic":
                require(event.get("basic_header_present") is True, "the rejected CONNECT omitted its Basic credential")
            if scheme == "socks5":
                method = 2 if authenticated else 0
                require(event.get("offered_methods") == [method] and event.get("selected_method") == method,
                        "SOCKS5 did not offer and select the expected authentication method")
            if scheme == "https":
                require(event.get("sni") == urlsplit(proxy.endpoint).hostname,
                        "TLS CONNECT did not use the registered proxy hostname as SNI")


async def query_box_json(service, box_id, query):
    require(re.fullmatch(r"[A-Za-z0-9]{12}", box_id) is not None, "invalid Cloud Box ID")
    return await query_postgres_json(service, "box_id", box_id, query)


async def query_postgres_json(service, variable, value, query):
    proc = await asyncio.create_subprocess_exec(
        "psql", "-XAtqw", "-v", "ON_ERROR_STOP=1", "-v", f"{variable}={value}",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={**os.environ, "PGSERVICE": service, "PGCONNECT_TIMEOUT": "5",
             "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=5000"},
    )
    try:
        output, _ = await asyncio.wait_for(proc.communicate(query.encode()), timeout=12)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    require(proc.returncode == 0 and output.strip(), "PostgreSQL evidence lookup failed")
    return json.loads(output)


def public_proxy_diagnostics(status):
    """Read the optional diagnostic on the confirmed public proxy state."""
    require(isinstance(status, dict), "public outbound status did not return an object")
    recognized = {"proxy_auth_failed", "proxy_unreachable", "proxy_timeout", "proxy_handshake_failed"}
    proxy = status.get("proxy")
    if not isinstance(proxy, dict) or "diagnostic" not in proxy:
        return set()
    diagnostic = proxy["diagnostic"]
    code = diagnostic.get("code") if isinstance(diagnostic, dict) else None
    require(isinstance(code, str) and code in recognized, "public proxy status returned an invalid diagnostic")
    return {code}


def bridge_messages(log_dir, box_id, since, until):
    require(re.fullmatch(r"[A-Za-z0-9]{12}", box_id) is not None, "invalid Box ID for shim log lookup")
    for path in (log_dir / box_id / "logs").glob("boxlite-shim.log.*"):
        with path.open() as stream:
            for line in stream:
                if not line.endswith("\n"):
                    continue
                stamp, separator, rest = line.partition(" ")
                _, target, message = rest.partition("gvproxy: ")
                if not separator or not target or not stamp.endswith("Z"):
                    continue
                try:
                    timestamp = int(datetime.fromisoformat(stamp).timestamp() * 1_000_000_000)
                except ValueError:
                    continue
                if since <= timestamp <= until:
                    yield message.strip()


async def require_bridge_message(log_dir, box_id, since, until, matches, error):
    require(log_dir is not None, "configure live per-Box shim logs for independent Runtime evidence")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if any(matches(message) for message in bridge_messages(log_dir, box_id, since, until)):
            return
        await asyncio.sleep(0.25)
    raise AssertionError(error)


def observation_path(value):
    path = Path(value).resolve()
    require(path.is_file() and os.access(path, os.R_OK), "acceptance observation log is unavailable")
    return path


def observation_rows(path):
    with path.open() as rows:
        for line in rows:
            if line.endswith("\n"):
                yield json.loads(line)


def checked_url(value, scheme, *, path_allowed):
    url = urlsplit(value)
    require(url.scheme == scheme and url.hostname and url.username is None and url.password is None
            and not url.query and not url.fragment and (path_allowed or url.path in ("", "/")),
            f"fixture URL must use {scheme} and omit credentials, query and fragment")
    require(url.port != 0, "fixture URL port must be nonzero")
    return value.rstrip("/")


def read_credential(path):
    require(path.is_file() and path.stat().st_mode & 0o077 == 0, "use a private proxy credential file")
    with path.open("rb") as stream:
        data = stream.read(4097)
    require(0 < len(data) <= 4096, "invalid proxy credential size")
    try:
        credential = json.loads(data)
    except ValueError:
        raise AssertionError("invalid proxy credential JSON") from None
    require(isinstance(credential, dict) and credential.keys() == {"username", "password"}
            and all(isinstance(value, str) and value for value in credential.values()),
            "expected nonempty proxy username and password")
    return data, credential


def read_workload_secret(path):
    require(path is not None and path.is_file() and path.stat().st_mode & 0o077 == 0,
            "configure a private workload_secret_file for the synthetic secret acceptance case")
    with path.open("rb") as stream:
        value = stream.read(258)
    require(re.fullmatch(rb"[A-Za-z0-9._~-]{16,256}\n?", value) is not None,
            "use a synthetic workload token with 16 to 256 URL-safe characters")
    return value.rstrip(b"\n").decode("ascii")


def require_redacted(stdout, stderr, secrets):
    require(all(value not in stream for value in secrets for stream in (stdout, stderr)),
            "Guest output disclosed a synthetic credential")


def verify_guest_inspection(stdout, stderr, marker, secrets):
    require_redacted(stdout, stderr, secrets)
    try:
        evidence = json.loads(stdout)
        require(isinstance(evidence, dict) and evidence.pop("complete", None) == marker
                and evidence.keys() == {"environment", "files", "process"},
                "Guest inspection is missing evidence or its completion marker")
        for records in evidence.values():
            require(isinstance(records, list) and records, "Guest inspection evidence is empty")
            for encoded in records:
                record = b64decode(encoded, validate=True)
                require(bool(record), "Guest inspection returned an empty record")
                require(all(value.encode() not in record for value in secrets),
                        "Guest inspection disclosed a synthetic credential")
    except (ValueError, TypeError):
        raise AssertionError("Guest inspection returned malformed evidence") from None
