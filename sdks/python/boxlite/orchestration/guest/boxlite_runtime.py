"""
BoxLite Guest Runtime - Messaging API for code running inside VMs.

Protocol (JSON over stdin/stdout):
    Guest -> Host:
        {"type": "send", "target": "box-name", "data": {...}, "request_id": "uuid"}
        {"type": "publish", "event": "event-name", "data": {...}}
        {"type": "response", "request_id": "uuid", "result": {...}}

    Host -> Guest:
        {"type": "message", "sender": "box-name", "data": {...}, "request_id": "uuid"}
        {"type": "event", "event": "event-name", "data": {...}}
        {"request_id": "uuid", "result": {...}}
        {"type": "shutdown"}
"""

import sys
import json
import os
import uuid
from typing import Callable, Any

__all__ = [
    "send_message",
    "publish_event",
    "on_message",
    "on_event",
    "run_forever",
    "stop",
    "BOX_NAME",
]

_message_handlers: list[Callable] = []
_event_handlers: dict[str, list[Callable]] = {}
_running = True

BOX_NAME = os.environ.get("BOXLITE_BOX_NAME", "unknown")


def send_message(target: str, data: Any) -> Any:
    """Send message to another box and wait for response."""
    request_id = str(uuid.uuid4())
    print(
        json.dumps(
            {"type": "send", "target": target, "data": data, "request_id": request_id}
        ),
        flush=True,
    )

    response_line = sys.stdin.readline()
    if not response_line:
        raise RuntimeError("Connection closed")

    response = json.loads(response_line.strip())
    if response.get("request_id") != request_id:
        raise RuntimeError("Response ID mismatch")
    if "error" in response:
        raise RuntimeError(response["error"])
    return response.get("result")


def publish_event(event: str, data: Any = None) -> None:
    """Publish event to all subscribers (fire-and-forget)."""
    print(json.dumps({"type": "publish", "event": event, "data": data}), flush=True)


def on_message(handler: Callable[[str, Any], Any]) -> Callable:
    """Register handler for incoming messages."""
    _message_handlers.append(handler)
    return handler


def on_event(event: str) -> Callable:
    """Register handler for specific event type."""

    def decorator(handler: Callable[[Any], None]) -> Callable:
        _event_handlers.setdefault(event, []).append(handler)
        return handler

    return decorator


def stop():
    """Stop the event loop."""
    global _running
    _running = False


def run_forever():
    """Main event loop - read messages from stdin, dispatch to handlers."""
    global _running
    _running = True

    for line in sys.stdin:
        if not _running:
            break

        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
            msg_type = msg.get("type")

            if msg_type == "message":
                sender, data, request_id = (
                    msg["sender"],
                    msg["data"],
                    msg.get("request_id"),
                )
                result, error = None, None
                for handler in _message_handlers:
                    try:
                        result = handler(sender, data)
                        break
                    except Exception as e:
                        error = str(e)
                if error:
                    print(
                        json.dumps(
                            {
                                "type": "response",
                                "request_id": request_id,
                                "error": error,
                            }
                        ),
                        flush=True,
                    )
                else:
                    print(
                        json.dumps(
                            {
                                "type": "response",
                                "request_id": request_id,
                                "result": result,
                            }
                        ),
                        flush=True,
                    )

            elif msg_type == "event":
                event, data = msg["event"], msg.get("data")
                for handler in _event_handlers.get(event, []):
                    try:
                        handler(data)
                    except Exception:
                        pass

            elif msg_type == "shutdown":
                break

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(json.dumps({"type": "error", "error": str(e)}), flush=True)
