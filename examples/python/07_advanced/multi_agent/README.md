# Multi-Agent Orchestration Example

This example demonstrates guest-initiated messaging between BoxLite boxes.

## Concepts

**Guest-Initiated Messaging**: Code running inside a guest VM can send messages to other boxes. The host runtime routes messages between guests.

```
┌───────────────────────────────────────────────────────────────────┐
│                      HOST (BoxRuntime)                            │
│                    Message Routing Layer                          │
└──────────┬─────────────────────────────────────────┬─────────────┘
           │ stdin/stdout                        │ stdin/stdout
           ▼                                     ▼
┌─────────────────────┐                ┌─────────────────────┐
│     GUEST VM 1      │   message      │     GUEST VM 2      │
│     (worker-a)      │ ─────────────▶ │     (worker-b)      │
│                     │  (via host)    │                     │
│  send_message(      │                │  @on_message        │
│    "worker-b",      │                │  def handle(...):   │
│    data             │                │      return result  │
│  )                  │                │                     │
└─────────────────────┘                └─────────────────────┘
```

## Two Messaging Patterns

### 1. Point-to-Point (Request/Response)

```python
# In worker-a (sender):
result = send_message("worker-b", {"task": "double", "value": 21})
# result = {"doubled": 42}

# In worker-b (receiver):
@on_message
def handle(sender, data):
    return {"doubled": data["value"] * 2}
```

### 2. Pub/Sub (Events)

```python
# In worker-a (publisher):
publish_event("task_complete", {"status": "success"})

# In worker-b (subscriber):
@on_event("task_complete")
def on_complete(data):
    print(f"Task done: {data}")
```

## Files

- `host.py` - Host orchestration script (run this)
- `agent_sender.py` - Standalone sender agent script
- `agent_receiver.py` - Standalone receiver agent script

## Running

```bash
# From project root
python examples/python/07_advanced/multi_agent/host.py
```

## Expected Output

```
==============================================================
Multi-Agent Orchestration Demo
==============================================================

[host] Creating boxes...
[host] Created boxes: ['worker-a', 'worker-b']

[host] Starting agent in worker-b (receiver)...
[host] Starting agent in worker-a (sender)...

[host] Waiting for worker-a to complete...
[agent_a] Starting...
[agent_b] Starting, waiting for messages...
[agent_a] Sending message to worker-b...
[agent_b] Received message from worker-a: {'task': 'double', 'value': 21}
[agent_b] Responding with: {'doubled': 42}
[agent_a] Got response from worker-b: {'doubled': 42}
[agent_a] Publishing 'task_complete' event...
[agent_b] Received 'task_complete' event: {'status': 'success', 'result': {'doubled': 42}}
[agent_a] Done!
[host] worker-a finished with exit code: 0
[host] Stopping worker-b...

==============================================================
Demo complete!
==============================================================
```

## API Reference

### Host-side (BoxRuntime) - Ray-style Decorator API

```python
from boxlite.orchestration import BoxRuntime

async with BoxRuntime() as runtime:
    # Create boxes (Python version auto-detected from host)
    receiver = await runtime.create_box(name="receiver")
    sender = await runtime.create_box(name="sender")

    # Long-running handlers (like Ray actors)
    # Closures work - serialized with captured variables
    multiplier = 2

    @receiver.on_message
    def handle(sender_name, data):
        return {"result": data["value"] * multiplier}  # closure!

    @receiver.on_event("done")
    def on_done(data):
        print(f"Done: {data}")

    # One-shot tasks (like Ray tasks)
    @sender.task
    def main():
        from boxlite_runtime import send_message, publish_event
        result = send_message("receiver", {"value": 21})
        publish_event("done", {"result": result})

    # Run agents
    await receiver.run()  # Starts event loop
    await sender.run()    # Runs task, then exits

    # Wait for completion
    await sender.wait()
    await receiver.stop()
```

### Guest-side (boxlite_runtime)

```python
from boxlite_runtime import (
    send_message,    # Point-to-point (sync, waits for response)
    publish_event,   # Pub/Sub (async, fire-and-forget)
    on_message,      # Decorator for message handler
    on_event,        # Decorator for event handler
    run_forever,     # Event loop (call at end of receiver scripts)
    stop,            # Exit event loop
)
```
