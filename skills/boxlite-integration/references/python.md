# BoxLite Python SDK — Integration Patterns

## Installation

```bash
pip install boxlite
```

Requirements: Python 3.10+

---

## API Levels

| Class | Use When |
|-------|----------|
| `CodeBox` | Agent runs Python code snippets — simplest API |
| `SimpleBox` | Agent runs arbitrary shell commands |
| `Boxlite.default()` + `BoxOptions` | Need full control (resources, volumes, security) |
| `Boxlite.rest()` + `ApiKeyCredential` | Cloud / production deployment |

---

## CodeBox — for running Python code

```python
import boxlite

async with boxlite.CodeBox() as box:
    # Install packages inside the sandbox
    await box.install_package("requests")
    
    # run() returns stdout as a plain string regardless of exit code — check result if needed
    stdout = await box.run("""
import requests
r = requests.get('https://api.github.com/zen')
print(r.text)
""")
    print(stdout)
```

`CodeBox` automatically handles: image selection, box creation, cleanup.

---

## SimpleBox — for shell commands

```python
import boxlite

async with boxlite.SimpleBox(image="python:slim") as box:
    result = await box.exec("python", "-c", "print('hello')")
    print(result.stdout)
```

Multiple `exec()` calls on the same box reuse the VM — efficient for agents that run many commands:

```python
async with boxlite.SimpleBox(image="python:slim") as box:
    await box.exec("pip", "install", "numpy")
    result = await box.exec("python", "-c", "import numpy; print(numpy.__version__)")
    print(result.stdout)
```

---

## Full Control — BoxOptions

Use when you need resource limits, volumes, or security presets:

```python
import asyncio
import boxlite

async def main():
    runtime = boxlite.Boxlite.default()
    
    box = await runtime.create(boxlite.BoxOptions(
        image="python:slim",
        cpus=2,
        memory_mib=1024,
        working_dir="/workspace",
        volumes=[
            ("/host/data", "/mnt/data", True),  # read-only mount
        ],
    ))
    
    try:
        execution = await box.exec("python", ["-c", "print('secure exec')"])
        result = await execution.wait()
        print(f"exit code: {result.exit_code}")
        # stdout requires draining execution.stdout() stream — use SimpleBox for buffered output
    finally:
        await box.stop()
        await runtime.remove(box.id)
```

---

## REST API (cloud / production)

```python
import os
import boxlite

runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
    url=os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai/api"),
    credential=boxlite.ApiKeyCredential(os.environ["BOXLITE_API_KEY"]),
))

# Then use runtime.create() / box.exec() as above
```

---

## Timeout + Zombie Prevention

### SimpleBox (high-level)

`SimpleBox.exec` takes `timeout=` directly — the SDK enforces it inside the guest and SIGKILLs the process if it exceeds the limit. No wrapper needed:

```python
result = await box.exec("python", "-c", code, timeout=30)
return result.stdout
```

### Lower-level Box (from `Boxlite.default().create()`)

`Box.exec()` returns an execution handle. `asyncio.wait_for()` cancels the coroutine but does **not** kill the process inside the VM — always kill explicitly. Use `except BaseException` to also catch `CancelledError` (e.g. server shutdown):

```python
async def exec_with_timeout(box, cmd, args=None, timeout=30):
    execution = await box.exec(cmd, args or [])
    try:
        return await asyncio.wait_for(execution.wait(), timeout=timeout)
    except BaseException:
        await execution.kill()  # kills the guest process — BaseException catches CancelledError too
        raise
```

---

## Security Presets

```python
# For untrusted / LLM-generated code:
security = boxlite.SecurityOptions.maximum()
# max_open_files=1024, max_file_size=1GiB, max_processes=100

# Disable network access (macOS):
security.network_enabled = False

# AdvancedBoxOptions is not re-exported from the top-level boxlite package.
# Access it via the native extension:
from boxlite.boxlite import AdvancedBoxOptions
options = boxlite.BoxOptions(
    image="python:slim",
    advanced=AdvancedBoxOptions(security=security),
)
```

| Preset | Use Case |
|--------|----------|
| `development()` | Debugging |
| `standard()` | General workloads |
| `maximum()` | Untrusted AI-generated code |

---

## File Transfer

```python
# Copy file into box before exec
await box.copy_in("/host/script.py", "/workspace/script.py")

# Copy results out after exec
await box.copy_out("/workspace/output.json", "/host/output.json")
```

For shared datasets: use volume mounts in `BoxOptions(volumes=[...])`.
