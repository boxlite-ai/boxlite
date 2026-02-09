#!/usr/bin/env python3
"""
Agent Sender - Sends messages and publishes events.

This is a standalone agent script that can be copied to a guest VM
and run with: await box.run_script("/path/to/agent_sender.py")

The boxlite_runtime module is automatically injected by BoxRuntime.
"""

from boxlite_runtime import send_message, publish_event
import sys
import os

BOX_NAME = os.environ.get("BOXLITE_BOX_NAME", "unknown")


def main():
    print(f"[{BOX_NAME}] Agent starting...", file=sys.stderr)

    # Point-to-point messaging
    # Send a computation request to worker-b
    print(f"[{BOX_NAME}] Sending compute request to worker-b...", file=sys.stderr)
    result = send_message(
        "worker-b",
        {
            "task": "compute",
            "operation": "fibonacci",
            "n": 10,
        },
    )
    print(f"[{BOX_NAME}] Received result: {result}", file=sys.stderr)

    # Send another request
    print(f"[{BOX_NAME}] Sending double request...", file=sys.stderr)
    result = send_message(
        "worker-b",
        {
            "task": "double",
            "value": 42,
        },
    )
    print(f"[{BOX_NAME}] Doubled result: {result}", file=sys.stderr)

    # Pub/Sub: Publish completion event
    print(f"[{BOX_NAME}] Publishing completion event...", file=sys.stderr)
    publish_event(
        "pipeline_complete",
        {
            "sender": BOX_NAME,
            "status": "success",
            "tasks_completed": 2,
        },
    )

    print(f"[{BOX_NAME}] Agent finished!", file=sys.stderr)


if __name__ == "__main__":
    main()
