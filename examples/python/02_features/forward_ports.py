#!/usr/bin/env python3
"""
Port forwarding test — verify that a guest service is reachable from the host.

Starts a simple HTTP server inside a box on port 18789,
then curls it from the host on 127.0.0.1:18789.

Usage:
    python examples/python/port_forward_example.py
"""

import asyncio
import urllib.request

from boxlite import SimpleBox


async def main():
    async with SimpleBox(
        image="python:alpine",
        name="port-forward-test",
        ports=[(18789, 18789)],
        reuse_existing=True,
    ) as box:
        print(f"Box started: {box.id}")

        # Start a simple HTTP server on 0.0.0.0:18789 inside the guest.
        # It must bind to 0.0.0.0 (not 127.0.0.1) because gvproxy
        # forwards host traffic to the guest's network interface
        # (192.168.127.2), not to loopback.
        await box.exec(
            "sh", "-c",
            "nohup python -m http.server 18789 --bind 0.0.0.0 "
            "> /dev/null 2>&1 &"
        )
        await asyncio.sleep(1)  # let the server start

        # Verify from the host
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:18789/", timeout=5
            ) as resp:
                print(f"Host -> guest: HTTP {resp.status}")
        except Exception as e:
            print(f"Host -> guest FAILED: {e}")


if __name__ == "__main__":
    asyncio.run(main())
