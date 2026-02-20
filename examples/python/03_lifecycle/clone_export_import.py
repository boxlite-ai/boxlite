#!/usr/bin/env python3
"""
Clone, Export, and Import Example (Local SDK)

Demonstrates:
- clone_box(): Clone a running box (auto-quiesce via PauseGuard)
- export(): Export a box to a portable .boxlite archive
- import_box(): Import an archive into a new box
- Data preservation across clone, export, and import
"""

import asyncio
import tempfile

import boxlite


async def test_clone_running_box():
    """Clone a running box and verify independence."""
    print("\n=== Test 1: Clone a Running Box ===")

    runtime = boxlite.Boxlite.default()
    source = None
    cloned = None

    try:
        # Create and start a box
        print("Creating source box...")
        source = await runtime.create(
            boxlite.BoxOptions(image="alpine:latest", auto_remove=False),
            name="clone-source",
        )
        print(f"  Source: {source.id}")

        # Write a marker file to verify clone has independent copy
        print("Writing marker file in source...")
        exec_handle = await source.exec("sh", ["-c", "echo 'source-data' > /root/marker.txt"])
        result = await exec_handle.wait()
        assert result.exit_code == 0, "Failed to write marker"

        # Clone while running — PauseGuard auto-pauses/resumes the VM
        print("Cloning running box...")
        cloned = await source.clone_box(name="clone-target")
        print(f"  Cloned: {cloned.id}")

        # Source should still be running
        source_info = source.info()
        print(f"  Source state after clone: {source_info.state}")

        # Cloned box is stopped — start it and verify marker
        print("Starting cloned box...")
        exec_handle = await cloned.exec("cat", ["/root/marker.txt"])
        stdout = exec_handle.stdout()
        async for line in stdout:
            print(f"  Cloned box marker: {line.strip()}")
        result = await exec_handle.wait()
        assert result.exit_code == 0, "Marker file should exist in clone"

        # Write different data in clone to verify independence
        exec_handle = await cloned.exec("sh", ["-c", "echo 'clone-data' > /root/marker.txt"])
        result = await exec_handle.wait()

        # Verify source still has original data
        exec_handle = await source.exec("cat", ["/root/marker.txt"])
        stdout = exec_handle.stdout()
        async for line in stdout:
            assert "source-data" in line, "Source data should be unchanged"
            print(f"  Source marker (unchanged): {line.strip()}")
        await exec_handle.wait()

        print("  Clone is independent — source unaffected")

    finally:
        for box in [cloned, source]:
            if box is not None:
                try:
                    await box.stop()
                except Exception:
                    pass
                try:
                    await runtime.remove(box.id, force=True)
                except Exception:
                    pass

    print("  Test 1 passed")


async def test_export_import_roundtrip():
    """Export a box to archive and import it back, verifying data preservation."""
    print("\n\n=== Test 2: Export/Import Roundtrip ===")

    runtime = boxlite.Boxlite.default()
    source = None
    imported = None

    try:
        # Create box and write marker data
        print("Creating source box...")
        source = await runtime.create(
            boxlite.BoxOptions(image="alpine:latest", auto_remove=False),
            name="export-source",
        )
        print(f"  Source: {source.id}")

        print("Writing marker file...")
        exec_handle = await source.exec("sh", ["-c", "echo 'export-test-data' > /root/marker.txt"])
        result = await exec_handle.wait()
        assert result.exit_code == 0

        # Export while running — PauseGuard ensures consistent snapshot
        with tempfile.TemporaryDirectory() as export_dir:
            print(f"Exporting to {export_dir}...")
            archive_path = await source.export(dest=export_dir)
            print(f"  Archive: {archive_path}")

            # Source should still be running after export
            print(f"  Source state after export: {source.info().state}")

            # Import the archive
            print("Importing archive...")
            imported = await runtime.import_box(archive_path, name="imported-box")
            print(f"  Imported: {imported.id}")

            # Start imported box and verify marker file
            print("Verifying data in imported box...")
            exec_handle = await imported.exec("cat", ["/root/marker.txt"])
            stdout = exec_handle.stdout()
            found = False
            async for line in stdout:
                print(f"  Imported marker: {line.strip()}")
                if "export-test-data" in line:
                    found = True
            await exec_handle.wait()
            assert found, "Marker file should be preserved in imported box"

        print("  Data preserved across export/import")

    finally:
        for box in [imported, source]:
            if box is not None:
                try:
                    await box.stop()
                except Exception:
                    pass
                try:
                    await runtime.remove(box.id, force=True)
                except Exception:
                    pass

    print("  Test 2 passed")


async def test_clone_stopped_box():
    """Clone a stopped box."""
    print("\n\n=== Test 3: Clone a Stopped Box ===")

    runtime = boxlite.Boxlite.default()
    source = None
    cloned = None

    try:
        print("Creating and stopping source box...")
        source = await runtime.create(
            boxlite.BoxOptions(image="alpine:latest", auto_remove=False),
            name="clone-stopped",
        )

        # Start, write data, stop
        exec_handle = await source.exec("sh", ["-c", "echo 'stopped-clone' > /root/marker.txt"])
        await exec_handle.wait()
        await source.stop()
        print(f"  Source stopped: {source.id}")

        # Clone the stopped box
        print("Cloning stopped box...")
        cloned = await source.clone_box(name="cloned-stopped")
        print(f"  Cloned: {cloned.id}")

        # Start cloned box and verify data
        exec_handle = await cloned.exec("cat", ["/root/marker.txt"])
        stdout = exec_handle.stdout()
        async for line in stdout:
            print(f"  Cloned marker: {line.strip()}")
            assert "stopped-clone" in line
        await exec_handle.wait()

        print("  Stopped box cloned successfully")

    finally:
        for box in [cloned, source]:
            if box is not None:
                try:
                    await box.stop()
                except Exception:
                    pass
                try:
                    await runtime.remove(box.id, force=True)
                except Exception:
                    pass

    print("  Test 3 passed")


async def main():
    """Run all clone/export/import examples."""
    print("Clone, Export, and Import Examples (Local SDK)")
    print("=" * 60)
    print("\nThis example demonstrates:")
    print("  - clone_box(): Clone running or stopped boxes")
    print("  - export(): Export to portable .boxlite archive")
    print("  - import_box(): Import archive into new box")
    print("  - Data preservation across all operations")

    await test_clone_running_box()
    await test_export_import_roundtrip()
    await test_clone_stopped_box()

    print("\n" + "=" * 60)
    print("All clone/export/import examples completed!")
    print("\nKey Takeaways:")
    print("  - clone_box() works on running boxes (auto-quiesce via PauseGuard)")
    print("  - export() creates portable .boxlite archives")
    print("  - import_box() restores a box from an archive")
    print("  - Data written to rootfs is preserved across all operations")
    print("  - PauseGuard auto-quiesces the VM during export for consistency")


if __name__ == "__main__":
    asyncio.run(main())
