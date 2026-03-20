#!/usr/bin/env python3
"""
Mount Host Directory Example

Demonstrates mounting a host directory into a container and listing its contents.
This is the simplest volume mount use case - share files between host and guest.
"""

import asyncio
import logging
import os
import sys
import tempfile

import boxlite

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)


async def main():
    print("Mount Host Directory Example")
    print("=" * 50)

    # Create a temp directory with some test files
    with tempfile.TemporaryDirectory() as tmp_dir:
        # Populate host directory
        for name in ["hello.txt", "data.csv", "config.json"]:
            path = os.path.join(tmp_dir, name)
            with open(path, "w") as f:
                f.write(f"content of {name}\n")

        os.makedirs(os.path.join(tmp_dir, "subdir"))
        with open(os.path.join(tmp_dir, "subdir", "nested.txt"), "w") as f:
            f.write("nested file\n")

        print(f"\nHost directory: {tmp_dir}")
        print(f"Host files: {os.listdir(tmp_dir)}")

        # Mount host dir into container at /workspace
        async with boxlite.SimpleBox(
            image="alpine:latest",
            volumes=[(tmp_dir, "/workspace")],
        ) as box:
            print(f"\nContainer: {box.id}")

            # List the mounted directory
            print("\n--- ls -la /workspace ---")
            result = await box.exec("ls", "-la", "/workspace")
            print(result.stdout)

            # Read a file
            print("--- cat /workspace/hello.txt ---")
            result = await box.exec("cat", "/workspace/hello.txt")
            print(result.stdout)

            # List nested directory
            print("--- ls /workspace/subdir ---")
            result = await box.exec("ls", "-la", "/workspace/subdir")
            print(result.stdout)

            # Write a file from inside the container
            print("--- Writing from container ---")
            await box.exec(
                "sh", "-c",
                "echo 'created inside container' > /workspace/from_guest.txt"
            )

            # Verify on host
            guest_file = os.path.join(tmp_dir, "from_guest.txt")
            if os.path.exists(guest_file):
                with open(guest_file) as f:
                    print(f"Host sees guest file: {f.read().strip()}")
            else:
                print("Guest file not found on host (unexpected)")

            # Show file ownership inside container
            print("\n--- File ownership inside container ---")
            result = await box.exec(
                "stat", "-c", "%n  uid=%u gid=%g",
                "/workspace/hello.txt"
            )
            print(result.stdout)

            result = await box.exec("id")
            print(f"Container user: {result.stdout.strip()}")

    print("\n" + "=" * 50)
    print("Done!")


if __name__ == "__main__":
    setup_logging()
    asyncio.run(main())
