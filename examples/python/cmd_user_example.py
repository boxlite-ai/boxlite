#!/usr/bin/env python3
"""
CMD and User Override Example

Demonstrates how to override image CMD and container user:
- CMD override: Replace default arguments while preserving ENTRYPOINT
- User override: Run container as a non-root user
- Combining both for production-like configurations
"""

import asyncio
import logging
import sys

import boxlite

logger = logging.getLogger("cmd_user_example")


def setup_logging():
    """Configure stdout logging for the example."""
    logging.basicConfig(
        level=logging.ERROR,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


async def example_cmd_override():
    """Example 1: Override CMD to pass custom arguments.

    OCI images have two directives:
    - ENTRYPOINT: The executable (preserved)
    - CMD: Default arguments (overridable)

    Final command = ENTRYPOINT + CMD

    For example, `python:alpine` has ENTRYPOINT=["python3"].
    Setting cmd=["-c", "print('hello')"] produces: python3 -c "print('hello')"
    """
    print("\n=== Example 1: CMD Override ===")

    async with boxlite.SimpleBox(
        image="python:alpine",
        cmd=["-c", "import sys; print(f'Python {sys.version}')"],
    ) as box:
        print(f"Container started: {box.id}")

        # The CMD is used by the init process (entrypoint + cmd).
        # We can still run additional commands:
        result = await box.run("python3 -c \"print('Hello from run')\"")
        print(f"Run output: {result.stdout.strip()}")
        print(f"Exit code: {result.exit_code}")


async def example_user_override():
    """Example 2: Run as non-root user.

    By default, containers run as root (uid=0). Setting user="1000:1000"
    changes the container user to uid 1000, gid 1000.
    """
    print("\n=== Example 2: User Override ===")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        user="1000:1000",
    ) as box:
        print(f"Container started: {box.id}")

        # Verify the user inside the container
        result = await box.run("id")
        print(f"Container user: {result.stdout.strip()}")

        # Verify uid specifically
        result = await box.run("id -u")
        uid = result.stdout.strip()
        print(f"UID: {uid}")
        assert uid == "1000", f"Expected UID 1000, got {uid}"


async def example_combined():
    """Example 3: Combine CMD and user overrides.

    A production-like setup: run as non-root with custom arguments.
    """
    print("\n=== Example 3: Combined CMD + User ===")

    async with boxlite.SimpleBox(
        image="python:alpine",
        cmd=["-c", "import os; print(f'uid={os.getuid()}, gid={os.getgid()}')"],
        user="1000:1000",
    ) as box:
        print(f"Container started: {box.id}")

        # Run a command to verify both overrides
        result = await box.run(
            "python3 -c \"import os; print(f'Running as uid={os.getuid()}')\""
        )
        print(f"Output: {result.stdout.strip()}")


async def main():
    setup_logging()
    print("BoxLite CMD and User Override Example")
    print("=" * 40)

    await example_cmd_override()
    await example_user_override()
    await example_combined()

    print("\nAll examples completed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
