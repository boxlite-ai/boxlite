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
