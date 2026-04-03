"""
Integration tests for TCP-level AllowNet filtering with SNI/Host inspection.

These tests keep real internet coverage, but resolve live IPv4 targets at
runtime so they don't depend on stale hard-coded IPs.
"""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import socket

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
    return boxlite.NetworkSpec(mode="enabled", allow_net=list(allow_net))


def disabled_network():
    return boxlite.NetworkSpec(mode="disabled")


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

    if not _iter_ipv4_addresses(BLOCKED_HOST):
        raise RuntimeError(f"No IPv4 addresses resolved for {BLOCKED_HOST}")

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

    async def test_dns_resolves_any_host(self):
        """Any hostname should resolve to a real IP."""
        async with self.make_box() as box:
            result = await box.exec(
                "nslookup", self.live_targets.allowed_host, timeout=10
            )
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

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
# 2. Hostname-only allowlist — DNS sinkhole + TCP SNI/Host inspection
# ---------------------------------------------------------------------------


class TestHostnameAllowlist(TCPFilterTestBase):
    """allow_net with hostnames filters via DNS sinkhole + SNI/Host."""

    async def test_allowed_host_dns_resolves(self):
        """Allowed hostname should resolve to a real IP (not sinkholed)."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "nslookup", self.live_targets.allowed_host, timeout=10
            )
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

    async def test_blocked_host_dns_sinkholed(self):
        """Non-allowed hostname should be sinkholed to 0.0.0.0."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "nslookup", self.live_targets.blocked_host, timeout=10
            )
            assert "0.0.0.0" in result.stdout

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

    async def test_blocked_host_http_fails(self):
        """HTTP to a non-allowed host should fail (sinkholed DNS + TCP blocked)."""
        async with self.make_box(
            network=enabled_network(self.live_targets.allowed_host),
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                f"http://{self.live_targets.blocked_host}/",
                timeout=10,
            )
            assert result.exit_code != 0, "HTTP to blocked host should fail"


# ---------------------------------------------------------------------------
# 3. Wildcard hostname allowlist
# ---------------------------------------------------------------------------


class TestWildcardAllowlist(TCPFilterTestBase):
    """Wildcard patterns should match subdomains via SNI/Host."""

    async def test_wildcard_allows_subdomain_dns(self):
        """*.example.com should allow subdomains via DNS.

        The DNS sinkhole creates a wildcard zone for *.example.com.
        Subdomains should resolve (not sinkholed to 0.0.0.0).
        Note: nslookup may show "Parse error" for some wildcard responses
        depending on the DNS resolver implementation. We check the response
        doesn't contain 0.0.0.0 (sinkhole indicator).
        """
        async with self.make_box(network=enabled_network("*.example.com")) as box:
            result = await box.exec("nslookup", "www.example.com", timeout=10)
            # Wildcard DNS may not return clean nslookup output, but it should
            # NOT sinkhole the subdomain to 0.0.0.0
            assert "0.0.0.0" not in result.stdout, (
                f"wildcard subdomain should not be sinkholed, got: {result.stdout}"
            )

    async def test_wildcard_blocks_different_domain(self):
        """*.example.com should NOT match evil.com."""
        async with self.make_box(network=enabled_network("*.example.com")) as box:
            result = await box.exec("nslookup", "evil.com", timeout=10)
            assert "0.0.0.0" in result.stdout or result.exit_code != 0


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
        """Empty allow_net = full access (no filter)."""
        async with self.make_box(network=enabled_network()) as box:
            result = await box.exec(
                "nslookup", self.live_targets.allowed_host, timeout=10
            )
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

    async def test_multiple_allowed_hosts(self):
        """Multiple hostnames in allow_net should all be accessible."""
        async with self.make_box(
            network=enabled_network(
                self.live_targets.allowed_host,
                self.live_targets.second_allowed_host,
            ),
        ) as box:
            r1 = await box.exec("nslookup", self.live_targets.allowed_host, timeout=10)
            assert r1.exit_code == 0
            assert "0.0.0.0" not in r1.stdout

            r2 = await box.exec(
                "nslookup",
                self.live_targets.second_allowed_host,
                timeout=10,
            )
            assert r2.exit_code == 0
            assert "0.0.0.0" not in r2.stdout

            # Unlisted host should be blocked
            r3 = await box.exec("nslookup", self.live_targets.blocked_host, timeout=10)
            assert "0.0.0.0" in r3.stdout

    async def test_gateway_ip_always_reachable(self):
        """Gateway IP should always be reachable for DNS/DHCP.

        Even with restrictive allow_net, internal network must work.
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
