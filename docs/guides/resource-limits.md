# Resource limits and tuning

Configure and optimize box resource usage.

## Cloud sandbox sizes

For organizations using the default quotas, an effective subscription unlocks
16 vCPU / 32 GiB memory / 100 GiB disk per Box. Without a subscription, the
limits remain 4 vCPU / 8 GiB / 10 GiB. All subscription plans qualify, including
managed plans. Administrator-defined quota exceptions remain in effect.

| Dashboard size | vCPU | Memory | Disk with subscription | Disk without subscription |
| --- | --- | --- | --- | --- |
| Small | 1 | 1 GiB | 10 GiB | 10 GiB |
| Medium | 2 | 4 GiB | 20 GiB | 10 GiB |
| Large | 4 | 8 GiB | 50 GiB | 10 GiB |
| Custom maximum | 16 subscribed / 4 otherwise | 32 GiB subscribed / 8 GiB otherwise | 100 GiB | 10 GiB |

The creation dialog refreshes organization quotas when opened and clamps all
presets and custom inputs to the returned limits. REST and SDK creation requests
are independently checked by the server; over-limit requests return HTTP 400.
The REST maximum is `cpus=16`, `memory_mib=32768`, `disk_size_gb=100`.
Memory and disk use binary units (GiB), including the historical `disk_size_gb` name.

Canceling renewal retains the higher limits until the paid period ends. Payment
grace also retains them; suspended subscription entitlements or expiry restore
the default creation limits. Effective limits are cached for 30 seconds across
API instances; reads do not extend this lifetime. Subscription upgrades and
withdrawals can therefore take about 30 seconds to appear, including when the
creation dialog is reopened. Concurrent lookups for one organization share a
request within each API process. If no valid cache entry exists and the billing
service cannot verify a grant, the default limits apply. Existing Boxes keep
their resources and may be restarted.
Available runner capacity still determines whether an allowed request can run.

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
