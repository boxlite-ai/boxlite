#!/usr/bin/env python3
"""
Network Allowlist Example — DNS Sinkhole Filtering

Demonstrates NetworkSpec for controlling outbound network access:
  1. Default (Enabled, empty allow_net): full internet access
  2. Allowlist: only allowed hosts resolve; others sinkholed to 0.0.0.0
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
        assert "0.0.0.0" not in result.stdout, "should NOT be sinkholed"
        print("  result: resolved to real IP")

        result = await sandbox.exec("nslookup", "github.com")
        print(f"  nslookup github.com: exit={result.exit_code}")
        assert result.exit_code == 0
        print("  result: resolved to real IP")

    print("  PASS")


async def test_allowlist_filtering():
    """Test 2: Allowlist = only listed hosts resolve, others sinkholed."""
    print("\n--- Test 2: Allowlist (allow_net=[example.com]) ---")

    async with boxlite.SimpleBox(
        image="alpine:latest", allow_net=["example.com"]
    ) as sandbox:
        # Allowed host should resolve to real IP
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup example.com: exit={result.exit_code}")
        assert result.exit_code == 0, f"allowed host should resolve, got exit={result.exit_code}"
        assert "0.0.0.0" not in result.stdout, "allowed host should NOT be sinkholed"
        print("  result: resolved to real IP (allowed)")

        # Non-allowed host should be sinkholed to 0.0.0.0
        result = await sandbox.exec("nslookup", "github.com")
        print(f"  nslookup github.com: exit={result.exit_code}")
        print(f"  stdout: {result.stdout.strip()[:200]}")
        # Sinkholed hosts resolve to 0.0.0.0
        assert "0.0.0.0" in result.stdout, f"non-allowed host should be sinkholed to 0.0.0.0"
        print("  result: sinkholed to 0.0.0.0 (blocked)")

    print("  PASS")


async def test_disabled_no_network():
    """Test 3: Disabled = no network at all."""
    print("\n--- Test 3: Disabled (no network) ---")

    async with boxlite.SimpleBox(image="alpine:latest", network="disabled") as sandbox:
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

    async with boxlite.SimpleBox(image="alpine:latest", network="enabled") as sandbox:
        result = await sandbox.exec("nslookup", "example.com")
        print(f"  nslookup example.com: exit={result.exit_code}")
        assert result.exit_code == 0
        print("  result: resolved")

    print("  PASS")


async def main():
    print("=" * 60)
    print("BoxLite Network Allowlist — DNS Sinkhole Tests")
    print("=" * 60)
    print()
    print("NetworkSpec options:")
    print("  Enabled { allow_net: [] }       -> full access (default)")
    print("  Enabled { allow_net: [hosts] }  -> DNS sinkhole for unlisted")
    print("  Disabled                        -> no network at all")

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
