#!/usr/bin/env python3
"""
Multi-Agent Orchestration Example

Demonstrates guest-initiated messaging between boxes:
1. Point-to-point: worker-a sends a message to worker-b, gets response
2. Pub/Sub: worker-a publishes an event, worker-b receives it

Run with:
    python examples/python/multi_agent/host.py
"""

import asyncio
import logging
import sys

from boxlite.orchestration import BoxRuntime

# Enable logging to see message routing
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)


async def main():
    print("=" * 60)
    print("Multi-Agent Orchestration Demo")
    print("=" * 60)
    print()

    async with BoxRuntime() as runtime:
        # Create two worker boxes
        print("[host] Creating boxes...")
        worker_a = await runtime.create_box(name="worker-a", memory_mib=512)
        worker_b = await runtime.create_box(name="worker-b", memory_mib=512)
        print(f"[host] Created boxes: {runtime.list_boxes()}")
        print()

        # ─────────────────────────────────────────────────────────────
        # Worker B: Receiver (long-running with handlers)
        # ─────────────────────────────────────────────────────────────

        @worker_b.on_message
        def handle_message(sender, data):
            """Handle incoming point-to-point messages."""
            import sys

            print(f"[agent_b] Received message from {sender}: {data}", file=sys.stderr)

            if data.get("task") == "double":
                result = {"doubled": data["value"] * 2}
                print(f"[agent_b] Responding with: {result}", file=sys.stderr)
                return result

            return {"error": "unknown task"}

        @worker_b.on_event("task_complete")
        def on_complete(data):
            """Handle task_complete events."""
            import sys

            print(f"[agent_b] Received 'task_complete' event: {data}", file=sys.stderr)

        # ─────────────────────────────────────────────────────────────
        # Worker A: Sender (one-shot task)
        # ─────────────────────────────────────────────────────────────

        @worker_a.task
        def agent_a_main():
            """One-shot task that sends messages and publishes events."""
            import sys

            from boxlite_runtime import publish_event, send_message

            print("[agent_a] Starting...", file=sys.stderr)

            # Point-to-point: Send message to worker-b, wait for response
            print("[agent_a] Sending message to worker-b...", file=sys.stderr)
            result = send_message("worker-b", {"task": "double", "value": 21})
            print(f"[agent_a] Got response from worker-b: {result}", file=sys.stderr)

            # Pub/Sub: Publish event (all subscribers receive)
            print("[agent_a] Publishing 'task_complete' event...", file=sys.stderr)
            publish_event("task_complete", {"status": "success", "result": result})

            print("[agent_a] Done!", file=sys.stderr)

        # ─────────────────────────────────────────────────────────────
        # Run the agents
        # ─────────────────────────────────────────────────────────────

        # Start worker-b first (it's the receiver)
        print("[host] Starting agent in worker-b (receiver)...")
        await worker_b.run()

        # Give worker-b a moment to initialize
        await asyncio.sleep(0.5)

        # Start worker-a (sender)
        print("[host] Starting agent in worker-a (sender)...")
        await worker_a.run()

        # Wait for worker-a to finish (it will exit after publishing)
        print()
        print("[host] Waiting for worker-a to complete...")
        exit_code = await worker_a.wait()
        print(f"[host] worker-a finished with exit code: {exit_code}")

        # Stop worker-b (it runs forever, so we need to stop it)
        print("[host] Stopping worker-b...")
        await worker_b.stop()

        print()
        print("=" * 60)
        print("Demo complete!")
        print("=" * 60)

        return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
