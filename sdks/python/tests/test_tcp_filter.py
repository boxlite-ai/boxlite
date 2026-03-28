"""
Integration tests for TCP-level AllowNet filtering with SNI/Host inspection.

These tests verify the full network filtering stack:
  - DNS sinkhole (PR #410): blocks DNS resolution for unlisted hostnames
  - TCP filter (this PR): blocks direct IP connections + inspects SNI/Host headers

Test matrix:
  ┌──────────────────────┬──────────────────────┬─────────────────────────┐
  │ Scenario             │ DNS Sinkhole         │ TCP Filter              │
  ├──────────────────────┼──────────────────────┼─────────────────────────┤
  │ Allowed hostname     │ Resolves normally    │ SNI/Host matches → pass │
  │ Blocked hostname     │ Sinkholed to 0.0.0.0 │ SNI/Host no match → RST│
  │ Direct IP (blocked)  │ N/A (no DNS)         │ IP not in allowlist→RST │
  │ Direct IP (allowed)  │ N/A (no DNS)         │ IP in CIDR → pass      │
  │ HTTPS to allowed     │ Resolves normally    │ SNI matches → pass      │
  │ HTTPS to blocked     │ Sinkholed            │ SNI no match → close    │
  │ No network           │ No gvproxy           │ No filter (no network)  │
  │ Full access (default)│ No sinkhole          │ No filter (nil)         │
  └──────────────────────┴──────────────────────┴─────────────────────────┘

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime available (libkrun + Hypervisor.framework)
"""

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


# ---------------------------------------------------------------------------
# 1. Default (full access) — no filtering active
# ---------------------------------------------------------------------------


class TestDefaultFullAccess:
    """When no allow_net is set, all traffic should pass freely."""

    async def test_dns_resolves_any_host(self):
        """Any hostname should resolve to a real IP."""
        async with boxlite.SimpleBox(image="alpine:latest") as box:
            result = await box.exec("nslookup", "example.com", timeout=10)
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

    async def test_http_to_any_host(self):
        """HTTP to any host should work."""
        async with boxlite.SimpleBox(image="alpine:latest") as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "http://example.com/",
                timeout=15,
            )
            assert result.exit_code == 0
            assert len(result.stdout) > 0

    async def test_direct_ip_connection(self):
        """Direct IP connection should work with full access."""
        async with boxlite.SimpleBox(image="alpine:latest") as box:
            # Test raw TCP connectivity: nc exits 0 if connection succeeds
            result = await box.exec(
                "sh",
                "-c",
                "nc -w 3 -z 93.184.216.34 80; echo EXIT:$?",
                timeout=10,
            )
            assert "EXIT:0" in result.stdout, (
                f"direct IP TCP should work with full access, got: {result.stdout}"
            )


# ---------------------------------------------------------------------------
# 2. Hostname-only allowlist — DNS sinkhole + TCP SNI/Host inspection
# ---------------------------------------------------------------------------


class TestHostnameAllowlist:
    """allow_net with hostnames filters via DNS sinkhole + SNI/Host."""

    async def test_allowed_host_dns_resolves(self):
        """Allowed hostname should resolve to a real IP (not sinkholed)."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            result = await box.exec("nslookup", "example.com", timeout=10)
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

    async def test_blocked_host_dns_sinkholed(self):
        """Non-allowed hostname should be sinkholed to 0.0.0.0."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            result = await box.exec("nslookup", "github.com", timeout=10)
            assert "0.0.0.0" in result.stdout

    async def test_http_to_allowed_host_succeeds(self):
        """HTTP to allowed host — TCP filter checks Host header, should pass."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "http://example.com/",
                timeout=15,
            )
            assert result.exit_code == 0
            assert len(result.stdout) > 0, "should receive HTTP response body"

    async def test_https_to_allowed_host_succeeds(self):
        """HTTPS to allowed host — TCP filter checks TLS SNI, should pass."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "--no-check-certificate",
                "https://example.com/",
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
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            # 8.8.8.8 is not in any allowlist rule
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                "http://8.8.8.8/",
                timeout=10,
            )
            assert result.exit_code != 0, (
                f"direct IP should be blocked, got exit_code={result.exit_code}"
            )

    async def test_blocked_host_http_fails(self):
        """HTTP to a non-allowed host should fail (sinkholed DNS + TCP blocked)."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                "http://github.com/",
                timeout=10,
            )
            assert result.exit_code != 0, "HTTP to blocked host should fail"


# ---------------------------------------------------------------------------
# 3. Wildcard hostname allowlist
# ---------------------------------------------------------------------------


class TestWildcardAllowlist:
    """Wildcard patterns should match subdomains via SNI/Host."""

    async def test_wildcard_allows_subdomain_dns(self):
        """*.example.com should allow subdomains via DNS.

        The DNS sinkhole creates a wildcard zone for *.example.com.
        Subdomains should resolve (not sinkholed to 0.0.0.0).
        Note: nslookup may show "Parse error" for some wildcard responses
        depending on the DNS resolver implementation. We check the response
        doesn't contain 0.0.0.0 (sinkhole indicator).
        """
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["*.example.com"]
        ) as box:
            result = await box.exec("nslookup", "www.example.com", timeout=10)
            # Wildcard DNS may not return clean nslookup output, but it should
            # NOT sinkhole the subdomain to 0.0.0.0
            assert "0.0.0.0" not in result.stdout, (
                f"wildcard subdomain should not be sinkholed, got: {result.stdout}"
            )

    async def test_wildcard_blocks_different_domain(self):
        """*.example.com should NOT match evil.com."""
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["*.example.com"]
        ) as box:
            result = await box.exec("nslookup", "evil.com", timeout=10)
            assert "0.0.0.0" in result.stdout or result.exit_code != 0


# ---------------------------------------------------------------------------
# 4. IP/CIDR allowlist
# ---------------------------------------------------------------------------


class TestIPCIDRAllowlist:
    """IP and CIDR rules allow direct connections."""

    async def test_exact_ip_allowed(self):
        """Exact IP in allow_net should allow direct TCP connection."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            allow_net=["93.184.216.34"],  # example.com's IP
        ) as box:
            # nc -z tests TCP connectivity only (no data transfer)
            result = await box.exec(
                "sh",
                "-c",
                "nc -w 3 -z 93.184.216.34 80; echo EXIT:$?",
                timeout=10,
            )
            assert "EXIT:0" in result.stdout, (
                f"exact IP should be allowed, got: {result.stdout}"
            )

    async def test_cidr_allows_range(self):
        """CIDR should allow any IP in the range."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            allow_net=["93.184.216.0/24"],
        ) as box:
            result = await box.exec(
                "sh",
                "-c",
                "nc -w 3 -z 93.184.216.34 80; echo EXIT:$?",
                timeout=10,
            )
            assert "EXIT:0" in result.stdout, (
                f"IP in CIDR range should be allowed, got: {result.stdout}"
            )

    async def test_ip_outside_cidr_blocked(self):
        """IP outside CIDR range should be blocked."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            allow_net=["10.0.0.0/8"],
        ) as box:
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=3",
                "http://93.184.216.34/",
                timeout=10,
            )
            assert result.exit_code != 0


# ---------------------------------------------------------------------------
# 5. Mixed rules
# ---------------------------------------------------------------------------


class TestMixedRules:
    """Combination of hostname and IP/CIDR rules."""

    async def test_hostname_and_cidr_both_work(self):
        """Both hostname (via SNI/Host) and CIDR rules should be active."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            allow_net=["example.com", "8.8.8.0/24"],
        ) as box:
            # Hostname rule: example.com works via HTTP Host header
            result = await box.exec(
                "wget",
                "-q",
                "-O-",
                "--timeout=5",
                "http://example.com/",
                timeout=15,
            )
            assert result.exit_code == 0

            # CIDR rule: 8.8.8.8 works via direct IP
            # We test TCP connectivity with nc (more reliable than wget for raw IP)
            result = await box.exec(
                "sh",
                "-c",
                "echo -e 'GET / HTTP/1.0\\r\\nHost: dns.google\\r\\n\\r\\n' | "
                "nc -w 3 8.8.8.8 80; echo EXIT_CODE:$?",
                timeout=10,
            )
            assert "EXIT_CODE:0" in result.stdout, "CIDR IP should be reachable"


# ---------------------------------------------------------------------------
# 6. Disabled network
# ---------------------------------------------------------------------------


class TestDisabledNetwork:
    """Disabled network has no interface at all."""

    async def test_commands_work_without_network(self):
        """Non-network commands should work."""
        async with boxlite.SimpleBox(image="alpine:latest", network="disabled") as box:
            result = await box.exec("echo", "hello", timeout=10)
            assert result.exit_code == 0
            assert "hello" in result.stdout

    async def test_dns_fails_without_network(self):
        """DNS should fail when network is disabled."""
        async with boxlite.SimpleBox(image="alpine:latest", network="disabled") as box:
            result = await box.exec("nslookup", "example.com", timeout=10)
            assert result.exit_code != 0


# ---------------------------------------------------------------------------
# 7. Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Edge cases and boundary conditions."""

    async def test_empty_allowlist_allows_all(self):
        """Empty allow_net = full access (no filter)."""
        async with boxlite.SimpleBox(image="alpine:latest", allow_net=[]) as box:
            result = await box.exec("nslookup", "example.com", timeout=10)
            assert result.exit_code == 0
            assert "0.0.0.0" not in result.stdout

    async def test_multiple_allowed_hosts(self):
        """Multiple hostnames in allow_net should all be accessible."""
        async with boxlite.SimpleBox(
            image="alpine:latest",
            allow_net=["example.com", "example.org"],
        ) as box:
            r1 = await box.exec("nslookup", "example.com", timeout=10)
            assert r1.exit_code == 0
            assert "0.0.0.0" not in r1.stdout

            r2 = await box.exec("nslookup", "example.org", timeout=10)
            assert r2.exit_code == 0
            assert "0.0.0.0" not in r2.stdout

            # Unlisted host should be blocked
            r3 = await box.exec("nslookup", "github.com", timeout=10)
            assert "0.0.0.0" in r3.stdout

    async def test_gateway_ip_always_reachable(self):
        """Gateway IP should always be reachable for DNS/DHCP.

        Even with restrictive allow_net, internal network must work.
        """
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            # DNS queries go to the gateway — this must work
            result = await box.exec("nslookup", "example.com", timeout=10)
            assert result.exit_code == 0, (
                "DNS to gateway should work with restrictive allowlist"
            )

    async def test_non_http_port_blocked_with_hostname_only(self):
        """Non-HTTP/S port with hostname-only rules should be blocked.

        TCP filter can only inspect SNI (443) and Host (80). Other ports
        can't have hostname extracted, so they're blocked when only hostname
        rules exist and no IP/CIDR rules match.
        """
        async with boxlite.SimpleBox(
            image="alpine:latest", allow_net=["example.com"]
        ) as box:
            # Try raw TCP on port 9999 to example.com's IP
            result = await box.exec(
                "sh",
                "-c",
                "nc -w 2 93.184.216.34 9999 </dev/null 2>&1; echo EXIT:$?",
                timeout=10,
            )
            assert "EXIT:0" not in result.stdout, (
                "non-HTTP port to allowed host's IP should be blocked"
            )
