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
    
    # Run Python code — fully isolated
    result = await box.run("""
import requests
r = requests.get('https://api.github.com/zen')
print(r.text)
""")
    print(result.stdout)
    # result.stderr, result.exit_code also available
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
            ("/host/data", "/mnt/data", "ro"),  # read-only input
        ],
        security=boxlite.SecurityOptions.maximum(),  # for untrusted AI code
    ))
    
    try:
        execution = await box.exec("python", ["-c", "print('secure exec')"])
        result = await execution.wait()
        print(result.stdout)
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

`asyncio.wait_for()` cancels the Python coroutine but does **not** kill the process inside the VM. Always kill explicitly:

```python
async def exec_with_timeout(box, cmd, args=None, timeout=30):
    execution = await box.exec(cmd, args or [])
    try:
        return await asyncio.wait_for(execution.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        await execution.kill()  # kills the guest process
        raise
```

Use this wrapper instead of bare `await execution.wait()` for any user-provided or LLM-generated code.

---

## Security Presets

```python
# For untrusted / LLM-generated code:
security = boxlite.SecurityOptions.maximum()
# max_open_files=1024, max_file_size=1GiB, max_processes=100

# Disable network access (macOS):
security.network_enabled = False

options = boxlite.BoxOptions(image="python:slim", security=security)
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
