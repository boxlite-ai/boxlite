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

The right pattern depends on which API level you're using.

### Python — SimpleBox (high-level)

`SimpleBox.exec(cmd, *args, timeout=N)` is variadic, blocks until done, and returns `ExecResult` directly. The SDK handles timeout and kill internally — no manual wrapper needed:

```python
result = await box.exec("python", "-c", code, timeout=30)
return result.stdout
```

### Python — lower-level Box (from `Boxlite.default().create()`)

The lower-level `Box.exec(cmd, args_list)` returns an execution handle. Use `asyncio.wait_for` + explicit kill:

```python
async def safe_exec(box, cmd, args=None, timeout=30):
    execution = await box.exec(cmd, args or [])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result
    except BaseException:
        await execution.kill()  # kill guest process on timeout, cancel, or any error
        raise
```

### Node.js — SimpleBox (high-level)

`SimpleBox.exec()` accepts timeout via options and never throws on non-zero exit:

```javascript
const result = await box.exec('python', ['-c', code], undefined, { timeoutSecs: 30 });
```

### Node.js — JsBoxlite low-level

`JsBoxlite box.exec()` returns a `JsExecution` handle — use explicit kill:

```javascript
async function safeExec(box, cmd, args = [], timeoutSecs = 30) {
  const execution = await box.exec(cmd, args, null, null, null, timeoutSecs);
  const timer = setTimeout(() => execution.kill().catch(() => {}), timeoutSecs * 1000);
  try {
    return await execution.wait();
  } finally {
    clearTimeout(timer);
  }
}
```

**Rule of thumb:** Any `exec()` that runs LLM-generated or user-provided code needs a timeout.

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

This is safe from a **host-isolation** perspective. However, concurrent processes inside the same VM share its filesystem, PIDs, network, and injected secrets — they are not isolated from *each other*. Use this pattern only for trusted/cooperative tasks (e.g., your own agent running independent calculations). For untrusted or multi-user code, use per-request boxes instead.

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
    try:
        await box.stop()
    finally:
        await runtime.remove(box.id, force=True)
```

`stop()` and `remove()` are in nested `finally` blocks so `remove()` runs even if `stop()` raises.

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
import asyncio
import boxlite

_box = None
_runtime = None

async def get_box():
    global _box, _runtime
    if _box is None:
        _runtime = boxlite.Boxlite.default()
        _box = await _runtime.create(boxlite.BoxOptions(image="python:slim"))
        await _box.start()
    return _box

async def shutdown():
    """Call at process exit to clean up the long-lived box."""
    global _box, _runtime
    if _box is not None:
        try:
            await _box.stop()
        finally:
            await _runtime.remove(_box.id)
            _box = None

async def execute_code(code: str, timeout: int = 30) -> str:
    box = await get_box()
    # lower-level Box from runtime.create() — exec() takes a list and returns an execution handle
    execution = await box.exec("python", ["-c", code])
    try:
        result = await asyncio.wait_for(execution.wait(), timeout=timeout)
        return result.stdout
    except BaseException:
        await execution.kill()
        return "Error: execution timed out or cancelled"
```

Note: do **not** use `async with SimpleBox(...) as box` and then assign `box` to a module-level variable — the context manager closes the box when it exits, so the cached reference is already stopped.

For per-request isolation (safer for multi-user):
```python
async def execute_code(code: str, timeout: int = 30) -> str:
    async with boxlite.SimpleBox(image="python:slim") as box:
        # SimpleBox.exec is variadic; timeout is a keyword arg — returns ExecResult directly
        result = await box.exec("python", "-c", code, timeout=timeout)
        return result.stdout
```
