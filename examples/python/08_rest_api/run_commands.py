#!/usr/bin/env python3
"""
Execute commands and stream output via the REST API.

Demonstrates:
- box.exec() to run commands in a remote box
- Streaming stdout and stderr
- Exit codes and error handling
- Environment variables per command
- Using async context manager for auto start/stop

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
    print("REST API: Command Execution")
    print("=" * 50)

    rt = connect()

    # Create and start a box
    opts = BoxOptions(image="alpine:latest", auto_remove=False)
    box = await rt.create(opts, name="exec-demo")
    await box.start()
    print(f"  Box {box.id} started")

    # --- Simple command ---
    print("\n=== Simple Command ===")
    execution = await box.exec("echo", args=["hello from REST API"])
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  stdout: {line}")
    result = await execution.wait()
    print(f"  exit_code: {result.exit_code}")

    # --- Command with arguments ---
    print("\n=== Command with Arguments ===")
    execution = await box.exec("ls", args=["-la", "/"])
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  {line}")
    await execution.wait()

    # --- Multi-line output (streaming) ---
    print("\n=== Streaming Output ===")
    execution = await box.exec(
        "sh", args=["-c", "for i in 1 2 3; do echo \"line $i\"; done"],
    )
    stdout = execution.stdout()
    count = 0
    async for line in stdout:
        count += 1
        print(f"  [{count}] {line}")
    await execution.wait()

    # --- Failed command (non-zero exit) ---
    print("\n=== Failed Command ===")
    execution = await box.exec("sh", args=["-c", "exit 42"])
    result = await execution.wait()
    print(f"  exit_code: {result.exit_code}")
    print(f"  error_message: {result.error_message}")

    # --- Environment variables ---
    print("\n=== Per-Command Environment ===")
    execution = await box.exec(
        "sh", args=["-c", "echo GREETING=$GREETING"],
        env=[("GREETING", "hello-from-rest")],
    )
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  {line}")
    await execution.wait()

    # --- Cleanup ---
    await rt.remove(box.id, force=True)
    print(f"\n  Cleaned up box {box.id}")
    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
