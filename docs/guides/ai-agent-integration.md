# AI agent integration guide

This guide covers best practices for integrating BoxLite as a sandboxed execution environment for AI agents. It starts with quick patterns, then covers configuration, concurrency, timeouts, security, and file transfer in depth.

## Table of contents

- [Quick Patterns](#quick-patterns)
- [Recommended Configuration](#recommended-configuration)
- [Concurrency Model](#concurrency-model)
- [Timeout Handling and Zombie Prevention](#timeout-handling-and-zombie-prevention)
- [Security Boundaries](#security-boundaries)
- [File Transfer Patterns](#file-transfer-patterns)
- [Terminal Resizing](#terminal-resizing)
- [Complete Example](#complete-example)

---

## Quick patterns

### CodeBox for AI code execution

**Use Case:** AI generates Python code that needs execution.

**Example:**

```python
import asyncio
import boxlite

async def execute_ai_code(code: str):
    """Execute untrusted AI-generated code safely."""
    async with boxlite.CodeBox() as codebox:
        try:
            result = await codebox.run(code)
            return {"success": True, "output": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

# AI-generated code
ai_code = """
import requests
response = requests.get('https://api.github.com/repos/python/cpython')
data = response.json()
print(f"Stars: {data['stargazers_count']}")
"""

result = asyncio.run(execute_ai_code(ai_code))
print(result)
```

### Multiple tools in one box

AI agents often need multiple tools. BoxLite provides a full Linux environment.

**Example:**

```python
async with boxlite.SimpleBox(image="python:slim") as box:
    # File system access
    await box.exec("mkdir", "-p", "/workspace")

    # Python code execution
    await box.exec("python", "-c", "print('Hello')")

    # Package installation
    await box.exec("pip", "install", "requests")

    # Network requests
    await box.exec("curl", "https://api.github.com/zen")

    # File manipulation
    await box.exec("echo", "data", ">", "/workspace/file.txt")
```

### Capturing output

**Streaming Output:**

```python
runtime = boxlite.Boxlite.default()
low_level_box = await runtime.create(boxlite.BoxOptions(image="python:slim"))
execution = await low_level_box.exec("python", ["long_running_script.py"])

# Stream stdout in real-time
stdout = execution.stdout()
async for line in stdout:
    print(f"AI Output: {line}")

    # Parse and react to output
    if "ERROR" in line:
        await execution.kill()  # Stop on error
        break

await low_level_box.stop()
```

**Exit Codes:**

```python
result = await box.exec("command")

if result.exit_code == 0:
    print("Success!")
else:
    print(f"Failed with code {result.exit_code}")
    print(f"Error: {result.stderr}")
```

### Performance tips

**Reuse Boxes:**

```python
# Create once, use many times
async with boxlite.SimpleBox(image="python:slim") as box:
    for code in ai_generated_codes:
        result = await box.exec("python", "-c", code)
        # Process result
# The box stops when the block exits
```

**Batch Operations:**

```python
# Execute multiple commands in one box (faster than creating new boxes)
async with boxlite.SimpleBox(image="python:slim") as box:
    await box.exec("pip", "install", "requests")
    result1 = await box.exec("python", "script1.py")
    result2 = await box.exec("python", "script2.py")
    result3 = await box.exec("python", "script3.py")
```

**Monitor Resources:**

```python
metrics = await box.metrics()
if metrics.memory_usage_bytes > 0.8 * (1024**3):  # 80% of 1GB
    print("Warning: High memory usage")
    # Consider recreating box or increasing limit
```


---

## Recommended configuration

### Workload-type reference

| Workload | Image | CPUs | Memory | Disk | Notes |
|----------|-------|------|--------|------|-------|
| Code execution | `python:slim` | 1 | 512 MiB | None | Removed on stop, fast startup |
| Data analysis | `python:slim` | 2 | 2048 MiB | None | More memory for pandas/numpy |
| Web browsing | Use `BrowserBox` | 2 | 2048 MiB | None | Chromium needs resources |
| Multi-tool agent | `python:slim` | 2 | 1024 MiB | None | Balance cost vs. capability |
| Persistent env | `python:slim` | 1 | 512 MiB | 10 GB | `auto_delete=0` keeps state across stop |

### Starter configuration

```python
import boxlite

options = boxlite.BoxOptions(
    image="python:slim",
    cpus=2,
    memory_mib=1024,
    working_dir="/workspace",
    advanced=boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions.maximum()),
)
```

### Security presets

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
```

---

## Concurrency model

### One box, multiple executions (recommended)

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
        advanced=boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions.maximum()),
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
        await box.stop()  # also removes the box by default
```

**When to use:** Most AI agent scenarios. Keeps VM boot cost to one-time.

### One box per agent

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

## Timeout handling and zombie prevention

### The problem

`asyncio.wait_for()` cancels the Python coroutine but does **not** kill the guest process. Without explicit cleanup, the process continues running inside the VM indefinitely.

```python
# BAD: process keeps running inside the box after timeout
try:
    execution = await box.exec("python", ["-c", "import time; time.sleep(9999)"])
    result = await asyncio.wait_for(execution.wait(), timeout=5)
except asyncio.TimeoutError:
    print("Timed out")  # Process is still running in the VM!
```

### Correct pattern

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

### Defensive helper

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

## Security boundaries

### Read-only volume mounts

Use read-only volumes to provide data to the sandbox without risk of modification:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    volumes=[
        ("/host/datasets", "/mnt/data", True),     # Agent can read but not write
        ("/host/config", "/etc/app/config", True),  # Configuration files
    ],
)
```

### SecurityOptions fields

| Field | Type | Description |
|-------|------|-------------|
| `jailer_enabled` | `bool` | OS-level sandbox (seccomp on Linux, sandbox-exec on macOS) |
| `seccomp_enabled` | `bool` | Syscall filtering (Linux only) |
| `max_open_files` | `int \| None` | Limit open file descriptors |
| `max_file_size` | `int \| None` | Maximum file size in bytes |
| `max_processes` | `int \| None` | Maximum number of processes |
| `max_memory` | `int \| None` | Maximum virtual memory in bytes |
| `max_cpu_time` | `int \| None` | Maximum CPU time in seconds |
| `network_enabled` | `bool` | Network grants of the host-side sandbox (seatbelt on macOS, Landlock on Linux); does not disable guest networking |
| `close_fds` | `bool` | Close inherited file descriptors |

### Network isolation

To prevent an agent from accessing the network:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    # No network interface in the box
    network=boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="disabled")),
    # No ports= means no incoming connections either
)
```

`SecurityOptions.network_enabled` does not take the guest offline: it only drops the host sandbox's
own network grants, and BoxLite rejects `network_enabled=False` while the box's network is enabled.

### Resource limits as security boundaries

Resource limits prevent a rogue agent from consuming all host resources:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    cpus=1,             # Cap CPU usage
    memory_mib=512,     # Hard memory limit (OOM kills the box)
    advanced=boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions.maximum()),
)
```

---

## File transfer patterns

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

await box.stop()  # also removes the box by default
```

**Ownership (`copy_in` only):** files arriving in the box are owned by its exec user (the
image's `USER`, or the `user` you set on `BoxOptions`), so an agent running as a non-root
user can read them without any `chmod`/`chown` of its own. Directories created to hold the
copy get the same owner. `copy_out` writes to the host and leaves host ownership alone.

**Paths under a mount are refused, in both directions.** `copy_in`/`copy_out` work on the
rootfs layer from outside the container's mount namespace, so a path at or under a mount —
`/tmp`, `/dev/shm`, a volume, or the `/etc/{hosts,hostname,resolv.conf}` binds — resolves
to a different file than the one the workload sees. Rather than transfer something
invisible, `copy_in` refuses such a destination and `copy_out` refuses such a source.

The two directions differ on a directory that merely *contains* a mount. `copy_out` refuses
it outright — the archive would carry the image's file rather than the mounted one. `copy_in`
allows it and checks per entry instead, refusing only if some entry would land *on* a mount:
copying a directory into `/etc` is fine, and becomes a refusal only when an entry resolves
to `/etc/hosts`, `/etc/hostname`, or `/etc/resolv.conf` — which needs `include_parent=False`,
since the default nests everything under the source directory's own name.

Use a path outside the mount (`/workspace` is a good default), or pipe a tar through
`exec`, which runs inside the namespace:

```python
execution = await box.exec("tar", ["xf", "-", "-C", "/tmp"])
stdin = execution.stdin()
await stdin.send_input(tar_bytes)
await stdin.close()
await execution.wait()
```

### Inline data via exec

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

### Volume mounts

For datasets or configuration that should be available immediately:

```python
options = boxlite.BoxOptions(
    image="python:slim",
    volumes=[
        ("/host/datasets", "/mnt/data", True),   # Input data
        ("/host/results", "/mnt/results", False),  # Output directory
    ],
)
```

**Recommendation:** Use `copy_in`/`copy_out` for dynamic per-request files. Use volume mounts for shared datasets. Use inline base64 only for trivially small payloads.

---

## Terminal resizing

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

## Complete example

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
            ("/host/datasets", "/mnt/data", True),
        ],
        advanced=boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions.maximum()),
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
        await box.stop()  # also removes the box by default


asyncio.run(main())
```

---

## See also

- [Python SDK README](../../sdks/python/README.md) - API reference
- [Security](../concepts/security.md) - How BoxLite isolation works
- [Configuration Reference](../reference/configuration.md) - Full BoxOptions details
