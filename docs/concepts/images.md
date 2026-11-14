# Images

BoxLite uses OCI-compatible container images with intelligent caching.

## Startup command overrides

An image's `ENTRYPOINT` and `CMD` form the container's main command.
`BoxOptions.entrypoint` replaces the image's entrypoint; a nonempty override also
discards the image's default CMD.
Use `BoxOptions.cmd` to supply new arguments.

| User entrypoint | User cmd | Main command |
| --- | --- | --- |
| Omitted | Omitted or empty | Image ENTRYPOINT + image CMD |
| Omitted | Nonempty | Image ENTRYPOINT + user cmd |
| Nonempty | Omitted or empty | User entrypoint only |
| Nonempty | Nonempty | User entrypoint + user cmd |

For an image with `CMD ["sleep", "infinity"]`, setting
`entrypoint=["python3", "-m", "http.server", "8080"]` runs that HTTP server
without appending `sleep infinity`. The CLI's `--entrypoint EXEC` and trailing
`COMMAND` use the same override rules.

These rules apply on every start, including existing boxes. Earlier releases
appended the image CMD to nonempty entrypoint overrides. To keep those arguments,
set `cmd` explicitly when creating the box.

## Image pull flow

```text
Registry (Docker Hub, GHCR, ECR, etc.)
           │
           ▼
┌─────────────────────┐
│   OCI Client        │  Pull manifest and layers
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   ImageStore        │  Store layers in ~/.boxlite/images/layers/
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Layer Extraction  │  Extract to cached layer directories
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Rootfs Assembly   │  Combine layers for Box rootfs
└─────────────────────┘
```

## Caching strategy

- **Blob-level caching**: Image layers stored by digest, shared across images
- **Layer deduplication**: Common base layers (e.g., debian:slim) extracted once
- **Copy-on-write**: Boxes share base layers, only modifications are per-Box

## When the registry is asked

A box's disk is built from its image once, at its first start. That build is the one
pull that asks the registry, when the reference can have moved:

| Reference | New box | Restart |
|--|--|--|
| A tag, e.g. `alpine:3.20` (or none, meaning `latest`) | Asks the registry what the tag points to now; reuses every cached layer | Reuses the box's disk and reads its config from the cached build it was made from |
| A digest, e.g. `alpine@sha256:…` | Answered from the cache; a digest this host has not cached is pulled once | Reuses the box's disk |

A restart finds that build by the digest recorded when its disk was built. A box made by a
release that recorded none reads the image by reference instead: a tag's cache entry keeps the
build this host first cached for it, even after a new box follows the tag, and that is the
build such a box was made from.

When the registry gives no answer — offline, unreachable, a server error, or a rate limit
— the new box is built from the build this host first cached for that reference instead.
With nothing cached, a rate limit is reported as a resource-exhausted error that says to
retry later. A registry that answers, for example that the image does not exist, is
reported as an error. `images().pull()` answers from the cache first and does not re-check
a cached tag.

## Removing local images

Use `boxlite rmi 1f8c03c8f5e5` to reclaim an unwanted local image by manifest ID.
Full lowercase SHA-256 IDs and unambiguous hexadecimal prefixes are accepted.
Every untagged cache reference to that manifest is removed across repositories.
An explicit digest reference does not prevent deletion.

| Condition | Outcome |
| --- | --- |
| Any tag references the manifest | Refused; the error lists the tags |
| Any existing box depends on it | Refused; the error lists box IDs, including stopped and configured boxes |
| Cache data is shared with a retained image | Shared configuration, layers and disk caches remain |
| A pull, image handle or box initialization holds the cache | Refused as busy; release the handle or finish the operation, then retry |
| The selected runtime uses REST | Unsupported; local cache data is untouched |

Recorded box manifest digests protect their exact build.
Legacy or uninitialized boxes without a recorded digest conservatively protect matching repositories, including unqualified registry-search names.
Missing dependency metadata preserves cache contents whose ownership cannot be established.

Reclamation covers unused manifests, configurations, compressed and extracted layers.
Pure image disk caches are also reclaimed when no retained build shares their layer key and no boxes exist.
When boxes exist, pure disk caches remain because their backing chains can outlive image-index records.
Versioned guest bases, snapshots and local-bundle caches keep their existing lifecycle.

The result reports allocated bytes removed, including zero when files are absent or data remains shared.
It accounts for sparse files and hardlinks; filesystem snapshots and reflinks may defer physical free-space changes.
The value therefore does not promise an equal change in the filesystem's global free-space counter.

Eligibility errors leave the target intact.
Filesystem and SQLite updates are not one atomic transaction: an I/O failure can leave the target cache incomplete.
Retry removal, or pull the image again to restore missing data; retained images and protected boxes keep their data.

SDKs expose the same operation as `images.delete()` in Rust, Python and Node.js,
`images.Delete()` in Go, and
`boxlite_image_delete()` in C.
Python's synchronous handle also provides `delete()`.
Results contain the resolved full image ID, removed references and reclaimed bytes.

The SDK uses `delete(id)` for local cache reclamation and keeps `remove(name)` for its existing contract.
Choose the operation by its effect, not just the form of its argument:

| Operation | Local runtime | REST runtime |
| --- | --- | --- |
| `remove(name)` | Forgets every reference under the name and retains cache files | Removes the catalog entry, subject to box dependency checks |
| `delete(id)` | Removes an eligible manifest and reclaims its unused cache data | Unsupported, without sending a request |

For example, `remove("docker.io/library/alpine")` leaves reusable layers on disk;
`delete("1f8c03c8f5e5")` checks dependencies and reclaims only data no retained image needs.
The CLI's `rmi` command uses the SDK's `delete` operation.

Dashboard deletion removes an organization catalog entry and leaves runner cache bytes in place.

## Registry tags and catalog aliases

A registry tag is an upstream name for a manifest digest. A BoxLite alias is
an organization-scoped catalog binding to a recorded version. A successful
registry pull seeds an alias using the tag it resolved; later pulls never
silently replace that binding.

REST image handles expose `create_alias(name, alias, digest)` and
`delete_alias(name, alias)`. Creation rejects every existing name with
`AlreadyExists`, including requests for the same digest. Changing a binding
requires explicit deletion followed by creation. Deletion leaves versions and
existing boxes unchanged; neither operation updates the upstream registry.

Registry credentials are managed through `runtime.images.registries` in Python
and Node, `runtime.images()?.registries()?` in Rust and `images.Registries()` in
Go. Embedded runtimes use their configured image registry logins instead.

## Cache access and local IDs

`images.resolve_ids()` resolves a batch against one raw local cache snapshot.
Each input returns its own full manifest ID or an invalid, unknown, or ambiguous-ID error.
Repeated references to one manifest count as one match; explicit digest references are included.
REST runtimes return Unsupported without sending a request.

Pulls, image objects, box creation, and initialization retain shared cache access.
Image-object clones and detached extraction workers also retain the runtime home lock.
Release all consumers before reopening that home in another runtime.
Use `images.delete()` to reclaim an eligible local image; see [removal semantics](#removing-local-images).
