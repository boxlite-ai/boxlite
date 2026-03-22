#!/usr/bin/env python3
"""
Secrets + Network Allowlist Example

Demonstrates Deno Sandbox-like security features:
- Secrets: OAuth token is NEVER exposed as env var inside the box
  - Guest sees placeholder: <BOXLITE_SECRET:CLAUDE_CODE_OAUTH_TOKEN>
  - Real value substituted transparently on HTTPS to approved hosts
- allowNet: Only approved hosts are reachable from inside the box
  - DNS queries for non-allowed hosts return NXDOMAIN
  - Direct IP connections are blocked

This is equivalent to Deno Sandbox's:
    const sandbox = await Sandbox.create({
        allowNet: ["claude.ai", "api.anthropic.com"],
        secrets: {
            CLAUDE_CODE_OAUTH_TOKEN: {
                hosts: ["claude.ai", "api.anthropic.com"],
                value: process.env.CLAUDE_CODE_OAUTH_TOKEN,
            },
        },
    });

Prerequisites:
    1. boxlite Python SDK installed (make dev:python)
    2. OAuth token set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"

Usage:
    CLAUDE_CODE_OAUTH_TOKEN="your-token" python secrets_and_allownet.py
"""

import asyncio
import logging
import os

import boxlite


async def main():
    print("=" * 60)
    print("BoxLite Security Example - Secrets + Network Allowlist")
    print("=" * 60)

    # Get the real token from host environment
    oauth_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    if not oauth_token:
        print("\nERROR: CLAUDE_CODE_OAUTH_TOKEN environment variable not set")
        print("Run: CLAUDE_CODE_OAUTH_TOKEN='your-token' python secrets_and_allownet.py")
        return

    runtime = await boxlite.BoxliteRuntime.create()

    # Create box with secrets + network allowlist
    #
    # This mirrors Deno Sandbox's security model:
    # - The OAuth token is a SECRET (not a regular env var)
    # - Only claude.ai and api.anthropic.com are reachable
    #
    opts = boxlite.BoxOptions(
        # Regular env vars (visible inside box)
        env=[("DISPLAY", ":1")],

        # Secrets: NEVER visible as env vars, substituted on HTTPS
        secrets={
            "CLAUDE_CODE_OAUTH_TOKEN": boxlite.SecretSpec(
                hosts=["claude.ai", "api.anthropic.com"],
                value=oauth_token,
            ),
        },

        # Network allowlist: only these hosts are reachable
        network=boxlite.NetworkSpec.Restricted(
            boxlite.NetworkPolicy(
                allow_net=[
                    "claude.ai",
                    "api.anthropic.com",
                    "*.anthropic.com",
                ]
            )
        ),
    )

    box = await runtime.create_box("alpine:latest", opts)
    await box.start()

    print(f"\nBox created: {box.id()}")

    # Demonstrate: env var shows placeholder, not real value
    print("\n--- Env var check ---")
    result = await box.run(
        boxlite.BoxCommand.new("sh").args(["-c", "echo $CLAUDE_CODE_OAUTH_TOKEN"])
    )
    run_result = await result.wait()
    print(f"$CLAUDE_CODE_OAUTH_TOKEN = {run_result.stdout.strip()}")
    print("  ^ This is the PLACEHOLDER, not the real token!")

    # Demonstrate: network allowlist blocks unauthorized hosts
    print("\n--- Network allowlist ---")

    # This should work (allowed host)
    result = await box.run(
        boxlite.BoxCommand.new("sh").args(["-c", "nslookup claude.ai 2>&1 | head -5"])
    )
    run_result = await result.wait()
    print(f"nslookup claude.ai: {run_result.stdout.strip()}")

    # This should fail (blocked host)
    result = await box.run(
        boxlite.BoxCommand.new("sh").args(["-c", "nslookup evil.com 2>&1 | head -5"])
    )
    run_result = await result.wait()
    print(f"nslookup evil.com: {run_result.stdout.strip()}")
    print("  ^ Blocked by DNS allowlist!")

    # Demonstrate: audit log captures everything
    print("\n--- Audit log ---")
    events = await box.audit_log()
    for event in events:
        print(f"  [{event.timestamp}] {event.kind}")

    await box.stop()

    print("\n" + "=" * 60)
    print("Security model summary:")
    print("  - Secrets never exposed as env vars (placeholder only)")
    print("  - Real value substituted on HTTPS to approved hosts")
    print("  - Non-allowed hosts blocked at DNS level")
    print("  - All operations audited")
    print("=" * 60)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.run(main())
