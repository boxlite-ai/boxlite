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

**Range:** 1 to the host ceiling: the smallest of the CPUs the runtime may use
(affinity and cgroup quota) and the hypervisor's per-VM vCPU limit. The bundled
guest kernel additionally limits new boxes to 16 vCPUs; custom kernels are not
bound by that bundled-kernel limit. New boxes above their ceiling fail with
`InvalidArgument`. Reusing an existing box preserves its saved allocation.
Legacy boxes above 16 vCPUs still boot with a warning when using the bundled kernel.

**Behavior:**
- Does not reserve physical cores
- Multiple boxes can exceed host CPU count

**Spare vCPUs (Linux):** so a running box can later gain CPUs, a box boots
with vCPUs up to the host ceiling but only `cpus` online (`maxcpus=` on the
guest kernel command line). `nproc` and `/proc/cpuinfo` show the online CPUs;
`/sys/devices/system/cpu/present` shows the ceiling.

- The box cgroup's `cpu.max` caps the whole VMM process at `cpus` CPUs, so
  vCPUs a guest brings online by itself add no CPU time. VMM I/O threads share
  that cap.
- A stricter `max_cpu_time` host limit is kept.
- Without the cgroup `cpu` controller (rootless sessions often lack it) or with
  the jailer disabled, the box boots exactly `cpus` vCPUs and has no spares.
- If the cap cannot be written, the box fails to start rather than run
  uncapped. macOS boots exactly `cpus` vCPUs.

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

**Range:** 1 MiB up to host memory, or the runtime cgroup `memory.max` when
it is lower. Creating a box above that fails with `InvalidArgument`.

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
resources = await box.resize(cpus=2, memory_mib=2048)
print(resources.cpus, resources.memory_mib)
print(resources.max_cpus, resources.max_memory_mib)
```

The same operation is available as Rust `LiteBox::resize(ResizeOptions)`,
Node `box.resize({ cpus: 2, memoryMib: 2048 })`, Go `Box.Resize`,
C `boxlite_resize_box`, and the Python synchronous wrappers. In C and Go,
zero means leave that resource unchanged.

```bash
boxlite resize mybox --cpus 2 --memory 2048
boxlite resize mybox
```

REST clients use `POST /v1/boxes/{box_id}/resize` with
`{"cpus":2,"memory_mib":2048}`. The response contains `cpus`, `memory_mib`,
`max_cpus`, and `max_memory_mib`.

- Both targets are validated before applying either. Shrinking, exceeding a
  ceiling, and resizing a stopped box are rejected.
- Memory grows in increments of 128 MiB relative to the current allocation.
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
