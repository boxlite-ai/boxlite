# AI Agent Pipeline Example

Demonstrates multi-box orchestration with an **AI Agent Pipeline** pattern - similar to autonomous agents that communicate like Erlang processes.

## Overview

Three agents work together in isolated VMs:

```
┌─────────────┐     code      ┌──────────────┐    code       ┌─────────────┐
│   CODER     │ ───────────▶  │   REVIEWER   │  ──────────▶  │   TESTER    │
│             │               │              │               │             │
│ generate()  │  ◀─────────── │  review()    │  ◀──────────  │  test()     │
│             │   feedback    │              │    results    │             │
└─────────────┘               └──────────────┘               └─────────────┘
                                    │
                                    │ publish("pipeline_complete")
                                    ▼
                              All agents receive event
```

| Agent | Role |
|-------|------|
| **Coder** | Generates Python code (simulates AI code generation) |
| **Reviewer** | Reviews code structure, forwards to tester |
| **Tester** | Executes code in isolation, validates with assertions |

## Key Patterns Demonstrated

| Pattern | How It's Shown |
|---------|----------------|
| **Guest-initiated messaging** | Coder decides when to send code to reviewer |
| **Pipeline pattern** | Code flows: coder → reviewer → tester |
| **Nested messaging** | Reviewer calls tester before responding to coder |
| **Pub/Sub events** | `pipeline_complete` broadcast to all agents |
| **Autonomous logic** | Reviewer makes approval decision based on tests |
| **Real isolation** | Untrusted code runs safely in tester VM |

## Running the Example

```bash
# Build the SDK (if not already built)
make dev:python

# Run the example
python examples/python/ai_pipeline/host.py
```

## Expected Output

```
======================================================================
  AI Agent Pipeline Demo
  Coder -> Reviewer -> Tester
======================================================================

[host] Creating agent boxes...
[host] Created: ['coder', 'reviewer', 'tester']

[host] Starting receiver agents...
[host] Starting coder agent (initiates pipeline)...


[host] Coder finished with exit code: 0
[host] Stopping receiver agents...

======================================================================
  Demo Complete!
======================================================================
```

The exit code `0` indicates the pipeline succeeded. The agents communicate via JSON messages over stdin/stdout, so their debug output (printed to stderr inside the VMs) isn't visible in the host output.

To see detailed message routing, enable debug logging:

```bash
python -c "
import logging
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s [%(name)s] %(message)s')
exec(open('examples/python/ai_pipeline/host.py').read())
"
```

This shows the message flow:
```
Routing message: coder -> reviewer
Routing message: reviewer -> tester
```

## How It Works

### 1. Box Creation

The host creates three isolated VMs, each running `python:3.11-slim`:

```python
async with BoxRuntime() as runtime:
    # Python version auto-detected from host
    coder = await runtime.create_box(name="coder")
    reviewer = await runtime.create_box(name="reviewer")
    tester = await runtime.create_box(name="tester")
```

### 2. Agent Communication

Agents use the injected `boxlite_runtime` module for messaging:

```python
# Coder sends code to reviewer (blocks until response)
result = send_message("reviewer", {"action": "review", "code": code})

# Reviewer forwards to tester (nested call)
test_result = send_message("tester", {"action": "test", "code": code})

# Coder broadcasts completion event (fire-and-forget)
publish_event("pipeline_complete", {"status": "success"})
```

### 3. Message Handlers

Receiver agents register handlers with decorators:

```python
@on_message
def handle_message(sender, data):
    # Process incoming message
    return {"result": "..."}

@on_event("pipeline_complete")
def on_complete(data):
    # React to broadcast events
    print(f"Pipeline finished: {data}")
```

## Security Model

This example demonstrates BoxLite's core value proposition:

- **Untrusted code execution**: The tester agent runs generated code inside an isolated VM
- **Hardware isolation**: Each agent runs in its own VM with hardware-level isolation
- **Resource limits**: Memory and CPU are constrained per box
- **No host access**: Guest VMs cannot access host filesystem or network

## Extending This Example

### Real AI Integration

Replace the simulated code generation with actual LLM calls:

```python
# In coder agent
import openai
response = openai.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": f"Write a Python function for: {task}"}]
)
generated_code = response.choices[0].message.content
```

### Adding More Stages

Add a formatter agent between coder and reviewer:

```python
FORMATTER_CODE = '''
@on_message
def handle_message(sender, data):
    import black
    formatted = black.format_str(data["code"], mode=black.Mode())
    return send_message("reviewer", {"code": formatted, ...})
'''
```

### Parallel Testing

Run multiple test suites concurrently:

```python
# Create multiple tester boxes
testers = [
    await runtime.create_box(name=f"tester-{i}")
    for i in range(3)
]

# Fan out tests
results = await asyncio.gather(*[
    send_message(f"tester-{i}", {"tests": suite})
    for i, suite in enumerate(test_suites)
])
```

## Related Examples

- [`multi_agent/`](../multi_agent/) - Basic point-to-point and pub/sub messaging
- [`codebox_example.py`](../codebox_example.py) - Simpler code execution without orchestration
