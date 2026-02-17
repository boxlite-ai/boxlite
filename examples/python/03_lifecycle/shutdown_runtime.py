#!/usr/bin/env python3
"""
Runtime Shutdown Example - Graceful cleanup of all boxes.

Demonstrates the runtime.shutdown() method:
- Graceful shutdown of all running boxes
- Custom timeout configuration
- Behavior after shutdown (operations fail)
"""

import asyncio

import boxlite


async def main():
    print("=== Runtime Shutdown Example ===\n")

    # Get the default runtime
    runtime = boxlite.Boxlite.default()

    # Create a few boxes
    boxes = []
    for i in range(3):
        box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        boxes.append(box)
        print(f"Created box {i + 1}: {box.id}")

    # Run a simple command in each box
    for i, box in enumerate(boxes):
        run = await box.exec("echo", [f"Hello from box {i + 1}"])
        stdout = run.stdout()
        async for line in stdout:
            print(f"  Box {i + 1}: {line.strip()}")
        await run.wait()

    # Get metrics before shutdown
    metrics = await runtime.metrics()
    print(f"\nBefore shutdown:")
    print(f"  Running boxes: {metrics.num_running_boxes}")
    print(f"  Total commands: {metrics.total_commands_executed}")

    # Shutdown with custom timeout (5 seconds)
    print("\nShutting down all boxes (5 second timeout)...")
    await runtime.shutdown(timeout=5)
    print("Shutdown complete!")

    # After shutdown, new operations will fail
    print("\nTrying to create a new box after shutdown...")
    try:
        await runtime.create(boxlite.BoxOptions(image="alpine:latest"))
        print("ERROR: Expected this to fail!")
    except RuntimeError as e:
        print(f"Expected error: {e}")

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
