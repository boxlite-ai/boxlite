# Runner-local cache volumes

The runner-backed API accepts a cache as a distinct volume origin:

```python
box = await runtime.create(boxlite.BoxOptions(
    image="alpine:3.23",
    volumes=[{"cache_volume": "build-main", "guest_path": "/cache"}],
))
```

Use `VolumeSpec::cache_volume` in Rust or `cacheVolume` in Node volume options.
The local runtime rejects logical cache IDs: it has no runner scheduler or tenant
context. C/Go runner consumers mount the already-resolved host directory using
the existing bind API. The cloud capability `cache_volumes_enabled` advertises
ordinary cache mounts, not Docker compatibility. Standalone CLI/reference servers
advertise false. SDK REST creation checks the capability before sending a cache.

API volume permissions apply to cache attachment. The authenticated organization
and cache ID identify storage **on the selected runner**. Cache mounts do not
influence placement. The same organization/ID on another runner starts empty and
remains independent; there is no shared storage, synchronization or migration.
Managed durable volumes retain their existing lookup and backend semantics.

The owning runner stores data under its runtime home's
`cache-volumes/<organization>/<id>/data/`. Its sibling `lease.json` is private
metadata and is not mounted in the guest. IDs contain 1–64 ASCII letters, digits,
underscores or dashes. Subpaths, read-only cache mounts, ambiguous origins and
symlinked storage roots are rejected. Public responses contain no host paths.

A cache is exclusively leased for the entire Box lifetime, including stopped
Boxes. Delete the Box before attaching that cache to another Box on this runner.
Stopping a process or guest alone does not release ownership because the Box can
restart. A conflicting create fails explicitly. Deleting a Box retains the data;
runner restart reloads the lease from disk. A lease is reclaimed only after the
native catalog confirms its owner is absent. Unknown state or catalog errors fail
closed. Do not remove a lease file manually while a Box may still use its data.

Query `GET /v1/{prefix}/caches/{runner_id}/{cache_id}` with `volume:read`.
The response includes `type: cache`, `id`, `runner_id`, `in_use`, optional `box_id`
and `idle_since`. Explicit `DELETE` requires `volume:delete` and rejects an owned
cache with 409. A missing cache returns 404. An optional RFC3339 `idle_before`
query parameter restricts deletion to caches observed idle before that time.
There is no automatic pressure eviction: operators collect idle entries explicitly.
The idle clock starts when absence is observed, conservatively delaying collection
after a service outage. Recreating a deleted cache initializes an empty directory.

FS snapshots exclude external cache contents and absolute runner cache paths.
Children inherit no external mounts; supply new cache mounts explicitly in
`create_from_snapshot(..., options=BoxOptions(...))`. Multiple children need
different cache IDs while alive on the same runner.

## Docker data and build-cache reuse

The [guest entrypoint](../../apps/infra-local/fixtures/docker-cache.sh) qualifies
Docker 27.5.1 with classic overlay2 on a 2 GiB sparse ext4 image stored at
`/cache/docker.ext4`. Mount an exclusive runner cache at `/cache`, use the
[DinD firmware and privileged guest option](docker-in-docker.md), and install
`e2fsprogs` and `util-linux` in the pinned guest image
`docker:27.5.1-dind@sha256:ad9e28ccfdf76cf44248258090e07d8353b9628725d8a716bab176bd71200d7d`.
Copy the entrypoint into the guest and run it instead of starting a second daemon.
The [acceptance harness](../../apps/infra-local/compose/docker_cache_acceptance.py)
shows the complete SDK/API/runner setup.

The script checks Docker/dockerd 27.5.1 and containerd v1.7.25 before mounting.
It formats only a new cache, records the exact configuration in `docker-profile`,
refuses mismatches or an unprofiled image, and runs ext4 recovery before reuse.
Profile format 2 also fixes Docker's DNS search list to `.`. This lets bare Swarm
service names resolve through Docker's embedded DNS instead of inheriting the
guest's `localdomain` search suffix. Format-1 caches are rejected before mounting;
use a new cache ID rather than editing the stored profile to force compatibility.
Docker's real root is `/var/lib/docker`; daemon-managed containerd stores its
data at `/var/lib/docker/containerd/daemon` inside the same image. The containerd
image store is explicitly disabled. The underlying runner share is virtiofs;
overlay2 sees ext4, not virtiofs. Direct overlay2 on virtiofs is not qualified.

Send SIGTERM to the entrypoint and wait for `/run/boxlite-docker-cache.loop` to
disappear before deleting the Box for orderly reuse. The entrypoint waits for
Docker shutdown, synchronizes, unmounts and detaches the loop device. The runner
lease still belongs to the Box until native deletion, including after daemon
failure or runner restart. Never mount its image from a second live Box or edit
the private lease. After deleting a failed Box, the next owner checks/replays
ext4; unrepaired filesystem errors fail closed without reformatting.

This persists the **whole daemon state**, including containers, networks and
Swarm membership, rather than just image layers. Remove unwanted workloads and
leave an old Swarm before reusing that data for a new cluster. No compatibility
across Docker versions or storage profiles is promised. Use a new cache ID for
a different configuration. FS snapshots do not capture this external image.

`make test:runner-ci:docker-cache` asserts identical image IDs after deletion and
recreation, unique content with `--pull=never`, repeated COPY/RUN build hits,
real loop backing/storage paths, live and crashed daemon conflicts, checked
recovery, and profile mismatch rejection without changed image bytes. Round 7
passes on macOS arm64 and Linux 6.12.87-boxlite-dind; see the
[qualification record](../contributing/investigations/2026-10-22-f6-cache-attempts.md#f6-round-7--use-the-actual-sdk-cleanup-interface).

Build with `make dev:runner-ci SETUP_DONE=1`; use
`make test:runner-ci:infra ACTION=two-runners` and `make test:runner-ci:cache`.
The harness uses two processes with separate runtime homes on one physical Mac,
fixed Alpine 3.23 guests, readiness deadlines, real API scheduling and retained
failure scenes. Successful probes delete their Boxes, snapshots and test caches.
