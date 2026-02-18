# AI Agent Integration Guide

This guide covers best practices for integrating BoxLite as a sandboxed execution environment for AI agents. It builds on the quick-start patterns in the [How-to Guides](README.md#using-with-ai-agents) with deeper coverage of configuration, concurrency, timeouts, security, and file transfer.

## Table of Contents

- [Recommended Configuration](#recommended-configuration)
- [Concurrency Model](#concurrency-model)
- [Timeout Handling and Zombie Prevention](#timeout-handling-and-zombie-prevention)
- [Security Boundaries](#security-boundaries)
- [File Transfer Patterns](#file-transfer-patterns)
- [Terminal Resizing](#terminal-resizing)
- [Complete Example](#complete-example)

---

## Recommended Configuration

### Workload-Type Reference

| Workload | Image | CPUs | Memory | Disk | Notes |
|----------|-------|------|--------|------|-------|
| Code execution | `python:slim` | 1 | 512 MiB | None | Ephemeral, fast startup |
| Data analysis | `python:slim` | 2 | 2048 MiB | None | More memory for pandas/numpy |
| Web browsing | Use `BrowserBox` | 2 | 2048 MiB | None | Chromium needs resources |
| Multi-tool agent | `python:slim` | 2 | 1024 MiB | None | Balance cost vs. capability |
| Persistent env | `python:slim` | 1 | 512 MiB | 10 GB | State survives restarts |

### Starter Configuration

```python
import boxlite

options = boxlite.BoxOptions(
    image="python:slim",
    cpus=2,
    memory_mib=1024,
    working_dir="/workspace",
    security=boxlite.SecurityOptions.maximum(),
)
```

### Security Presets

`SecurityOptions` has three presets:

| Preset | Jailer | Seccomp | Resource Limits | Use Case |
|--------|--------|---------|-----------------|----------|
| `development()` | Off | Off | None | Debugging sandbox issues |
| `standard()` | On | On (Linux) | None | General workloads |
| `maximum()` | On | On (Linux) | `max_open_files=1024`, `max_file_size=1GiB`, `max_processes=100` | Untrusted AI code |

For AI agents running untrusted code, use `SecurityOptions.maximum()`:

```python
security = boxlite.SecurityOptions.maximum()

# Customize if needed
security.max_open_files = 2048
security.network_enabled = False  # Disable network for strict isolation
```

---

## Concurrency Model

### One Box, Multiple Executions (Recommended)

A single box can run many `exec()` calls. Each call spawns a new process inside the same VM. This avoids repeated VM boot overhead and is safe because the VM provides hardware isolation from the host.

```python
import asyncio
import boxlite

async def main():
    runtime = boxlite.Boxlite.default()
    box = await runtime.create(boxlite.BoxOptions(
        image="python:slim",
        cpus=2,
        memory_mib=1024,
        security=boxlite.SecurityOptions.maximum(),
    ))

    try:
        # Run agent tools concurrently in the same box
        results = await asyncio.gather(
            box.exec("python", ["-c", "print('task A')"]),
            box.exec("python", ["-c", "print('task B')"]),
            box.exec("python", ["-c", "print('task C')"]),
        )

        for execution in results:
            result = await execution.wait()
            print(f"Exit code: {result.exit_code}")
    finally:
        await box.stop()
        await runtime.remove(box.id)
```

**When to use:** Most AI agent scenarios. Keeps VM boot cost to one-time.

### One Box Per Agent

Use separate boxes when you need strict isolation between agents, different images, or independent resource limits.

```python
async def run_isolated_agent(code: str, image: str = "python:slim"):
    """Each agent gets its own box."""
    async with boxlite.SimpleBox(image=image, memory_mib=512) as box:
        result = await box.exec("python", "-c", code)
        return result.stdout

async def main():
    agents = [
        run_isolated_agent("print('agent 1')"),
        run_isolated_agent("print('agent 2')", image="node:alpine"),
        run_isolated_agent("print('agent 3')"),
    ]
    results = await asyncio.gather(*agents)
```

**When to use:** Multi-tenant isolation, different language runtimes, or strict resource separation.

---

## Timeout Handling and Zombie Prevention

### The Problem

`asyncio.wait_for()` cancels the Python coroutine but does **not** kill the guest process. Without explicit cleanup, the process continues running inside the VM indefinitely.

```python
# BAD: process keeps running inside the box after timeout
try:
    execution = await box.exec("python", ["-c", "import time; time.sleep(9999)"])
    result = await asyncio.wait_for(execution.wait(), timeout=5)
except asyncio.TimeoutError:
    print("Timed out")  # Process is still running in the VM!
```

### Correct Pattern

Always kill the execution in the timeout handler:

```python
async def exec_with_timeout(box, cmd, args=None, timeout=30):
    """Execute a command with proper timeout and cleanup."""
    execution = await box.exec(cmd, args or [])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result
    except asyncio.TimeoutError:
        await execution.kill()
        raise
```

### Defensive Helper

For maximum safety, combine timeout handling with a try/finally block:

```python
async def safe_exec(box, cmd, args=None, timeout=30):
    """Execute with timeout, guaranteed process cleanup."""
    execution = await box.exec(cmd, args or [])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result
    except asyncio.TimeoutError:
        try:
            await execution.kill()
        except Exception:
            pass  # Best-effort kill
        raise
    except Exception:
        try:
            await execution.kill()
        except Exception:
            pass  # Best-effort kill on any failure
        raise
```

---

## Security Boundaries

### Read-Only Volume Mounts

Use read-only volumes to provide data to the sandbox without risk of modification:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    volumes=[
        ("/host/datasets", "/mnt/data", "ro"),     # Agent can read but not write
        ("/host/config", "/etc/app/config", "ro"),  # Configuration files
    ],
)
```

### SecurityOptions Fields

| Field | Type | Description |
|-------|------|-------------|
| `jailer_enabled` | `bool` | OS-level sandbox (seccomp on Linux, sandbox-exec on macOS) |
| `seccomp_enabled` | `bool` | Syscall filtering (Linux only) |
| `max_open_files` | `int \| None` | Limit open file descriptors |
| `max_file_size` | `int \| None` | Maximum file size in bytes |
| `max_processes` | `int \| None` | Maximum number of processes |
| `max_memory` | `int \| None` | Maximum virtual memory in bytes |
| `max_cpu_time` | `int \| None` | Maximum CPU time in seconds |
| `network_enabled` | `bool` | Allow network access from sandbox (macOS only) |
| `close_fds` | `bool` | Close inherited file descriptors |

### Network Isolation

To prevent an agent from accessing the network:

```python
security = boxlite.SecurityOptions.maximum()
security.network_enabled = False

options = boxlite.BoxOptions(
    image="python:slim",
    security=security,
    # No ports= means no incoming connections either
)
```

> **OS support note:** In the Python bindings, `network_enabled` is currently a macOS-only control. On Linux and other platforms, network isolation is typically enforced by the container/runtime networking configuration (for example, running in an isolated network namespace and not publishing ports), and `network_enabled` may not itself hard-disable all outbound connectivity.

### Resource Limits as Security Boundaries

Resource limits prevent a rogue agent from consuming all host resources:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    cpus=1,             # Cap CPU usage
    memory_mib=512,     # Hard memory limit (OOM kills the box)
    security=boxlite.SecurityOptions.maximum(),
)
```

---

## File Transfer Patterns

### Comparison

| Method | Direction | Best For | Size Limit |
|--------|-----------|----------|------------|
| `box.copy_in()` | Host -> Guest | Files and directories | Large files |
| `box.copy_out()` | Guest -> Host | Extracting results | Large files |
| `exec` + base64 | Either | Small inline data | ~1 MB (shell limit) |
| Volume mounts | Both | Shared datasets, config | No limit |

### copy_in / copy_out

```python
runtime = boxlite.Boxlite.default()
box = await runtime.create(boxlite.BoxOptions(image="python:slim"))

# Copy file into box
await box.copy_in("/host/script.py", "/workspace/script.py")

# Run the script
execution = await box.exec("python", ["/workspace/script.py"])
result = await execution.wait()

# Copy results out
await box.copy_out("/workspace/output.json", "/host/output.json")

await box.stop()
await runtime.remove(box.id)
```

### Inline Data via exec

For small payloads, write data through a command:

```python
import base64

# Send small file via base64
data = b"print('hello from transferred script')"
encoded = base64.b64encode(data).decode()

execution = await box.exec("sh", [
    "-c",
    f"echo {encoded} | base64 -d > /workspace/script.py && python /workspace/script.py",
])
result = await execution.wait()
```

### Volume Mounts

For datasets or configuration that should be available immediately:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    volumes=[
        ("/host/datasets", "/mnt/data", "ro"),   # Input data
        ("/host/results", "/mnt/results", "rw"),  # Output directory
    ],
)
```

**Recommendation:** Use `copy_in`/`copy_out` for dynamic per-request files. Use volume mounts for shared datasets. Use inline base64 only for trivially small payloads.

---

## Terminal Resizing

When running interactive TTY sessions (e.g., an AI agent controlling a shell), use `resize_tty()` to set the terminal dimensions. This ensures proper line wrapping and avoids garbled output from programs that query terminal size.

```python
runtime = boxlite.Boxlite.default()
box = await runtime.create(boxlite.BoxOptions(image="alpine:latest"))

# Start a shell with TTY
execution = await box.exec("sh", tty=True)

# Set terminal size to 40 rows x 120 columns
await execution.resize_tty(40, 120)

# Send commands via stdin
stdin = execution.stdin()
await stdin.send_input(b"ls -la\n")

# Read output
stdout = execution.stdout()
async for line in stdout:
    print(line)
```

**Note:** `resize_tty()` only works on executions started with `tty=True`. Calling it on a non-TTY execution returns an error.

---

## Complete Example

Putting it all together: proper configuration, security, concurrent execution with timeouts, TTY resizing, and cleanup.

```python
import asyncio
import boxlite


async def safe_exec(box, cmd, args=None, timeout=30):
    """Execute with timeout and guaranteed process cleanup."""
    execution = await box.exec(cmd, args or [])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result
    except asyncio.TimeoutError:
        try:
            await execution.kill()
        except Exception:
            pass
        raise


async def main():
    runtime = boxlite.Boxlite.default()

    # Configure box with security and resource limits
    box = await runtime.create(boxlite.BoxOptions(
        image="python:slim",
        cpus=2,
        memory_mib=1024,
        working_dir="/workspace",
        volumes=[
            ("/host/datasets", "/mnt/data", "ro"),
        ],
        security=boxlite.SecurityOptions.maximum(),
    ))

    try:
        # Copy a script into the box
        await box.copy_in("/host/analysis.py", "/workspace/analysis.py")

        # Run with timeout protection
        result = await safe_exec(
            box,
            "python",
            ["/workspace/analysis.py"],
            timeout=60,
        )
        print(f"Exit code: {result.exit_code}")

        # Run concurrent tasks safely
        tasks = [
            safe_exec(box, "python", ["-c", "print('task 1')"], timeout=10),
            safe_exec(box, "python", ["-c", "print('task 2')"], timeout=10),
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, r in enumerate(results):
            if isinstance(r, Exception):
                print(f"Task {i} failed: {r}")
            else:
                print(f"Task {i} exit code: {r.exit_code}")

        # Copy results out
        await box.copy_out("/workspace/results.json", "/host/results.json")

        # Interactive TTY session with resize
        execution = await box.exec("sh", tty=True)
        await execution.resize_tty(40, 120)

        stdin = execution.stdin()
        await stdin.send_input(b"echo 'interactive session'\n")
        await stdin.send_input(b"exit\n")
        await execution.wait()

    finally:
        await box.stop()
        await runtime.remove(box.id)


asyncio.run(main())
```

---

## See Also

- [How-to Guides: Using with AI Agents](README.md#using-with-ai-agents) - Quick-start patterns
- [Python SDK README](../../sdks/python/README.md) - API reference
- [Architecture Documentation](../architecture/README.md) - How BoxLite isolation works
- [Configuration Reference](../reference/README.md) - Full BoxOptions details
