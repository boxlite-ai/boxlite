"""
Integration tests for TCP-level AllowNet filtering with SNI/Host inspection.

These tests keep real internet coverage, but resolve live IPv4 targets at
runtime so they don't depend on stale hard-coded IPs.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass

import pytest

import boxlite

if not hasattr(boxlite, "NetworkSpec"):
    pytest.skip(
        "boxlite.NetworkSpec not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]

ALLOWED_HOST = "example.com"
SECONDARY_ALLOWED_HOST = "example.org"
BLOCKED_HOST = "github.com"
BLOCKED_IP_CANDIDATES = ("example.org", "github.com")
DEFAULT_TCP_PORT = 80
_UNSET = object()


def enabled_network(*allow_net: str):
    return boxlite.NetworkSpec(
        outbound=boxlite.OutboundNetworkSpec(
            mode="enabled",
            allow_net=list(allow_net),
        )
    )


def disabled_network():
    return boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="disabled"))


@dataclass(frozen=True)
class LiveTargets:
    allowed_host: str
    second_allowed_host: str
    blocked_host: str
    allowed_ip: str
    blocked_ip: str
    allowed_cidr: str


def _iter_ipv4_addresses(hostname: str) -> list[str]:
    seen: set[str] = set()
    addresses: list[str] = []
    for family, socktype, proto, _canonname, sockaddr in socket.getaddrinfo(
        hostname,
        DEFAULT_TCP_PORT,
        family=socket.AF_INET,
        type=socket.SOCK_STREAM,
    ):
        del family, socktype, proto
        ip = sockaddr[0]
        if ip not in seen:
            seen.add(ip)
            addresses.append(ip)
    return addresses


def _pick_reachable_ipv4(
    hostname: str,
    *,
    excluded_network: ipaddress.IPv4Network | None = None,
) -> str:
    candidates = _iter_ipv4_addresses(hostname)
    if not candidates:
        raise RuntimeError(f"No IPv4 addresses resolved for {hostname}")

    errors: list[str] = []
    for ip in candidates:
        if excluded_network and ipaddress.ip_address(ip) in excluded_network:
            continue
        try:
            with socket.create_connection((ip, DEFAULT_TCP_PORT), timeout=5):
                return ip
        except OSError as exc:
            errors.append(f"{ip}: {exc}")

    if excluded_network:
        raise RuntimeError(
            f"No reachable IPv4 addresses for {hostname} outside {excluded_network}. "
            f"Tried: {', '.join(errors) or 'no eligible addresses'}"
        )

    raise RuntimeError(
        f"No reachable IPv4 addresses for {hostname}. Tried: {', '.join(errors)}"
    )


@pytest.fixture(scope="module")
def live_targets() -> LiveTargets:
    allowed_ip = _pick_reachable_ipv4(ALLOWED_HOST)
    allowed_network = ipaddress.ip_network(f"{allowed_ip}/24", strict=False)

    # Fail early if our second allowed hostname is not resolvable.
    if not _iter_ipv4_addresses(SECONDARY_ALLOWED_HOST):
        raise RuntimeError(f"No IPv4 addresses resolved for {SECONDARY_ALLOWED_HOST}")

    # Connect, don't just resolve. Every negative test reads a failed
    # connection to BLOCKED_HOST as the allowlist refusing it, and an outage or
    # a closed port there fails exactly the same way — without this preflight
    # those tests stay green while filtering is broken.
    _pick_reachable_ipv4(BLOCKED_HOST)

    blocked_ip = None
    for candidate in BLOCKED_IP_CANDIDATES:
        try:
            candidate_ip = _pick_reachable_ipv4(
                candidate,
                excluded_network=allowed_network,
            )
        except RuntimeError:
            continue
        blocked_ip = candidate_ip
        break

    if blocked_ip is None:
        raise RuntimeError(
            f"Failed to find a reachable blocked host outside {allowed_network} "
            f"from candidates {BLOCKED_IP_CANDIDATES!r}"
        )

    return LiveTargets(
        allowed_host=ALLOWED_HOST,
        second_allowed_host=SECONDARY_ALLOWED_HOST,
        blocked_host=BLOCKED_HOST,
        allowed_ip=allowed_ip,
        blocked_ip=blocked_ip,
        allowed_cidr=str(allowed_network),
    )


class TCPFilterTestBase:
    shared_runtime: boxlite.Boxlite
    live_targets: LiveTargets

    @pytest.fixture(autouse=True)
    def _inject_fixtures(self, shared_runtime, live_targets):
        self.shared_runtime = shared_runtime
        self.live_targets = live_targets

    def make_box(self, *, network=_UNSET):
        kwargs = {
            "image": "alpine:latest",
            "runtime": self.shared_runtime,
        }
        if network is not _UNSET:
            kwargs["network"] = network
        return boxlite.SimpleBox(**kwargs)

    async def tcp_probe(self, box, ip: str, port: int = DEFAULT_TCP_PORT):
        return await box.exec(
            "sh",
            "-c",
            f"nc -w 3 -z {ip} {port}; echo EXIT:$?",
            timeout=10,
        )


# ---------------------------------------------------------------------------
# 1. Default (full access) — no filtering active
# ---------------------------------------------------------------------------


class TestDefaultFullAccess(TCPFilterTestBase):
    """When no allow_net is set, all traffic should pass freely."""

    async def test_http_to_any_host(self):
        """HTTP to any host should work."""
        async with self.make_box() as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=10",
                f"http://{self.live_targets.allowed_host}/",
                timeout=20,
            )
            assert result.exit_code == 0
            assert len(result.stdout) > 0

    async def test_direct_ip_connection(self):
        """Direct IP connection should work with full access."""
        async with self.make_box() as box:
            result = await self.tcp_probe(box, self.live_targets.allowed_ip)
            assert "EXIT:0" in result.stdout, (
                f"direct IP TCP should work with full access, got: {result.stdout}"
            )


# ---------------------------------------------------------------------------
# 2. Hostname-only allowlist — TCP SNI/Host inspection at connect time
# ---------------------------------------------------------------------------


class TestHostnameAllowlist(TCPFilterTestBase):
    """allow_net with hostnames is enforced on SNI/Host when the gateway dials.

    DNS is not filtered: every name resolves, allowed or not. The control is
    whether the connection is made.
    """

    async def test_blocked_host_resolves_but_does_not_connect(self):
        """allow_net is enforced when the gateway dials, not by DNS.

        A name outside the allowlist resolves normally — that is the contract
        now — and still cannot be reached. Two controls keep the final
        assertion honest: ``live_targets`` has already connected to the blocked
        endpoint from the host, and the allowed-host probe in the middle shows
        this box has a working network. Without them the test would also pass
        against a dead network, or against a host that is simply down.
        """
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            dns = await box.exec("nslookup", self.live_targets.blocked_host, timeout=10)
            # Both halves: a failed lookup also has no "0.0.0.0" in it.
            assert dns.exit_code == 0 and "Address" in dns.stdout, (
                f"DNS is unrestricted now; an unlisted name must resolve, "
                f"got exit={dns.exit_code} stdout={dns.stdout!r}"
            )
            assert "0.0.0.0" not in dns.stdout, "the sinkhole answer is gone"

            allowed = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                f"http://{self.live_targets.allowed_host}/",
                timeout=15,
            )
            assert allowed.exit_code == 0, "allowed host must stay reachable"

            blocked = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                f"http://{self.live_targets.blocked_host}/",
                timeout=10,
            )
            assert blocked.exit_code != 0, (
                "unlisted host must be refused at connect time"
            )

    async def test_http_to_allowed_host_succeeds(self):
        """HTTP to allowed host — TCP filter checks Host header, should pass."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                f"http://{self.live_targets.allowed_host}/",
                timeout=15,
            )
            assert result.exit_code == 0
            assert len(result.stdout) > 0, "should receive HTTP response body"

    async def test_https_to_allowed_host_succeeds(self):
        """HTTPS to allowed host — TCP filter checks TLS SNI, should pass."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "--no-check-certificate",
                f"https://{self.live_targets.allowed_host}/",
                timeout=15,
            )
            # Alpine's wget may not have TLS support (busybox wget)
            # If it does: should succeed
            # If not: should fail with TLS error, NOT connection refused
            if result.exit_code != 0:
                combined = result.stdout + result.stderr
                assert "refused" not in combined.lower(), (
                    f"HTTPS to allowed host should not be refused: {combined}"
                )

    async def test_direct_ip_blocked_with_hostname_only_rules(self):
        """Direct IP connection should be blocked when only hostname rules exist."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                f"http://{self.live_targets.allowed_ip}/",
                timeout=10,
            )
            assert result.exit_code != 0, (
                f"direct IP should be blocked, got exit_code={result.exit_code}"
            )


# ---------------------------------------------------------------------------
# 3. Wildcard hostname allowlist
# ---------------------------------------------------------------------------


class TestWildcardAllowlist(TCPFilterTestBase):
    """Wildcard patterns should match subdomains via SNI/Host."""

    async def test_wildcard_allows_subdomain_connection(self):
        """A subdomain under the wildcard must be reachable."""
        async with self.make_box(
            network=enabled_network("*.example.com"),
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "http://www.example.com/",
                timeout=15,
            )
            assert result.exit_code == 0, (
                f"subdomain under the wildcard should be reachable, "
                f"got exit_code={result.exit_code}"
            )

    async def test_wildcard_blocks_different_domain_connection(self):
        """A domain outside the wildcard must be refused when connecting.

        It still resolves — DNS is not filtered — so the assertion has to be
        about reachability, with the allowed subdomain as the in-box control
        and the ``live_targets`` preflight showing the blocked endpoint is up.
        """
        async with self.make_box(
            network=enabled_network("*.example.com"),
        ) as box:
            allowed = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "http://www.example.com/",
                timeout=15,
            )
            assert allowed.exit_code == 0, "the wildcard subdomain must be reachable"

            blocked = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                f"http://{self.live_targets.blocked_host}/",
                timeout=10,
            )
            assert blocked.exit_code != 0, (
                "a domain outside the wildcard must be refused at connect time"
            )


# ---------------------------------------------------------------------------
# 4. IP/CIDR allowlist
# ---------------------------------------------------------------------------


class TestIPCIDRAllowlist(TCPFilterTestBase):
    """IP and CIDR rules allow direct connections."""

    async def test_exact_ip_allowed(self):
        """Exact IP in allow_net should allow direct TCP connection."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_ip),
        ) as box:
            result = await self.tcp_probe(box, self.live_targets.allowed_ip)
            assert "EXIT:0" in result.stdout, (
                f"exact IP should be allowed, got: {result.stdout}"
            )

    async def test_cidr_allows_range(self):
        """CIDR should allow any IP in the range."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_cidr),
        ) as box:
            result = await self.tcp_probe(box, self.live_targets.allowed_ip)
            assert "EXIT:0" in result.stdout, (
                f"IP in CIDR range should be allowed, got: {result.stdout}"
            )

    async def test_ip_outside_cidr_blocked(self):
        """IP outside CIDR range should be blocked."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_cidr),
        ) as box:
            result = await self.tcp_probe(box, self.live_targets.blocked_ip)
            assert "EXIT:0" not in result.stdout, (
                f"IP outside CIDR range should be blocked, got: {result.stdout}"
            )


# ---------------------------------------------------------------------------
# 5. Mixed rules
# ---------------------------------------------------------------------------


class TestMixedRules(TCPFilterTestBase):
    """Combination of hostname and IP/CIDR rules."""

    async def test_hostname_and_cidr_both_work(self):
        """Both hostname (via SNI/Host) and CIDR rules should be active."""
        async with self.make_box(
            network=enabled_network(
                self.live_targets.allowed_host,
                self.live_targets.allowed_cidr,
            ),
        ) as box:
            # Hostname rule: example.com works via HTTP Host header
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                f"http://{self.live_targets.allowed_host}/",
                timeout=15,
            )
            assert result.exit_code == 0

            result = await self.tcp_probe(box, self.live_targets.allowed_ip)
            assert "EXIT:0" in result.stdout, "CIDR IP should be reachable"


# ---------------------------------------------------------------------------
# 6. Disabled network
# ---------------------------------------------------------------------------


class TestDisabledNetwork(TCPFilterTestBase):
    """Disabled network has no interface at all."""

    async def test_commands_work_without_network(self):
        """Non-network commands should work."""
        async with self.make_box(network=disabled_network()) as box:
            result = await box.exec("echo", "hello", timeout=10)
            assert result.exit_code == 0
            assert "hello" in result.stdout

    async def test_dns_fails_without_network(self):
        """DNS should fail when network is disabled."""
        async with self.make_box(network=disabled_network()) as box:
            result = await box.exec(
                "nslookup", self.live_targets.allowed_host, timeout=10
            )
            assert result.exit_code != 0


# ---------------------------------------------------------------------------
# 7. Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases(TCPFilterTestBase):
    """Edge cases and boundary conditions."""

    async def test_empty_allowlist_allows_all(self):
        """Empty allow_net = full access.

        Asserted with a direct-IP connection, which is exactly what a non-empty
        allowlist forbids and what a name lookup cannot distinguish now that
        DNS is unfiltered.
        """
        async with self.make_box(network=enabled_network()) as box:
            result = await self.tcp_probe(box, self.live_targets.allowed_ip)
            assert "EXIT:0" in result.stdout, (
                f"empty allow_net must permit a direct-IP connection, "
                f"got: {result.stdout}"
            )

    async def test_multiple_allowed_hosts(self):
        """Every hostname in allow_net is reachable, and nothing else is."""
        async with self.make_box(
            network=enabled_network(
                self.live_targets.allowed_host,
                self.live_targets.second_allowed_host,
            ),
        ) as box:
            for host in (
                self.live_targets.allowed_host,
                self.live_targets.second_allowed_host,
            ):
                r = await box.exec(
                    "wget",
                    "-q",
                    "-O-",
                    "--timeout=5",
                    f"http://{host}/",
                    timeout=15,
                )
                assert r.exit_code == 0, f"listed host {host} must be reachable"

            blocked = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                f"http://{self.live_targets.blocked_host}/",
                timeout=10,
            )
            assert blocked.exit_code != 0, (
                "an unlisted host must be refused at connect time"
            )

    async def test_gateway_ip_always_reachable(self):
        """The gateway resolver answers regardless of allow_net.

        allow_net does not filter DNS, so this holds for any name; the point
        here is that a restrictive allowlist does not cut the box off from its
        own resolver.
        """
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            # DNS queries go to the gateway — this must work
            result = await box.exec(
                "nslookup", self.live_targets.allowed_host, timeout=10
            )
            assert result.exit_code == 0, (
                "DNS to gateway should work with restrictive allowlist"
            )

    async def test_non_http_port_blocked_with_hostname_only(self):
        """Non-HTTP/S port with hostname-only rules should be blocked.

        TCP filter can only inspect SNI (443) and Host (80). Other ports
        can't have hostname extracted, so they're blocked when only hostname
        rules exist and no IP/CIDR rules match.
        """
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await self.tcp_probe(box, self.live_targets.allowed_ip, port=9999)
            assert "EXIT:0" not in result.stdout, (
                "non-HTTP port to allowed host's IP should be blocked"
            )
