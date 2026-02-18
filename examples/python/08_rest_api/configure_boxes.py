#!/usr/bin/env python3
"""
Custom box configuration via the REST API.

Demonstrates:
- BoxOptions with custom CPU and memory
- Environment variables and working directory
- auto_remove=False to keep box after stop
- Inspecting box configuration via info()

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
    print("REST API: Box Configuration")
    print("=" * 50)

    rt = connect()

    # --- Custom resources ---
    print("\n=== Custom CPU and Memory ===")
    opts = BoxOptions(
        image="alpine:latest",
        cpus=2,
        memory_mib=1024,
        auto_remove=False,
    )
    box = await rt.create(opts, name="config-demo")
    info = box.info()
    print(f"  Created box: {box.id}")
    print(f"  CPUs:        {info.cpus}")
    print(f"  Memory MiB:  {info.memory_mib}")
    print(f"  Image:       {info.image}")

    # --- Environment variables ---
    print("\n=== Environment Variables ===")
    await box.start()
    run = await box.exec(
        "sh", args=["-c", "echo APP=$APP_NAME ENV=$APP_ENV"],
        env=[("APP_NAME", "boxlite-demo"), ("APP_ENV", "staging")],
    )
    stdout = run.stdout()
    async for line in stdout:
        print(f"  {line}")
    await run.wait()

    # --- Working directory ---
    print("\n=== Working Directory ===")
    opts_wd = BoxOptions(
        image="alpine:latest",
        working_dir="/tmp",
        auto_remove=False,
    )
    box_wd = await rt.create(opts_wd, name="workdir-demo")
    await box_wd.start()

    run = await box_wd.exec("pwd")
    stdout = run.stdout()
    async for line in stdout:
        print(f"  Working dir: {line}")
    await run.wait()

    # --- Stop and verify box persists (auto_remove=False) ---
    print("\n=== Stop (auto_remove=False) ===")
    await box.stop()
    info_after_stop = await rt.get_info(box.id)
    print(f"  Box still exists after stop: {info_after_stop is not None}")
    if info_after_stop:
        print(f"  Status: {info_after_stop.state.status}")

    # --- Cleanup ---
    await rt.remove(box.id, force=True)
    await rt.remove(box_wd.id, force=True)
    print(f"\n  Cleaned up boxes")
    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
