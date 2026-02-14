#!/usr/bin/env python3
"""
Connect to a remote BoxLite server and list boxes.

Demonstrates:
- Creating a REST-backed runtime with BoxliteRestOptions
- OAuth2 authentication (automatic token management)
- Listing existing boxes

Prerequisites:
    make dev:python
    cd openapi/reference-server && uv run --active server.py --port 8080
"""

import asyncio

from boxlite import Boxlite, BoxliteRestOptions


SERVER_URL = "http://localhost:8080"
CLIENT_ID = "test-client"
CLIENT_SECRET = "test-secret"


async def main():
    print("=" * 50)
    print("REST API: Connect and List Boxes")
    print("=" * 50)

    # Connect to the remote BoxLite server
    opts = BoxliteRestOptions(
        url=SERVER_URL,
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
    )
    rt = Boxlite.rest(opts)
    print(f"\n  Connected to {SERVER_URL}")

    # List all boxes (may be empty on a fresh server)
    boxes = await rt.list_info()
    print(f"\n  Boxes on server: {len(boxes)}")
    for info in boxes:
        print(f"    - {info.id}  name={info.name}  status={info.state.status}")

    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
