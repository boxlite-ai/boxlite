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

Set the CPU allocation with `cpus`; the default remains one virtual CPU.

```python
options = boxlite.BoxOptions(image="alpine:latest", cpus=1.5)
box = await runtime.create(options)
print((await box.info()).cpus)  # 1.5; the guest sees 2 vCPUs
```

| Input | Guest vCPUs | Additional CPU bandwidth quota |
| --- | --- | --- |
| Omitted/null | Existing default: 1 | None |
| `2` or `2.0` | 2 | None; preserves integer behavior |
| `0.5` | 1 | Half a CPU on Linux |
| `1.5` | 2 | 1.5 CPUs on Linux |

Fractional allocations round up only the guest topology; information queries retain the requested value.
They do not reserve physical cores or guarantee latency.
Integer allocations add no new cgroup requirement and continue working on macOS.

**Range:** `0.01` to `16`, in increments of `0.001`, with the bundled guest kernel.
Zero, negatives, non-finite values, and excessive precision are rejected.
A custom kernel may allow up to `255`; the derived integer topology must fit the kernel's existing CPU ceiling.
Existing boxes created above the bundled kernel's ceiling still load and start with the existing warning.

### Fractional CPUs (Linux)

Linux applies the allocation to the Box's cgroup using a fixed 100 ms period.
For example, `cpus=0.125` writes `12500 100000` to `cpu.max`; `cpus=1.5` writes `150000 100000`.
When cgroup membership succeeds, all vCPU and host VMM/device threads share that budget.
Parallel work can exhaust it early and wait for the next period.
Boot and device I/O also consume this budget; very small allocations can hit existing operation timeouts.

| Condition | Behavior |
| --- | --- |
| Execution host requirements | Linux, enabled jailer, and writable cgroup v2 CPU controller; REST applies these requirements to the server; rootless operation needs CPU delegation |
| Quota write failure | Startup fails before guest execution |
| Membership failure | Existing best-effort joining remains; a Box can start without the requested quota taking effect |
| Local macOS execution | Fractional values return `Unsupported` |
| macOS REST client | Can request fractional CPUs from a supporting Linux server; the client needs no local cgroup support |
| Existing host limits | A tighter `max_cpu_time` quota still applies; its cumulative `RLIMIT_CPU` behavior is unchanged |
| Information queries | Return configured `cpus`, not CPU usage, reserved capacity, or proof of enforcement |

CPU configuration is immutable after creation.
Restart, reconnect, disk snapshot restore, clone, and archive import retain it.
Disk-only `restore_from_archive` retains the destination Box's CPU configuration.

After option and security compatibility checks, `get_or_create` keeps an existing named Box's saved `cpus` for integer, fractional, and omitted requests.
Local runtimes also check CPU support on their execution host.
For example, an existing `cpus=2` Box stays at `2` when requested with `cpus=0.5`, and returns `created=false`.
The requested allocation applies only when creating a new Box; `create` still rejects duplicate names.

| Interface | Creation | Query |
| --- | --- | --- |
| Rust | `cpus: Some(0.5)` | `BoxInfo.cpus: f64` |
| Python | `BoxOptions(cpus=0.5)` or `SimpleBox(cpus=0.5)` | `BoxInfo.cpus` |
| Node | `{ cpus: 0.5 }` | `JsBoxInfo.cpus` |
| Go | `WithCPUs(0.5)` | `BoxInfo.CPUs: float64` |
| C | `boxlite_options_set_cpus(opts, 0.5)` | `CBoxInfo.cpus: double` |
| CLI | `boxlite create --cpus 0.5 alpine` | `boxlite inspect` → `Cpus` |
| REST/serve | `{"image":"alpine","cpus":0.5}` | Box response `cpus` |

REST clients validate CPU values independently of the client OS and send `cpus` directly in `POST /boxes`, without a CPU-specific `/config` request.
The server checks its execution host before running the Box.
Integer values serialize as integer JSON for compatibility with strict older servers.
A successful fractional create must return exactly the requested allocation.
Missing, rounded, or changed values produce an `Unsupported` error containing the created Box ID; inspect or remove that Box before retrying.
The SDK never retries creation by rounding or dropping the value; ordinary HTTP failures retain their original error classification.
Other features may still use `/config`.
This feature does not add fractional scheduling, capacity accounting, or billing to BoxLite Cloud; older Cloud servers may reject fractional values.

**Compatibility (breaking change):** `Box.cpus` responses may contain fractions that older integer-only clients cannot decode, including in list responses.
Follow the [client migration steps](../reference/README.md#unreleased-fractional-cpu-allocation-breaking-change) before creating fractional Boxes in shared environments.

C CPU parameters and `CBoxInfo.cpus` now use `double`; rebuild C and Go consumers against the matching header and library.
The Simple C API retains its documented `cpus=0` default sentinel; explicit options use the shared positive-value validation.
Go information/list calls obtain CPUs from the existing callback without supplementary per-Box requests.

Persistence stores numeric `cpus`; calculations normalize it to integer millicpu.
Main-branch integer data remains readable, but experimental non-null `cpu_limit` or `cpu_limit_millicpu` records are rejected rather than silently converted.
Fractional archives use version 6; integer exports retain the existing version 3/4/5 selection.
Import supports versions 1–6 and rejects newer archive versions.
Downgrading a local database containing fractional CPUs is unsupported.

Monitor consumption with `box.metrics().cpu_time_ms`.
Run `make test:fractional-cpus:acceptance` on a KVM host with CPU controller delegation to check topology, aggregate throttling, and lifecycle preservation.

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
