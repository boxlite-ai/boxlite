#!/usr/bin/env python3
"""
Clone, Export, and Import via REST API

Demonstrates:
- clone_box(): Clone a box on a remote server
- export(): Download a .boxlite archive from the server
- import_box(): Upload an archive to create a new box

Prerequisites:
    make dev:python
    cd openapi/reference-server && uv run --active server.py --port 8080
"""

import asyncio
import tempfile

from boxlite import Boxlite, BoxOptions, BoxliteRestOptions


SERVER_URL = "http://localhost:8080"


def connect() -> Boxlite:
    return Boxlite.rest(BoxliteRestOptions(
        url=SERVER_URL, client_id="test-client", client_secret="test-secret",
    ))


async def test_clone():
    """Clone a box via REST."""
    print("\n=== Clone via REST ===")

    rt = connect()

    # Create source box
    source = await rt.create(
        BoxOptions(image="alpine:latest", auto_remove=False),
        name="rest-clone-source",
    )
    print(f"  Source: {source.id}")

    # Clone it
    cloned = await source.clone_box(name="rest-clone-target")
    print(f"  Cloned: {cloned.id}")

    # Verify different IDs
    assert source.id != cloned.id, "Clone should have different ID"
    cloned_info = cloned.info()
    print(f"  Clone name: {cloned_info.name}")
    print(f"  Clone state: {cloned_info.state}")

    # Cleanup
    await rt.remove(cloned.id, force=True)
    await rt.remove(source.id, force=True)
    print("  Cleaned up")


async def test_export_import():
    """Export and import a box via REST."""
    print("\n\n=== Export/Import via REST ===")

    rt = connect()

    # Create and start source box
    source = await rt.create(
        BoxOptions(image="alpine:latest", auto_remove=False),
        name="rest-export-source",
    )
    print(f"  Source: {source.id}")

    # Export to a temp directory
    with tempfile.TemporaryDirectory() as export_dir:
        print(f"  Exporting to {export_dir}...")
        archive_path = await source.export(dest=export_dir)
        print(f"  Archive: {archive_path}")

        # Import the archive
        print("  Importing archive...")
        imported = await rt.import_box(archive_path, name="rest-imported")
        print(f"  Imported: {imported.id}")

        imported_info = imported.info()
        print(f"  Import name: {imported_info.name}")
        print(f"  Import state: {imported_info.state}")

        # Cleanup
        await rt.remove(imported.id, force=True)

    await rt.remove(source.id, force=True)
    print("  Cleaned up")


async def main():
    print("=" * 50)
    print("REST API: Clone, Export, and Import")
    print("=" * 50)

    await test_clone()
    await test_export_import()

    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
