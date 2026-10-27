# Resource limits and tuning

Configure and optimize box resource usage.

## Cloud sandbox sizes

Cloud organizations default to a per-box maximum of **16 vCPU, 32 GiB memory,
and 100 GiB disk**. The console offers these sizes:

| Size | vCPU | Memory | Disk |
| --- | --- | --- | --- |
| Small | 1 | 1 GiB | 10 GiB |
| Medium | 2 | 4 GiB | 20 GiB |
| Large | 4 | 8 GiB | 50 GiB |
| Custom maximum | 16 | 32 GiB | 100 GiB |

Your organization's configured limits take precedence. The console caps presets
and Custom inputs at those limits and shows a contact-support hint when an input
exceeds them. API and SDK requests above a limit are rejected. Raising a limit
does not resize existing boxes; new boxes still need available runner capacity.

Memory and disk use binary GiB. For example, the REST create fields for the
default maximum are `cpus: 16`, `memory_mib: 32768`, and `disk_size_gb: 100`.
These are Cloud organization quotas; local boxes use the host and runtime
constraints described below.

## CPU configuration

**Set CPU Count:**

```python
boxlite.BoxOptions(
    cpus=2,  # 2 CPU cores
)
```

**Range:** 1 to 16. The bundled guest kernel is built with `CONFIG_NR_CPUS=16`
and brings up at most 16 vCPUs, so creating a box with `cpus` outside this
range fails with an invalid-argument error. A box created with a custom kernel
(experimental) is not bound by this limit. A box created with more than 16
vCPUs before this check still starts, logs a warning, and runs on 16.

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

Every box has a container disk, a copy-on-write QCOW2 image that is never smaller than the image.
`disk_size_gb` sets a larger size:

```python
boxlite.BoxOptions(
    disk_size_gb=None  # Image size (default)
)

boxlite.BoxOptions(
    disk_size_gb=20  # At least 20 GB
)
```

The disk lives as long as the box. By default the box is removed when it stops; set
`auto_delete=0` to keep the box, and its disk, after stop.

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
