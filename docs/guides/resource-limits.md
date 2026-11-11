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
`memory_mib` uses binary MiB; disk uses GiB despite the historical `disk_size_gb` name.

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

### Exact Cloud memory allocations

Cloud preserves whole-MiB requests from 128 MiB through the organization's limit.
For example, `memory_mib=300` creates a 300 MiB Box and returns `memory_mib=300`.
The internal API and Runner carry this allocation as `300 / 1024 = 0.29296875` GiB.
Omitting memory retains the existing default; fractional MiB requests are rejected.
Restart, recovery, and checkpoints retain the exact allocation.
Fractional-GiB requests bypass integer-GiB warm pools and their miss cache.

The database's nullable integer `box.memory_mib` is authoritative.
Legacy `box.mem` remains an integer GiB ceiling for compatibility.
The migration backfills existing rows with `mem * 1024`; readers use that fallback
for null rows and checkpoints written by previous versions.
Memory range filters, quotas, admin byte counts, and usage periods use the exact allocation.

Billing event and open-allocation responses round memory GiB half-up to two decimal places:

| Requested memory | Exact GiB in the ledger | Billing `mem` string |
| --- | --- | --- |
| 300 MiB | 0.29296875 | `"0.29"` |
| 512 MiB | 0.5 | `"0.5"` |
| 640 MiB | 0.625 | `"0.63"` |
| 1536 MiB | 1.5 | `"1.5"` |

Trailing zeros are omitted. Event identity uses the exact source quantity, so
allocations that round to the same billing value retain distinct event keys.
Existing queued billing payloads and historical usage periods are not rewritten.

For rollout, pause fractional-memory admissions until all Runners, API instances,
and metering workers support this contract. Upgrade Runners first, run the
pre-deploy migration, then replace every API and metering worker before enabling admissions.
The migration uses a five-second lock timeout; retry during a quiet window if it fails.
Rollback refuses to drop the column while Boxes or retained checkpoints contain
allocations that differ from their legacy GiB values. Reverting application binaries
also requires disabling fractional admissions and resolving those allocations first.

## CPU configuration

Set the CPU allocation with `cpus`; the default remains one virtual CPU.

```python
options = boxlite.BoxOptions(image="alpine:latest", cpus=1.5)
box = await runtime.create(options)
print((await box.info()).cpus)  # 1.5; the guest sees 2 vCPUs
```

| Input | Guest vCPUs | Additional CPU bandwidth quota |
| --- | --- | --- |
| Omitted/null | Existing default: 1 | Applied when spare vCPUs are available |
| `2` or `2.0` | 2 | Applied when spare vCPUs are available |
| `0.5` | 1 | Half a CPU on Linux |
| `1.5` | 2 | 1.5 CPUs on Linux |

Fractional allocations round up only the guest topology; information queries retain the requested value.
They do not reserve physical cores or guarantee latency.
Integer allocations add no new cgroup requirement and continue working on macOS.

**Range:** `0.125` to `16`, in increments of `0.001`, with the bundled guest kernel.
Zero, negatives, non-finite values, and excessive precision are rejected.
A custom kernel may allow up to `255`; the derived integer topology must fit the kernel's existing CPU ceiling.
Existing boxes created above the bundled kernel's ceiling still load and start with the existing warning.
New boxes are additionally bounded by the host ceiling: the smallest of the CPUs the runtime may use
(affinity and cgroup quota) and the hypervisor's per-VM vCPU limit. The bundled
guest kernel additionally limits new boxes to 16 vCPUs; custom kernels are not
bound by that bundled-kernel limit. New boxes above their ceiling fail with
`InvalidArgument`. Reusing an existing box preserves its saved allocation.
Legacy boxes above 16 vCPUs still boot with a warning when using the bundled kernel.

**Spare vCPUs (Linux/libkrun):** so a running box can later gain CPUs, a box boots
with vCPUs up to the host ceiling but only `ceil(cpus)` online (`maxcpus=` on the
guest kernel command line). `nproc` and `/proc/cpuinfo` show the online CPUs;
`/sys/devices/system/cpu/present` shows the ceiling.

- The box cgroup's `cpu.max` caps the whole VMM process at `cpus` CPUs, so
  vCPUs a guest brings online by itself add no CPU time. VMM I/O threads share
  that cap.
- A stricter `max_cpu_time` host limit is kept.
- Without the cgroup `cpu` controller (rootless sessions often lack it),
  allocations boot exactly `ceil(cpus)` vCPUs and have no spares. Fractional
  allocations require an enabled jailer and attempt to apply a CPU quota.
- If a box has spare vCPUs and the cap cannot be written, startup fails.
  Without spares, fractional quota write failures are logged and startup continues.
  With the jailer disabled, integer allocations have no spares. macOS boots
  exactly `cpus` vCPUs.


### Fractional CPUs (Linux)

Linux applies the allocation to the Box's cgroup using a fixed 100 ms period.
For example, `cpus=0.125` writes `12500 100000` to `cpu.max`; `cpus=1.5` writes `150000 100000`.
When cgroup membership succeeds, all vCPU and host VMM/device threads share that budget.
Parallel work can exhaust it early and wait for the next period.
Boot and device I/O also consume this budget; very small allocations can hit existing operation timeouts.

| Condition | Behavior |
| --- | --- |
| Execution host requirements | Linux and an enabled jailer; REST applies these requirements to the server |
| Enforcement requirements | A writable cgroup v2 CPU controller for the Box's cgroup; rootless operation needs CPU delegation |
| Quota write failure | Without spare vCPUs, logged at error level and startup continues without a bandwidth limit; with spare vCPUs, startup fails |
| Membership failure | Existing best-effort joining remains; a Box can start without the requested quota taking effect |
| Local macOS execution | Fractional values return `Unsupported` |
| macOS REST client | Can request fractional CPUs from a supporting Linux server; the client needs no local cgroup support |
| Existing host limits | A tighter `max_cpu_time` quota still applies; its cumulative `RLIMIT_CPU` behavior is unchanged |
| Information queries | Return configured `cpus`, not CPU usage, reserved capacity, or proof of enforcement |

Creation options remain fixed; [online growth](#online-growth) changes the active
allocation and preserves it across restarts. CPU resize targets use the same
0.001-core precision as creation. For example, `0.5 → 0.75` changes only the
bandwidth quota; `0.75 → 1.5` also brings a second vCPU online. Memory-only
growth preserves the current CPU allocation. Shrinking remains unsupported.

Cloud admission uses the current Runner's creation score threshold, READY state
and scheduling flags. It calculates targets from the committed Box size without
querying live resources or reserving capacity. The runtime checks boot ceilings
when executing the job, so admission does not guarantee successful expansion.
Cloud CPU targets use the same 0.125–16 range and organization limits as creation.
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
BoxLite Cloud accepts `cpus` from `0.125` to `16` in increments of `0.001`, subject to the organization's per-Box limit.
The dashboard's Custom CPU input accepts three decimal places and adjusts by `0.1`; invalid input blocks creation.
Older Cloud servers may reject fractional values.

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

**Range:** 1 MiB up to the smallest of host memory and finite `memory.max`
limits across the runtime's visible cgroup ancestry. Creating a box above that
fails with `InvalidArgument`.

**Default:** 1024 MiB

`memory_mib` includes all boot RAM, including the kernel mapping. The guest
reports less in `MemTotal` because the kernel reserves some of it. In particular,
x86 boxes below the MMIO gap no longer receive extra RAM on top of this budget.

**Behavior:**
- The guest can use only allocated RAM; a workload exhausting it can trigger the guest OOM killer.
- Use at least 128 MiB to leave space for the kernel and guest agent.

**Monitor Usage:**

```python
metrics = await box.metrics()
memory_mb = metrics.memory_usage_bytes / (1024**2)
print(f"Memory: {memory_mb:.2f} MB")
```

**Out of Memory:** check the guest console for OOM messages. Increase the allocation
before the workload exhausts it; host memory limits can also terminate the VMM.

## Online growth

A running Linux/KVM box can grow CPUs and memory without restarting its workload.
Targets are absolute. Omitting a resource retains its allocation; omitting both
queries the allocation and the ceilings established for that boot.

```python
resources = await box.resize()
resources = await box.resize(cpus=1.5, memory_mib=2048)
print(resources.cpus, resources.memory_mib)
print(resources.max_cpus, resources.max_memory_mib)
```

The same operation is available as Rust `LiteBox::resize(ResizeOptions)`,
Node `box.resize({ cpus: 1.5, memoryMib: 2048 })`, Go `Box.Resize`,
C `boxlite_resize_box`, and the Python synchronous wrappers. In C and Go,
zero means leave that resource unchanged.

```bash
boxlite resize mybox --cpus 1.5 --memory 2048
boxlite resize mybox
```

REST clients use `POST /v1/boxes/{box_id}/resize` with
`{"cpus":1.5,"memory_mib":2048}`. The response contains `cpus`, `memory_mib`,
`max_cpus`, and `max_memory_mib`.
In `boxlite serve`, empty and all-null requests leave the AutoStop idle clock
unchanged. Parsed explicit targets count as activity, including rejected attempts.

Cloud uses the same SDK and CLI calls, rounding memory targets up to whole GiB:
`await box.resize(memory_mib=1537)` requests 2048 MiB. The control plane saves
the target in a durable job, but the Box keeps its old CPU/RAM and usage period
while the Runner applies the resize. Completion updates the Box and switches the
usage period in one transaction. Retries are bounded; a job that reaches 10
attempts or 30 minutes becomes terminal, releases the lifecycle fence, and leaves
the old size and billing unchanged. A 30-second wait can return `504
resize_in_progress`; retrying the same target joins that job. A different target
conflicts until completion. Box info shows the committed (old until completion)
size; `resize()` with no options queries the Runner's allocation. Stop, delete and
other conflicting lifecycle operations are rejected while resize is active; retry
them after completion or terminal failure. If the Guest exits, resize waits for the
same Box to restart before retrying; it does not restart the Guest itself. A restart
can use old or partially applied resources, so reconciliation is still necessary.

Cloud admission must be enabled by the operator after upgrading the control
plane and Runner; see the [rollout sequence](../../apps/api/README.md#cloud-resize).

- Both targets are validated before applying either. Shrinking, exceeding a
  ceiling, and resizing a stopped box are rejected.
- Local memory grows in increments of 128 MiB relative to the current allocation.
  Its ceiling is limited by host/cgroup memory, KVM slots, and guest address space.
- Unallocated hotplug slots have no KVM mapping and are protected with
  `PROT_NONE`. The reservation adds no guest-usable RAM and commits no host RAM.
  Slots become accessible as the virtio-mem driver plugs them.
- Setting a host memory limit (`SecurityOptions.max_memory` in Python,
  `advanced.security.resource_limits.max_memory` in Rust) disables memory growth:
  that limit also constrains VMM virtual address space. Its memory ceiling equals
  the starting allocation. A kernel without `CONFIG_VIRTIO_MEM=y` likewise
  cannot grow memory.
- Successful allocations survive stop/start and handle recovery. Concurrent
  requests are serialized. A failed request can leave a partial allocation;
  query again and retry the original target. A submitted operation can finish
  after its caller disconnects.
  Startup persists the allocation before publishing Running and cleans up the new
  VM if that write fails. If the first memory
  submission response is lost, a bounded status query recovers any observed mapping.
- `cpus` reports the last committed CPU allocation. If a CPU RPC reply is lost,
  the guest may have brought additional CPUs online while the host attempts
  to restore the previous quota. A resource query still reports the committed
  allocation; retry the original target to reconcile the guest and host state.
  Guest CPU changes alone never increase the host allocation.
- macOS does not support online resize.

See [building from source](../contributing/development/building.md#guest-firmware)
for the firmware needed by memory growth.

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
