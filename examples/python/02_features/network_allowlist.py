#!/usr/bin/env python3
"""
Network Allowlist Example — Connect-Time Egress Filtering

Demonstrates NetworkSpec for controlling outbound network access:
  1. Default (Enabled, empty allow_net): full internet access
  2. Allowlist: every name resolves; only listed hosts can be connected to
  3. Disabled: no network interface at all
  4. Explicitly enabled: same as default

Usage:
    make dev:python && python examples/python/02_features/network_allowlist.py
"""

import asyncio
import logging

import boxlite


async def test_default_full_access():
    """Test 1: Default = full internet access."""
    print("\n--- Test 1: Default (full access) ---")

    async with boxlite.SimpleBox(image="alpine:latest") as sandbox:
        # Any host should resolve
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup example.com: exit={result.exit_code}")
        assert result.exit_code == 0, f"should resolve, got exit={result.exit_code}"
        print("  result: resolved to real IP")

        result = await sandbox.exec("nslookup", "github.com")
        print(f"  nslookup github.com: exit={result.exit_code}")
        assert result.exit_code == 0
        print("  result: resolved to real IP")

        # Preflight for Test 2, which reads a failed connection to this host as
        # the allowlist refusing it. That only follows if the host answers when
        # nothing is filtering.
        result = await sandbox.exec(
            "wget", "-q", "-O-", "--timeout=5", "http://github.com/"
        )
        print(f"  wget http://github.com/: exit={result.exit_code}")
        assert result.exit_code == 0, "github.com must be reachable with full access"
        print("  result: connected")

    print("  PASS")


async def test_allowlist_filtering():
    """Test 2: Allowlist = every name resolves, only listed hosts connect."""
    print("\n--- Test 2: Allowlist (network.allow_net=[example.com]) ---")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        network=boxlite.NetworkSpec(mode="enabled", allow_net=["example.com"]),
    ) as sandbox:
        # Allowed host should resolve to real IP
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup example.com: exit={result.exit_code}")
        assert result.exit_code == 0, f"allowed host should resolve, got exit={result.exit_code}"
        print("  result: resolved to real IP (allowed)")

        # A non-allowed host still resolves: allow_net does not filter DNS.
        # It is refused when the sandbox tries to connect.
        result = await sandbox.exec("nslookup", "github.com")
        print(f"  nslookup github.com: exit={result.exit_code}")
        # Both halves: a failed lookup would also contain no "0.0.0.0".
        assert result.exit_code == 0 and "Address" in result.stdout, (
            "DNS is not filtered; the name must resolve"
        )
        assert "0.0.0.0" not in result.stdout, "the sinkhole answer is gone"
        print("  result: resolves to a real address (DNS is unrestricted)")

        # Control in the same box: the listed host really is reachable, so the
        # refusal below is the allowlist and not a broken network.
        result = await sandbox.exec(
            "wget", "-q", "-O-", "--timeout=5", "http://example.com/"
        )
        print(f"  wget http://example.com/: exit={result.exit_code}")
        assert result.exit_code == 0, "allowed host should be reachable"
        print("  result: connected (allowed)")

        # Test 1 already reached this host with full access, so the refusal
        # below is the allowlist and not a host that happens to be down.
        result = await sandbox.exec(
            "wget", "-q", "-O-", "--timeout=3", "http://github.com/"
        )
        print(f"  wget http://github.com/: exit={result.exit_code}")
        assert result.exit_code != 0, "non-allowed host should be refused at connect"
        print("  result: connection refused (blocked)")

    print("  PASS")


async def test_disabled_no_network():
    """Test 3: Disabled = no network at all."""
    print("\n--- Test 3: Disabled (no network) ---")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        network=boxlite.NetworkSpec(mode="disabled"),
    ) as sandbox:
        print("  box started without network")

        # Basic command should still work (no network needed)
        result = await sandbox.exec("echo", "hello from no-network box")
        print(f"  echo: exit={result.exit_code}, stdout={result.stdout.strip()}")
        assert result.exit_code == 0, "echo should work without network"
        assert "hello" in result.stdout

        # File operations should work
        result = await sandbox.exec("ls", "/")
        print(f"  ls /: exit={result.exit_code}")
        assert result.exit_code == 0, "ls should work without network"

        # DNS should fail (no network interface)
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup: exit={result.exit_code} (expected failure)")
        assert result.exit_code != 0, "nslookup should fail without network"

    print("  PASS")


async def test_enabled_explicit():
    """Test 4: Explicitly enabled."""
    print("\n--- Test 4: Explicitly enabled ---")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        network=boxlite.NetworkSpec(mode="enabled"),
    ) as sandbox:
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup example.com: exit={result.exit_code}")
        assert result.exit_code == 0
        print("  result: resolved")

    print("  PASS")


async def main():
    print("=" * 60)
    print("BoxLite Network Allowlist — Connect-Time Filtering Tests")
    print("=" * 60)
    print()
    print("NetworkSpec options:")
    print("  NetworkSpec(mode='enabled', allow_net=[])      -> full access")
    print("  NetworkSpec(mode='enabled', allow_net=[...])   -> restricted egress")
    print("  NetworkSpec(mode='disabled')                   -> no network at all")

    await test_default_full_access()
    await test_allowlist_filtering()
    await test_disabled_no_network()
    await test_enabled_explicit()

    print("\n" + "=" * 60)
    print("All tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.run(main())
