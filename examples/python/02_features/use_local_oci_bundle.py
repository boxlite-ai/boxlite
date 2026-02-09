#!/usr/bin/env python3
"""
Example: Using a Local OCI Bundle with BoxLite

This example demonstrates how to use a pre-exported OCI image bundle
instead of pulling from a registry. This is useful for:
- Offline/air-gapped environments
- Custom base images
- Testing with specific image versions
- Avoiding network latency

Prerequisites:
1. Export an OCI image using Docker/Podman:
   ```
   # Using Docker
   docker pull alpine:latest
   docker save alpine:latest -o alpine.tar
   mkdir alpine-bundle
   tar -xf alpine.tar -C alpine-bundle

   # Or using skopeo (creates OCI layout directly)
   skopeo copy docker://alpine:latest oci:alpine-bundle:latest
   ```

2. The bundle should have this structure:
   ```
   alpine-bundle/
     oci-layout         # {"imageLayoutVersion": "1.0.0"}
     index.json         # Image index
     blobs/
       sha256/
         <manifest-hash>
         <config-hash>
         <layer-hash>...
   ```

Usage:
    python local_oci_bundle_example.py /path/to/alpine-bundle
"""

import asyncio
import sys
from pathlib import Path

from boxlite import Boxlite, BoxOptions


async def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nUsage: python local_oci_bundle_example.py /path/to/oci-bundle")
        sys.exit(1)

    bundle_path = Path(sys.argv[1]).resolve()

    # Validate the bundle structure
    if not (bundle_path / "oci-layout").exists():
        print(f"Error: {bundle_path} is not a valid OCI bundle (missing oci-layout)")
        sys.exit(1)

    if not (bundle_path / "index.json").exists():
        print(f"Error: {bundle_path} is not a valid OCI bundle (missing index.json)")
        sys.exit(1)

    print(f"Using local OCI bundle: {bundle_path}")

    # Initialize the runtime with default settings (~/.boxlite)
    runtime = Boxlite.default()

    # Create a box using the local OCI bundle. The Box handle supports the
    # async context manager protocol (auto-start/stop on enter/exit).
    async with (
        await runtime.create(
            BoxOptions(
                rootfs_path=str(bundle_path),  # Use local bundle
                cpus=1,
                memory_mib=256,
            )
        )
    ) as box:
        print(f"Box created: {box.id}")

        # Run a simple command
        result = await box.exec("cat", ["/etc/os-release"])
        print("\n/etc/os-release:")
        async for line in result.stdout():
            text = (
                line.decode("utf-8", errors="replace")
                if isinstance(line, (bytes, bytearray))
                else str(line)
            )
            print(text.rstrip())

        # Show that the box is running from the local bundle
        result = await box.exec("uname", ["-a"])
        print("\nKernel info:")
        async for line in result.stdout():
            text = (
                line.decode("utf-8", errors="replace")
                if isinstance(line, (bytes, bytearray))
                else str(line)
            )
            print(text.rstrip())

    print("\nBox cleaned up successfully!")


if __name__ == "__main__":
    asyncio.run(main())
