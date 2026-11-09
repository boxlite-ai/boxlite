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

The organization list (`GET /organizations`) returns stored quotas and membership
metadata without looking up subscription grants. For effective creation limits,
use the individual organization endpoint (`GET /organizations/{organizationId}`).

The Dashboard preloads effective limits for the selected organization. Opening
the creation dialog reuses that result and refreshes it in the background;
while open and in the foreground, it checks again every 10 seconds. Returning
to the page or changing a subscription also triggers a refresh. Other
organizations and the membership list are not refreshed by these lookups.

Size controls and Create remain usable throughout. Confirmed limits appear
beside Custom fields. Presets adapt when limits change: Medium restricted to
10 GiB becomes 20 GiB when the subscription grant arrives. Custom retains entered
values unless a confirmed limit requires reducing them; other form input stays
intact. A failed refresh keeps last known limits and shows an inline notice.
Before any result is available, the dialog submits the selected resources
without applying stored membership quotas and leaves validation to the server.
Quota reads have a 10-second timeout and do not show loading or error toasts.
REST and SDK creation requests are independently
checked by the server; over-limit requests return HTTP 400.
The REST maximum is `cpus=16`, `memory_mib=32768`, `disk_size_gb=100`.
Memory and disk use binary units (GiB), including the historical `disk_size_gb` name.

Canceling renewal retains the higher limits until the paid period ends. Payment
grace also retains them; suspended subscription entitlements or expiry restore
the default creation limits. Effective limits are cached for 30 seconds across
API instances; reads do not extend this lifetime. Subscription upgrades and
withdrawals can therefore take about 30 seconds to reach the API. An open
dialog can add up to one 10-second polling interval plus network latency before
showing the result; failures or a backgrounded page can delay it further.
Reopening the dialog or reloading the browser does not bypass the server cache. Concurrent lookups for one organization share a
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
- `cpus` sets integer virtual CPU topology; `cpu_limit` optionally bounds aggregate host CPU time.
- Does not reserve physical cores
- Multiple boxes can exceed host CPU count

**Monitor Usage:**

```python
metrics = await box.metrics()
print(f"CPU time: {metrics.cpu_time_ms}ms")
```

### Creation-only CPU time limit (Linux)

Keep `cpus` as the integer number of virtual CPUs and set `cpu_limit` to bound their shared CPU time:

```python
options = boxlite.BoxOptions(image="alpine:latest", cpus=2, cpu_limit=0.5)
box = await runtime.create(options)
print((await box.info()).cpu_limit)  # 0.5
```

Both vCPUs and host VMM/device threads share this budget; it does not reserve physical cores or guarantee latency.
Linux uses a 100 ms period: `0.5` writes `50000 100000` to `cpu.max`.
Concurrent work can consume the budget early and then wait for the next period.
Boot and device I/O share the budget, so very low limits can reach existing startup or operation timeouts.

| Setting | Contract |
| --- | --- |
| Valid values | `0.01 <= cpu_limit <= cpus`, in increments of `0.001`; omitted CPUs use the existing default |
| Omitted/null | Preserve existing CPU behavior |
| Invalid numbers | Reject zero, negatives, NaN, infinity, excessive precision, and values above resolved CPUs |
| Host requirements | Linux, enabled jailer, and writable cgroup v2 CPU controller; rootless hosts need CPU delegation |
| Enforcement failure | Refuse startup before Guest execution if the quota or process membership cannot be applied |
| macOS | Explicit local limits return `Unsupported`; a REST client follows the server's capabilities |
| Existing host limits | The stricter `max_cpu_time` quota still applies; its cumulative `RLIMIT_CPU` meaning is unchanged |
| Information queries | Report the configured limit, not CPU usage or a stricter effective ancestor/legacy limit |

The limit is immutable after creation; changing or clearing it requires a new Box.
Restart, reconnect, disk snapshot restore, clone, and archive import retain it.
Disk-only `restore_from_archive` keeps the destination Box's existing configuration, including its CPU limit.
An explicit limit on `get_or_create` must equal the saved limit; omission preserves ordinary reuse.

| Interface | Creation | Query |
| --- | --- | --- |
| Rust | `cpu_limit: Some(CpuLimit::new(0.5)?)` | `BoxInfo.cpu_limit` / `CpuLimit::cores()` |
| Python | `BoxOptions(cpu_limit=0.5)` or `SimpleBox(cpu_limit=0.5)` | `BoxInfo.cpu_limit` |
| Node | `{ cpus: 2, cpuLimit: 0.5 }` | `JsBoxInfo.cpuLimit` |
| Go | `WithCPUs(2), WithCPULimit(0.5)` | `BoxInfo.CPULimit` (`nil` when unset) |
| C | `boxlite_options_set_cpu_limit(opts, 0.5, &error)` | Async `boxlite_get_cpu_limit`, delivered by runtime drain |
| CLI | `boxlite create --cpus 2 --cpu-limit 0.5 alpine` | `boxlite inspect` → `CpuLimit` |
| REST/serve | `{"image":"alpine","cpus":2,"cpu_limit":0.5}` | Box response `cpu_limit` |

REST clients require a fresh `cpu_limit_enabled: true` capability before sending an explicit limit.
Older or Cloud servers without that capability are rejected; this feature does not add Cloud scheduling or billing support.
The C query preserves existing structure layouts; Go info/list methods perform an additional lookup per Box using its immutable ID.

Immutable configuration stores integer `cpu_limit_millicpu`; public requests and queries use numeric cores.
Archives containing limits use version 6 so older importers refuse them; ordinary exports retain their previous versions.
Downgrading the local database to older runtimes is unsupported.

Run `make test:cpu-limit:acceptance` on a KVM host with CPU controller delegation to verify aggregate throttling and lifecycle preservation.

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
