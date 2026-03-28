#!/usr/bin/env python3
"""
Pause and Resume Example - Zero-CPU VM Freezing

Demonstrates the pause/resume API:
- pause(): Freezes VM (SIGSTOP) — zero CPU, memory preserved
- resume(): Thaws VM (SIGCONT) — continues from exact point
- Idempotent: pause on paused = no-op, resume on running = no-op
- Exec rejected while paused (InvalidState)
- Stop works directly from paused state
"""

import asyncio

import boxlite


async def basic_pause_resume():
    """Pause a box, then resume and verify it still works."""
    print("\n=== Basic Pause/Resume ===")

    runtime = boxlite.Boxlite.default()

    box = await runtime.create(boxlite.BoxOptions(
        image="alpine:latest",
        auto_remove=False,
    ))
    print(f"Created box: {box.id}")

    # Run a command to verify box is working
    execution = await box.exec("echo", ["Box is running"])
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  {line.strip()}")
    await execution.wait()

    info = box.info()
    print(f"State: {info.state}")

    # Pause — VM frozen, zero CPU usage
    print("\nPausing box...")
    await box.pause()
    info = box.info()
    print(f"State after pause: {info.state}")

    # Resume — VM continues from exact point
    print("\nResuming box...")
    await box.resume()
    info = box.info()
    print(f"State after resume: {info.state}")

    # Verify box still works
    execution = await box.exec("echo", ["Still alive after pause/resume!"])
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  {line.strip()}")
    await execution.wait()

    await box.stop()
    await runtime.remove(box.id, force=False)
    print("\nBox stopped and removed")


async def exec_blocked_while_paused():
    """Show that exec is rejected while the box is paused."""
    print("\n\n=== Exec Blocked While Paused ===")

    runtime = boxlite.Boxlite.default()

    box = await runtime.create(boxlite.BoxOptions(
        image="alpine:latest",
        auto_remove=False,
    ))
    print(f"Created box: {box.id}")

    execution = await box.exec("echo", ["ready"])
    await execution.wait()

    await box.pause()
    print("Box paused")

    # Attempt exec while paused
    print("Attempting exec while paused...")
    try:
        await box.exec("echo", ["should fail"])
        print("  Unexpected: exec succeeded")
    except Exception as e:
        print(f"  Expected error: {e}")

    # Resume and exec works again
    await box.resume()
    print("Box resumed")

    execution = await box.exec("echo", ["works again!"])
    stdout = execution.stdout()
    async for line in stdout:
        print(f"  {line.strip()}")
    await execution.wait()

    await box.stop()
    await runtime.remove(box.id, force=False)


async def pause_resume_cycles():
    """Multiple pause/resume cycles without corruption."""
    print("\n\n=== Multiple Pause/Resume Cycles ===")

    runtime = boxlite.Boxlite.default()

    box = await runtime.create(boxlite.BoxOptions(
        image="alpine:latest",
        auto_remove=False,
    ))
    print(f"Created box: {box.id}")

    execution = await box.exec("echo", ["init"])
    await execution.wait()

    for i in range(3):
        await box.pause()
        info = box.info()
        print(f"  Cycle {i}: paused (state={info.state})")

        await box.resume()
        execution = await box.exec("echo", [f"cycle-{i}"])
        stdout = execution.stdout()
        async for line in stdout:
            print(f"  Cycle {i}: {line.strip()}")
        await execution.wait()

    print("All cycles completed — VM integrity preserved")

    await box.stop()
    await runtime.remove(box.id, force=False)


async def stop_from_paused():
    """Stop a paused box directly (no need to resume first)."""
    print("\n\n=== Stop From Paused State ===")

    runtime = boxlite.Boxlite.default()

    box = await runtime.create(boxlite.BoxOptions(
        image="alpine:latest",
        auto_remove=False,
    ))
    box_id = box.id
    print(f"Created box: {box_id}")

    execution = await box.exec("echo", ["running"])
    await execution.wait()

    await box.pause()
    print(f"State: {box.info().state}")

    # Stop directly from Paused — no resume needed
    print("Stopping directly from paused state...")
    await box.stop()

    info = await runtime.get_info(box_id)
    if info:
        print(f"State after stop: {info.state}")

    await runtime.remove(box_id, force=False)
    print("Box removed")


async def main():
    """Run all pause/resume demonstrations."""
    print("Pause/Resume API Demo")
    print("=" * 60)
    print("\nKey concepts:")
    print("  - pause() freezes VM: zero CPU, memory preserved")
    print("  - resume() thaws VM: continues from exact point")
    print("  - exec/copy rejected while paused (InvalidState)")
    print("  - stop() works directly from paused state")

    await basic_pause_resume()
    await exec_blocked_while_paused()
    await pause_resume_cycles()
    await stop_from_paused()

    print("\n" + "=" * 60)
    print("All demos completed!")
    print("\nUse cases:")
    print("  - Suspend idle AI agent sandboxes (save CPU, keep state)")
    print("  - Point-in-time snapshots (pause → snapshot → resume)")
    print("  - Resource management (pause low-priority boxes)")


if __name__ == "__main__":
    asyncio.run(main())
