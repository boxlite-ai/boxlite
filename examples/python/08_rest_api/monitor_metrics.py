#!/usr/bin/env python3
"""
Runtime and per-box metrics via the REST API.

Demonstrates:
- rt.metrics() for runtime-wide counters
- box.metrics() for per-box resource usage and timing

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
    print("REST API: Metrics")
    print("=" * 50)

    rt = connect()

    # --- Runtime metrics (before any work) ---
    print("\n=== Runtime Metrics (initial) ===")
    rm = await rt.metrics()
    print(f"  boxes_created_total:      {rm.boxes_created_total}")
    print(f"  boxes_failed_total:       {rm.boxes_failed_total}")
    print(f"  num_running_boxes:        {rm.num_running_boxes}")
    print(f"  total_commands_executed:   {rm.total_commands_executed}")
    print(f"  total_exec_errors:        {rm.total_exec_errors}")

    # --- Create a box and run a command ---
    print("\n=== Create box and run command ===")
    opts = BoxOptions(image="alpine:latest", auto_remove=False)
    box = await rt.create(opts, name="metrics-demo")
    print(f"  Created box: {box.id}")

    await box.start()
    print("  Box started")

    run = await box.exec("echo", args=["hello metrics"])
    stdout = run.stdout()
    async for line in stdout:
        print(f"  stdout: {line}")
    result = await run.wait()
    print(f"  exit_code: {result.exit_code}")

    # --- Per-box metrics ---
    print("\n=== Box Metrics ===")
    bm = await box.metrics()
    print(f"  commands_executed_total:   {bm.commands_executed_total}")
    print(f"  exec_errors_total:        {bm.exec_errors_total}")
    print(f"  bytes_sent_total:         {bm.bytes_sent_total}")
    print(f"  bytes_received_total:     {bm.bytes_received_total}")
    print(f"  total_create_duration_ms: {bm.total_create_duration_ms}")
    print(f"  guest_boot_duration_ms:   {bm.guest_boot_duration_ms}")
    print(f"  cpu_percent:              {bm.cpu_percent}")
    print(f"  memory_bytes:             {bm.memory_bytes}")

    # --- Runtime metrics (after work) ---
    print("\n=== Runtime Metrics (after work) ===")
    rm2 = await rt.metrics()
    print(f"  boxes_created_total:      {rm2.boxes_created_total}")
    print(f"  total_commands_executed:   {rm2.total_commands_executed}")

    # --- Cleanup ---
    await rt.remove(box.id, force=True)
    print(f"\n  Cleaned up box {box.id}")
    print("\n  Done")


if __name__ == "__main__":
    asyncio.run(main())
