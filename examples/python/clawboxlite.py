#!/usr/bin/env python3
"""
OpenClaw (ClawdBot/Moltbot) Example - AI Agent in BoxLite

Demonstrates running OpenClaw AI agent gateway in a BoxLite container:
- Custom OCI image with port forwarding
- Volume mounting for persistent config
- Environment variable configuration
- Service readiness polling
- Authentication setup for Claude API

Requires:
  pip install boxlite[sync]
  export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..."

Usage:
  python clawboxlite.py

Access:
  http://127.0.0.1:18789/chat?token=boxlite
"""

import json
import os
import time

import boxlite
from boxlite.sync_api import SyncBoxlite

# =============================================================================
# Configuration
# =============================================================================

HOME = os.environ.get("BOXLITE_HOME", "/tmp/boxlite-openclaw")
IMAGE = "ghcr.io/openclaw/openclaw:main"
DATA_DIR = os.path.join(HOME, "openclaw-data")

GATEWAY_PORT = 18789
GATEWAY_TOKEN = "boxlite"

# Claude API token from environment
CLAUDE_CODE_OAUTH_TOKEN = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

# OpenClaw gateway configuration
# - bind: "lan" to listen on all interfaces (required for VM port forwarding)
# - allowInsecureAuth: true for local development without device pairing
# - trustedProxies: allow connections from VM network ranges
OPENCLAW_CONFIG = {
    "gateway": {
        "port": GATEWAY_PORT,
        "mode": "remote",
        "bind": "lan",
        "controlUi": {
            "enabled": True,
            "allowInsecureAuth": True,
        },
        "auth": {
            "mode": "token",
            "token": GATEWAY_TOKEN,
        },
        "trustedProxies": [
            "0.0.0.0/0",
            "192.168.0.0/16",
            "172.16.0.0/12",
            "10.0.0.0/8",
        ],
    }
}


# =============================================================================
# Helper Functions
# =============================================================================


def write_openclaw_config(data_dir: str) -> str:
    """Write OpenClaw gateway configuration file."""
    config_path = os.path.join(data_dir, "openclaw.json")
    with open(config_path, "w") as f:
        json.dump(OPENCLAW_CONFIG, f, indent=2)
    return config_path


def write_auth_profiles(data_dir: str, token: str) -> str | None:
    """Write Claude API authentication profiles for OpenClaw agents."""
    if not token:
        return None

    agent_dir = os.path.join(data_dir, "agents", "main", "agent")
    os.makedirs(agent_dir, exist_ok=True)

    auth_profiles = {
        "version": 1,
        "profiles": {
            "anthropic:default": {
                "type": "api_key",
                "provider": "anthropic",
                "key": token,
            }
        },
    }

    auth_path = os.path.join(agent_dir, "auth-profiles.json")
    with open(auth_path, "w") as f:
        json.dump(auth_profiles, f, indent=2)
    return auth_path


def poll_ready(box, port: int, timeout: int = 300, interval: int = 2) -> bool:
    """Poll until the specified port is listening inside the container."""
    port_hex = f"{port:04X}"
    start = time.time()
    attempt = 0

    while time.time() - start < timeout:
        attempt += 1
        try:
            result = box.exec("cat", ["/proc/net/tcp"])
            lines = list(result.stdout())
            result.wait()
            tcp_out = "".join(
                line if isinstance(line, str) else line.decode("utf-8", errors="replace")
                for line in lines
            )

            if port_hex in tcp_out.upper():
                elapsed = time.time() - start
                print(f"  ✓ Port {port} ready after {elapsed:.1f}s")
                return True

            if attempt % 5 == 0:
                print(f"  ... waiting ({attempt * interval}s)")

        except Exception as e:
            print(f"  Poll error: {e}")

        time.sleep(interval)

    print(f"  ✗ Timeout after {timeout}s")
    return False


# =============================================================================
# Main
# =============================================================================


def main():
    """Run OpenClaw gateway in a BoxLite container."""
    print("OpenClaw (ClawdBot/Moltbot) via BoxLite")
    print("=" * 50)
    print(f"  Home:  {HOME}")
    print(f"  Image: {IMAGE}")
    print(f"  Port:  {GATEWAY_PORT}")
    print(f"  Token: {'configured' if CLAUDE_CODE_OAUTH_TOKEN else 'NOT SET'}")
    print("=" * 50)

    if not CLAUDE_CODE_OAUTH_TOKEN:
        print("\n⚠ Warning: CLAUDE_CODE_OAUTH_TOKEN not set")
        print("  Chat will not work without Claude API authentication.")
        print("  Set it with: export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-...'")

    # Prepare data directory and config files
    os.makedirs(DATA_DIR, exist_ok=True)

    config_path = write_openclaw_config(DATA_DIR)
    print(f"\n  Config: {config_path}")

    auth_path = write_auth_profiles(DATA_DIR, CLAUDE_CODE_OAUTH_TOKEN)
    if auth_path:
        print(f"  Auth:   {auth_path}")

    # Create and run the box
    options = boxlite.Options(home_dir=HOME)

    with SyncBoxlite(options) as runtime:
        box_opts = boxlite.BoxOptions(
            image=IMAGE,
            ports=[(GATEWAY_PORT, GATEWAY_PORT)],
            volumes=[(DATA_DIR, "/home/node/.openclaw")],
            env=[
                ("OPENCLAW_GATEWAY_BIND", "lan"),
                ("OPENCLAW_GATEWAY_PORT", str(GATEWAY_PORT)),
                ("OPENCLAW_GATEWAY_TOKEN", GATEWAY_TOKEN),
            ],
            cmd=[
                "node", "dist/index.js", "gateway",
                "--allow-unconfigured",
                "--bind", "lan",
                "--port", str(GATEWAY_PORT),
                "--token", GATEWAY_TOKEN,
            ],
            disk_size_gb=10,
            memory_mib=4096,
        )

        print("\nCreating box...")
        box = runtime.create(box_opts, name="openclaw")
        print(f"  Box ID: {box.id}")

        print(f"\nWaiting for port {GATEWAY_PORT}...")
        ready = poll_ready(box, GATEWAY_PORT, timeout=300, interval=2)

        if ready:
            print("\n" + "=" * 50)
            print("✓ OpenClaw gateway is ready!")
            print(f"\n  URL: http://127.0.0.1:{GATEWAY_PORT}/chat?token={GATEWAY_TOKEN}")
            print("=" * 50)

            print("\nPress Ctrl+C to stop...")
            try:
                while True:
                    time.sleep(60)
            except KeyboardInterrupt:
                print("\nShutting down...")
        else:
            print("\n✗ Gateway failed to start within timeout")

        box.stop()
        print("Done.")


if __name__ == "__main__":
    main()
