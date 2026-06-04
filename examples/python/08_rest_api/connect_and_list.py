#!/usr/bin/env python3
"""
Connect to a remote BoxLite server and list boxes.

Demonstrates:
- Creating a REST-backed runtime with BoxliteRestOptions
- API-key authentication via ApiKeyCredential
- Listing existing boxes

Prerequisites:
    make dev:python
    boxlite serve --port 8100
"""

import asyncio

from boxlite import ApiKeyCredential, Boxlite, BoxliteRestOptions


SERVER_URL = "http://localhost:8100"
API_KEY = "local-dev-key"  # reference server accepts any non-empty bearer


async def main():
    print("=" * 50)
    print("REST API: Connect and List Boxes")
    print("=" * 50)

    # Connect to the remote BoxLite server
    opts = BoxliteRestOptions(
        url=SERVER_URL,
        credential=ApiKeyCredential(API_KEY),
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
