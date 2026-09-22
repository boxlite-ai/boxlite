# Resource limits and tuning

Configure and optimize box resource usage.

## CPU configuration

**Set CPU Count:**

```python
boxlite.BoxOptions(
    cpus=2,  # 2 CPU cores
)
```

**Range:** 1 to host CPU count

**Behavior:**
- Proportional scheduling (shares-based)
- Does not reserve physical cores
- Multiple boxes can exceed host CPU count

**Monitor Usage:**

```python
metrics = await box.metrics()
print(f"CPU time: {metrics.cpu_time_ms}ms")
```

## Memory management

**Set Memory Limit:**

```python
boxlite.BoxOptions(
    memory_mib=1024,  # 1 GB
)
```

**Range:** 128 to 65536 MiB (64 GiB)

**Default:** 512 MiB

**Behavior:**
- Hard limit (box killed if exceeded)
- Minimum 128 MiB required

**Monitor Usage:**

```python
metrics = await box.metrics()
memory_mb = metrics.memory_usage_bytes / (1024**2)
print(f"Memory: {memory_mb:.2f} MB")
```

**Out of Memory:**
- Box process is killed
- Check stderr for OOM messages
- Increase `memory_mib` if needed

## Disk configuration

**Ephemeral (Default):**

```python
boxlite.BoxOptions(
    disk_size_gb=None  # No persistent disk
)
```

**Persistent:**

```python
boxlite.BoxOptions(
    disk_size_gb=20  # 20 GB persistent disk
)
```

**Performance:**
- Ephemeral: Fastest (in-memory/tmpfs)
- QCOW2: Moderate (copy-on-write overhead)

**I/O Monitoring:**
- Currently not exposed in metrics
- Future feature

## Scaling multiple boxes

**Resource Pooling:**

```python
import asyncio
import boxlite

async def run_box(box_id):
    async with boxlite.SimpleBox(
        image="python:slim",
        cpus=1,
        memory_mib=512,
    ) as box:
        result = await box.exec("python", "-c", f"print('Box {box_id}')")
        return result.stdout

async def main():
    # Run 10 boxes concurrently
    tasks = [run_box(i) for i in range(10)]
    results = await asyncio.gather(*tasks)

    for i, result in enumerate(results):
        print(f"Box {i}: {result}")

asyncio.run(main())
```

**Concurrency Limits:**
- Limited by host resources (CPU, memory)
- Each box: minimum 128 MiB + overhead
- Monitor with `(await runtime.metrics()).active_boxes`

**Best Practices:**
- Use asyncio for concurrent execution
- Configure appropriate resource limits
- Monitor metrics to avoid oversubscription
