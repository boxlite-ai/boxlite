# Mounting volumes

BoxLite supports host bind mounts and named local volumes. Both use virtio-fs to share a host
directory with the guest.

## Host bind mounts

A bind mount exposes a host directory or file at a path inside the box. Use a tuple for host paths:

```python
import os
import boxlite

async with boxlite.SimpleBox(
    image="python:slim",
    volumes=[
        (os.path.expanduser("~/.config/myapp"), "/etc/myapp", True),
        (os.path.join(os.getcwd(), "output"), "/output", False),
    ],
    working_dir="/output",
) as box:
    result = await box.exec("python", "process.py", "--input", "/etc/myapp/config")
    print(result.stdout)
```

The third tuple element is `read_only`: `True` makes the mount read-only, `False` makes it
read-write. Bind mounts are appropriate when the caller chooses the host path directly.

## Named local volumes

A named local volume is managed by BoxLite rather than by a host path in box configuration. Its
payload survives box deletion and can be mounted by multiple boxes.

Create and inspect volumes with the CLI:

```bash
boxlite volume create --name workspace
boxlite volume ls
boxlite volume get <volume-id>
```

The create command prints a UUID. The name is optional and defaults to that UUID. Get and remove
accept only the canonical id; mount accepts either the id or the name.

Mount by name with the existing shorthand:

```bash
boxlite run --rm -v workspace:/workspace alpine:latest \
  sh -c 'echo hello > /workspace/result.txt'
boxlite run --rm -v workspace:/workspace:ro alpine:latest \
  sh -c 'cat /workspace/result.txt; echo change > /workspace/result.txt'
```

The second box can read the file written by the first. Its read-only mount rejects the attempted
write. Multiple boxes may mount the same volume read-write, but BoxLite does not provide
application-level transactions, write-conflict resolution, or locking for their workloads.

### Typed volume mounts and subdirectories

`--mount` provides the typed form, including `readonly` and `sub_path`:

```bash
boxlite run --rm \
  --mount type=volume,source=workspace,target=/workspace,readonly,sub_path=team/backend \
  alpine:latest
```

`sub_path` must name an existing directory inside the volume. It cannot be absolute, contain `.` or
`..`, or contain a symlink. Only that subdirectory is visible at the mount target; sibling
directories are not mounted. A missing directory returns `NotFound` and is not created implicitly.

The legacy `-v` syntax supports read-only mounts but not `sub_path`. CLI typed mounts support only
`type=volume`; host binds continue to use `-v`.

A single box cannot mount the same canonical volume id more than once, even under different names,
targets, or read-only modes. This is rejected with `InvalidArgument`. Different boxes may still
mount the same id independently.

### Lifecycle, clone, and import

Every persisted box configuration that references a volume prevents its deletion, including
configured, failed, stopped, and running boxes. `boxlite volume rm --force` ignores a missing volume
but does not bypass this protection.

After the last referencing box is removed:

```bash
boxlite volume rm <volume-id>
```

Deleting a box does not delete volume data. Cloning a box or importing a box archive on the same
machine retains the canonical volume id and shares the same payload; it does not copy the data. An
import fails with `NotFound` if the target machine has no volume with that id. Archives do not
create empty replacement volumes or migrate payload automatically.

The CLI's existing anonymous bind directories under `volumes/anonymous/` are unchanged and are not
listed as named volumes.

`size_bytes` is currently unset because BoxLite does not recursively scan volume payload during
CRUD operations.

## QCOW2 container disks

The container rootfs uses a separate QCOW2 disk, not a named volume. It is private to the box and
uses copy-on-write layers shared with image and clone bases. It survives stop only when the box is
kept (`auto_delete=0`).

```python
box = await runtime.create(boxlite.BoxOptions(
    image="postgres:latest",
    disk_size_gb=10,
    auto_delete=0,
))
await box.stop()
box = await runtime.get(box.id)
```

Use named local volumes for independent, shared data resources; use the QCOW2 rootfs for the box's
private container filesystem.

## Performance considerations

- virtio-fs shares host files directly and reflects host/guest changes in real time.
- Metadata-heavy workloads may perform differently from the QCOW2 block-device rootfs.
- Use read-only mounts when possible.
- Mount only the required host directory or volume `sub_path`.
