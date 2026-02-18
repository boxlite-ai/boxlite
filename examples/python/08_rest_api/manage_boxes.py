#!/usr/bin/env python3
"""
Box CRUD operations via the REST API.

Demonstrates:
- create() with a named box
- get() / get_info() to retrieve by ID or name
- get_or_create() for idempotent creation
- list_info() to enumerate all boxes
- remove() to delete a box

Prerequisites:
    make dev:python
    cd openapi/reference-server && uv run --active server.py --port 8080
"""

import asyncio

from boxlite import Boxlite, BoxOptions, BoxliteRestOptions


SERVER_URL = "http://localhost:8080"


def connect() -> Boxlite:
    return Boxlite.rest(BoxliteRestOptions(
        url=SERVER_URL, client_id="test-client", client_secret="test-secret",
    ))


async def main():
    print("=" * 50)
    print("REST API: Box Management (CRUD)")
    print("=" * 50)

    rt = connect()

    # --- Create ---
    print("\n=== Create ===")
    opts = BoxOptions(image="alpine:latest")
    box = await rt.create(opts, name="rest-crud-demo")
    box_id = box.id
    print(f"  Created box: {box_id}")

    # --- Get by ID ---
    print("\n=== Get Info by ID ===")
    info = await rt.get_info(box_id)
    print(f"  Found: id={info.id}  name={info.name}  status={info.state.status}")

    # --- Get handle by name ---
    print("\n=== Get Handle by Name ===")
    handle = await rt.get("rest-crud-demo")
    print(f"  Found by name: {handle.id}")

    # --- Get or Create (idempotent) ---
    print("\n=== Get or Create ===")
    box2, created = await rt.get_or_create(
        BoxOptions(image="alpine:latest"), name="rest-crud-demo",
    )
    print(f"  id={box2.id}  newly_created={created}")

    # --- List ---
    print("\n=== List ===")
    all_boxes = await rt.list_info()
    print(f"  Total boxes: {len(all_boxes)}")
    for b in all_boxes:
        marker = " <-- ours" if str(b.id) == str(box_id) else ""
        print(f"    {b.id}  {b.name or '(unnamed)'}  {b.state.status}{marker}")

    # --- Remove ---
    print("\n=== Remove ===")
    await rt.remove(box_id, force=True)
    print(f"  Removed {box_id}")

    # Verify removal
    info_after = await rt.get_info(box_id)
    print(f"  get_info after remove: {info_after}")

    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
