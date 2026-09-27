# infra-local OCI image disk preparation

## TL;DR

Build missing OCI-derived ext4 disks in a short-lived root process before starting infra-local boxes.

## Problem

`make up` creates BoxLite boxes as the developer's ordinary user. On a cold image cache, `ImageDiskManager` assembles OCI layers into a host tree and runs `mke2fs -d`. Files with mode `000` and directories with mode `0555` make the unprivileged path fragile. Running the entire stack as root would also run API, proxy, dashboard, and runner as root and leave root-owned development state.

L1 boxes use the SDK's `BOXLITE_HOME`; the L2 runner has a separate home. This change prepares the fixed L1 service images before starting L1. A runner asked to build an arbitrary new image still needs root privileges.

## Related work and lessons

- BoxLite's [`ImageDiskManager::get_or_create`](../../../src/boxlite/src/images/image_disk.rs#L84) already owns the ext4 cache key and installation. Reuse it rather than build a second disk cache.
- [Firecracker's rootfs guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md#creating-a-linux-rootfs-image) uses a privileged mount to populate ext4. [Firecracker-containerd's builder](https://github.com/firecracker-microvm/firecracker-containerd/blob/main/tools/image-builder/README.md#generation) uses Docker or root for a host build. Both separate image preparation from VM startup; this proposal narrows privilege to cache misses.
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/) uses a user namespace. We infer that it cannot be assumed to reproduce the host-root ownership and metadata path exactly, so rootless parity is outside this deployment change.

## Approach

1. Keep disk path lookup and disk preparation behind a default-off, project-internal Rust feature, used only by the `boxlite-infra-image` build tool. Do not add methods to the published Python SDK, `ImageHandle`, or its backend trait. The tool uses the local runtime's image and disk managers directly, including `ImageDiskManager`'s existing cache key and atomic installation.
2. During `compose up`, run the tool as the developer to resolve each distinct L1 image and check its expected ext4 path. A cache hit proceeds without `sudo`.
3. For a miss, invoke one narrow root subprocess. It calls the same tool to build images in groups of three using a fresh root-owned BoxLite home for each group, so temporary OCI data stays bounded and the developer authenticates once. It exports sparse disks into a temporary directory, transfers their ownership to the invoking user, and prints their paths. The ordinary-user parent verifies the filename, hard-links each disk into its cache directory (requiring the temporary export and cache to share a filesystem), and atomically installs it. It then removes the exported temporary copy.
4. Abort `up` if preparation fails. Never fall back to an ordinary-user OCI build in this workflow. Leave runtime image-building behavior outside infra-local unchanged.

Progress belongs on stderr so the parent can show it during `sudo` while
reserving stdout for the final machine-readable disk paths. Report each image
before preparation and after it finishes; keep subprocess diagnostics visible
while the image is being pulled or converted.
Report the same per-image progress while resolving cache paths, since this step
may pull OCI layers before any root build begins. Show image-store pull and
layer events so a slow registry request is distinguishable from a cached hit.

Root builds use the same host architecture, image reference, and fixed guest-binary headroom as the ordinary runtime. A mutable tag that resolves differently between the two processes fails the expected-filename check. The root home and ordinary home never share a runtime lock or writable tree.

## Alternatives and trade-offs

- `sudo make up` is simpler but elevates all long-running services and changes their state ownership.
- Building inside the ordinary user's home as root requires recursive ownership repair and risks leaving unusable cached layers after failure.
- A fully standalone image-build service would serve production as well, but is outside infra-local's fixed-image startup scope.

## Validation

Test cache-hit and cache-miss decisions, artifact-name mismatch, root subprocess failure, sparse ext4 preservation, and ordinary-user cache installation. Build the internal tool and run the infra-local tests. With a cold L1 cache, verify a root build completes before L1 starts and a second `up` avoids root. Confirm that normal SDK builds omit the internal methods, and document that the L2 runner needs root to build a new uncached image.
