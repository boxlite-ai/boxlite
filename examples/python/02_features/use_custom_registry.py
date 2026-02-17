#!/usr/bin/env python3
"""
Custom Registry Example - Using alternative container registries

Demonstrates:
- Configuring custom image registries for unqualified image references
- Registry fallback behavior (tries each in order)
- Using private/enterprise registries
"""

import asyncio
import logging
import os
import sys

import boxlite

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)

logger = logging.getLogger("custom_registry_example")


async def example_custom_registries():
    """Example: Configure custom image registries."""
    print("\n=== Example: Custom Image Registries ===")

    # Configure runtime with custom registries
    # Registries are tried in order; first successful pull wins
    options = boxlite.Options(
        image_registries=["ghcr.io", "quay.io", "docker.io"]
    )

    print(f"Configured registries: {options.image_registries}")
    print("When pulling 'alpine', BoxLite will try:")
    print("  1. ghcr.io/library/alpine")
    print("  2. quay.io/library/alpine")
    print("  3. docker.io/library/alpine")
    print()

    # Create runtime with custom registries
    runtime = boxlite.Boxlite(options)

    # Create a box using the configured registries
    # The 'alpine' image will be resolved through the registry list
    async with boxlite.SimpleBox(
        image="alpine:latest",
        runtime=runtime,
    ) as box:
        print(f"Container started: {box.id}")

        # Run a command to verify the container is working
        result = await box.exec("cat", "/etc/os-release")
        print(f"\nOS Info:\n{result.stdout}")


async def example_default_vs_custom():
    """Example: Compare default vs custom registry behavior."""
    print("\n=== Example: Default vs Custom Registry ===")

    # Default behavior: uses docker.io for unqualified images
    print("Default behavior (no custom registries):")
    print("  'alpine' -> docker.io/library/alpine")

    # Custom registries: tries each in order
    options = boxlite.Options(
        image_registries=["ghcr.io", "docker.io"]
    )
    print("\nWith custom registries ['ghcr.io', 'docker.io']:")
    print("  'alpine' -> ghcr.io/library/alpine (try first)")
    print("           -> docker.io/library/alpine (fallback)")

    # Fully qualified images bypass registry resolution
    print("\nFully qualified images bypass registry list:")
    print("  'docker.io/library/alpine' -> docker.io/library/alpine (direct)")
    print("  'ghcr.io/foo/bar:v1' -> ghcr.io/foo/bar:v1 (direct)")


async def main():
    """Run all examples."""
    print("Custom Registry Example")
    print("=" * 60)

    await example_custom_registries()
    await example_default_vs_custom()

    print("\n" + "=" * 60)
    print("Key Takeaways:")
    print("  - Use Options(image_registries=[...]) to configure registries")
    print("  - Registries are tried in order; first success wins")
    print("  - Fully qualified images (e.g., docker.io/...) bypass the list")
    print("  - Great for enterprise environments with private registries")


if __name__ == "__main__":
    setup_logging()
    asyncio.run(main())
