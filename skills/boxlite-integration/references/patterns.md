# BoxLite Integration Patterns

## Box Lifecycle

A box goes through: **create → start → exec (N times) → stop → remove**

The key decision is **how long a box lives**:

| Pattern | When to use | Code shape |
|---------|-------------|------------|
| One box per session | Agent is long-running, many tool calls | Create at startup, remove at shutdown |
| One box per request | Multi-tenant, strict isolation | Create in request handler, remove in finally |
| One box per task | Agent does a discrete unit of work | Context manager / `async with` |

**Anti-pattern:** Creating a new box for every `exec()` call. VM startup takes ~1–2s. Reuse the box.

---

## Timeout + Zombie Prevention (critical)

When you cancel `asyncio.wait_for()` (Python) or a Promise timeout (Node), the **host-side coroutine cancels but the guest process keeps running**. You must kill it explicitly.

### Python

```python
async def safe_exec(box, cmd, args=None, timeout=30):
    execution = await box.exec(cmd, args or [])
    try:
        return await asyncio.wait_for(execution.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            await execution.kill()
        except Exception:
            pass
        raise
    except Exception:
        try:
            await execution.kill()
        except Exception:
            pass
        raise
```

### Node.js

```javascript
async function safeExec(box, cmd, args = [], timeoutMs = 30_000) {
  const execution = await box.exec(cmd, args);
  const timer = setTimeout(() => execution.kill().catch(() => {}), timeoutMs);
  try {
    return await execution.wait();
  } finally {
    clearTimeout(timer);
  }
}
```

**Rule of thumb:** Any `exec()` that runs LLM-generated or user-provided code needs this wrapper.

---

## Concurrency

Multiple `exec()` calls can run concurrently on the same box (each spawns a new process in the same VM):

```python
results = await asyncio.gather(
    safe_exec(box, "python", ["-c", "print('task A')"]),
    safe_exec(box, "python", ["-c", "print('task B')"]),
    safe_exec(box, "python", ["-c", "print('task C')"]),
)
```

This is safe — the VM provides isolation from the host. Concurrent processes inside the VM share the VM's resources, so set appropriate CPU/memory limits.

---

## Cleanup (never skip this)

Always stop and remove boxes, even on error:

**Python — context manager (recommended):**
```python
async with boxlite.SimpleBox(image="python:slim") as box:
    result = await box.exec("python", "-c", "print('hello')")
# box stopped and removed automatically
```

**Python — manual:**
```python
box = await runtime.create(options)
try:
    # ... work ...
finally:
    await box.stop()
    await runtime.remove(box.id, force=True)
```

**Node.js — try/finally:**
```javascript
const box = new SimpleBox({ image: 'python:slim' });
try {
  // ... work ...
} finally {
  await box.stop();
}
```

---

## File Transfer

| Method | Direction | Best For |
|--------|-----------|----------|
| `box.copy_in(src, dst)` | Host → Guest | Scripts, config files |
| `box.copy_out(src, dst)` | Guest → Host | Results, artifacts |
| `volumes=[("/host/path", "/mnt/data", "ro")]` | Both | Shared datasets, large files |

```python
await box.copy_in("/host/analysis.py", "/workspace/analysis.py")
result = await safe_exec(box, "python", ["/workspace/analysis.py"])
await box.copy_out("/workspace/results.json", "/host/results.json")
```

---

## Integrating into an LLM Tool Call

The most common pattern — wrapping an agent's `execute_code` tool:

**Before BoxLite:**
```python
async def execute_code(code: str) -> str:
    result = subprocess.run(["python", "-c", code], capture_output=True, text=True)
    return result.stdout
```

**After BoxLite (safe):**
```python
import boxlite

_box = None  # module-level, reused across calls

async def get_box():
    global _box
    if _box is None:
        async with boxlite.SimpleBox(image="python:slim") as box:
            _box = box
    return _box

async def execute_code(code: str, timeout: int = 30) -> str:
    box = await get_box()
    execution = await box.exec("python", ["-c", code])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result.stdout
    except asyncio.TimeoutError:
        await execution.kill()
        return "Error: execution timed out"
```

For per-request isolation (safer for multi-user):
```python
async def execute_code(code: str, timeout: int = 30) -> str:
    async with boxlite.SimpleBox(image="python:slim") as box:
        execution = await box.exec("python", ["-c", code])
        try:
            result = await asyncio.wait_for(execution.wait(), timeout=timeout)
            return result.stdout
        except asyncio.TimeoutError:
            await execution.kill()
            return "Error: execution timed out"
```
