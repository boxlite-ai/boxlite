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
import os
import sys

import boxlite

try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from _helpers import setup_logging
except ImportError:
    def setup_logging():
        logging.basicConfig(level=logging.ERROR)

logger = logging.getLogger("cmd_user_example")


async def example_cmd_override():
    """Example 1: Override ENTRYPOINT and CMD.

    OCI images have two directives:
    - ENTRYPOINT: The executable
    - CMD: Default arguments

    Final command = ENTRYPOINT + CMD

    Note: `python:alpine` uses CMD (not ENTRYPOINT) for its default command.
    To pass arguments like `-c`, we set entrypoint=["python3"] explicitly
    so that cmd args are appended to it.
    """
    print("\n=== Example 1: CMD Override ===")

    async with boxlite.SimpleBox(
        image="python:alpine",
        entrypoint=["python3"],
        cmd=["-c", "import sys; print(f'Python {sys.version}')"],
    ) as box:
        print(f"Container started: {box.id}")

        # The CMD is used by the init process (entrypoint + cmd).
        # We can still run additional commands:
        result = await box.exec("python3", "-c", "print('Hello from exec')")
        print(f"Exec output: {result.stdout.strip()}")
        print(f"Exit code: {result.exit_code}")


async def example_user_override():
    """Example 2: Run as non-root user.

    By default, containers run as root (uid=0). The user option accepts
    username or UID (format: <name|uid>[:<group|gid>]).

    Setting user="1000:1000" changes the container user to uid 1000, gid 1000.
    """
    print("\n=== Example 2: User Override ===")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        user="1000:1000",
    ) as box:
        print(f"Container started: {box.id}")

        # Verify the user inside the container
        result = await box.exec("id")
        print(f"Container user: {result.stdout.strip()}")

        # Verify uid specifically
        result = await box.exec("id", "-u")
        uid = result.stdout.strip()
        print(f"UID: {uid}")
        assert uid == "1000", f"Expected UID 1000, got {uid}"


async def example_username_resolution():
    """Example 3: Resolve username from /etc/passwd.

    Non-numeric usernames are resolved from the container's /etc/passwd.
    Alpine has 'nobody' (uid=65534, gid=65534) in its /etc/passwd.
    """
    print("\n=== Example 3: Username Resolution ===")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        user="nobody",
    ) as box:
        print(f"Container started: {box.id}")

        result = await box.exec("id")
        print(f"Container user: {result.stdout.strip()}")

        result = await box.exec("id", "-u")
        uid = result.stdout.strip()
        print(f"UID: {uid}")
        assert uid == "65534", f"Expected UID 65534 (nobody), got {uid}"


async def example_user_group_resolution():
    """Example 4: Resolve user:group from /etc/passwd and /etc/group.

    Username or UID (format: <name|uid>[:<group|gid>]).
    Supports all combinations: name:group, name:gid, uid:group, uid:gid.
    """
    print("\n=== Example 4: User:Group Resolution ===")

    async with boxlite.SimpleBox(
        image="alpine:latest",
        user="nobody:nobody",
    ) as box:
        print(f"Container started: {box.id}")

        result = await box.exec("id")
        print(f"Container user: {result.stdout.strip()}")

        result = await box.exec("id", "-g")
        gid = result.stdout.strip()
        print(f"GID: {gid}")
        assert gid == "65534", f"Expected GID 65534 (nobody), got {gid}"


async def example_combined():
    """Example 5: Combine CMD and user overrides.

    A production-like setup: run as non-root with custom arguments.
    """
    print("\n=== Example 5: Combined CMD + User ===")

    async with boxlite.SimpleBox(
        image="python:alpine",
        entrypoint=["python3"],
        cmd=["-c", "import os; print(f'uid={os.getuid()}, gid={os.getgid()}')"],
        user="1000:1000",
    ) as box:
        print(f"Container started: {box.id}")

        result = await box.exec(
            "python3", "-c", "import os; print(f'Running as uid={os.getuid()}')"
        )
        print(f"Output: {result.stdout.strip()}")


async def main():
    setup_logging()
    print("BoxLite CMD and User Override Example")
    print("=" * 40)

    await example_cmd_override()
    await example_user_override()
    await example_username_resolution()
    await example_user_group_resolution()
    await example_combined()

    print("\nAll examples completed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
