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
with vCPUs up to the host ceiling (at most 16 with the bundled kernel) but only
`cpus` online (`maxcpus=` on the
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

Online growth also applies to checkpoint-owner boxes. A checkpoint preserves the
actual allocation and provisioned ceilings, including virtio-mem state and mapped
RAM; an imported box can grow again after resume. Resize shares the lifecycle and
capture reservation and refuses Paused boxes. See [checkpoints](checkpoints.md#failure-and-compatibility)
for the saved-state contract and focused KVM functional validation.

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

Cloud uses the same SDK and CLI calls, rounding memory targets up to whole GiB:
`await box.resize(memory_mib=1537)` requests 2048 MiB. The control plane saves
the target, closes the previous usage period and opens a period billed at the
target resources, then dispatches a durable resize job. Failures keep the target
and retry. A 30-second wait can return `504 resize_in_progress`; retrying the
same target joins that job. A different target conflicts until completion.
Box info shows the accepted target; `resize()` with no options queries the
Runner's allocation. Stop, delete and other conflicting lifecycle operations
are rejected until resize completes; retry them afterward. If the Guest exits, resize waits for the same Box
to restart before retrying; it does not restart the Guest itself. A restart can
use old or partially applied resources, so reconciliation is still necessary.

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
