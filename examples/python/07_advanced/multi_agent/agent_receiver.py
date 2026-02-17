#!/usr/bin/env python3
"""
Agent Receiver - Handles incoming messages and events.

This is a standalone agent script that can be copied to a guest VM
and run with: await box.run_script("/path/to/agent_receiver.py")

The boxlite_runtime module is automatically injected by BoxRuntime.
"""

from boxlite_runtime import on_message, on_event, run_forever
import sys
import os

BOX_NAME = os.environ.get("BOXLITE_BOX_NAME", "unknown")


def fibonacci(n: int) -> int:
    """Compute fibonacci number."""
    if n <= 1:
        return n
    a, b = 0, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return b


@on_message
def handle_message(sender: str, data: dict) -> dict:
    """
    Handle incoming point-to-point messages.

    This function is called when another box sends a message to us.
    The return value is sent back as the response.
    """
    task = data.get("task")
    print(f"[{BOX_NAME}] Received '{task}' from {sender}: {data}", file=sys.stderr)

    if task == "compute":
        operation = data.get("operation")
        if operation == "fibonacci":
            n = data.get("n", 10)
            result = fibonacci(n)
            return {"operation": operation, "n": n, "result": result}
        else:
            return {"error": f"unknown operation: {operation}"}

    elif task == "double":
        value = data.get("value", 0)
        return {"doubled": value * 2}

    elif task == "echo":
        return {"echo": data}

    else:
        return {"error": f"unknown task: {task}"}


@on_event("pipeline_complete")
def on_pipeline_complete(data: dict) -> None:
    """Handle pipeline completion events."""
    print(f"[{BOX_NAME}] Pipeline complete event: {data}", file=sys.stderr)


@on_event("shutdown_requested")
def on_shutdown(data: dict) -> None:
    """Handle shutdown request events."""
    print(f"[{BOX_NAME}] Shutdown requested: {data}", file=sys.stderr)
    # Note: The event loop will exit when stdin is closed


def main():
    print(f"[{BOX_NAME}] Receiver agent starting...", file=sys.stderr)
    print(f"[{BOX_NAME}] Waiting for messages...", file=sys.stderr)

    # This blocks until stdin is closed or stop() is called
    run_forever()

    print(f"[{BOX_NAME}] Receiver agent shutting down.", file=sys.stderr)


if __name__ == "__main__":
    main()
