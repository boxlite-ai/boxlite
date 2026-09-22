# BoxLite image service

`apps/image-service` is the Go module for the services that speak the OCI
distribution protocol on BoxLite's behalf. It holds one binary today, the
**registry proxy** (`cmd/registry-proxy/`).

The registry proxy is how a runner pulls an image that BoxLite has credentials
for and the runner does not. A runner authenticates to the proxy with its own
credential; the proxy authenticates to the upstream registry with the
organization's, and streams the answer straight back. Nothing else about the
pull changes — the manifest bytes a runner receives are the bytes the upstream
served, so the digest a client verifies still holds.

- Place in the platform: [`apps/README.md`](../README.md)

> **Status: scaffold.** The module, the protocol primitives and the process
> lifecycle are in place. The pull endpoints are not: `/v2/` and everything
> under it still answer 404. Only `/health` is served.

## How a pull is addressed

One proxy serves every upstream registry, so the path says which one, and the
organization beside it says who may reach it:

```
GET /v2/<org>/<upstream host>/<repository…>/manifests/<tag or digest>
GET /v2/<org>/<upstream host>/<repository…>/blobs/<digest>

    /v2/acme/ghcr.io/acme/app/manifests/1.2
     └──▶ org "acme" · ghcr.io · acme/app · tag 1.2

    /v2/acme/docker.io/alpine/manifests/3.20
     └──▶ org "acme" · registry-1.docker.io · library/alpine · tag 3.20
                       ▲                      ▲
                       docker.io serves the website, not the registry
                                              Docker Hub implies library/
```

The organization comes from the path and only from the path. A caller's own
credential says which runner is calling, never which organization: runners are
shared and belong to none.

## Layout

| Package | Holds | Must not know |
| --- | --- | --- |
| `internal/oci/` | The distribution protocol: how a pull spells itself in a URL, which endpoint serves a registry host, how to issue that pull upstream. | That anyone is authenticated, rate-limited, or proxied at all. |
| `internal/proxy/` | What only the registry proxy needs: the `<org>/<host>/<repository>` convention, the HTTP surface, and — as they land — caller authentication, per-organization rate limiting, upstream token exchange, and redirect-target checks. | — |
| `cmd/registry-proxy/` | The binary: configuration, telemetry, signals. | — |

The line matters more than it looks. `internal/oci` is reusable by a second
caller exactly to the extent that it stays ignorant of this one; the moment it
learns about organizations or credentials, it is the registry proxy with extra
steps.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REGISTRY_PROXY_PORT` | `4100` | Listen port. Not 5000, the registry convention, because macOS binds it for AirPlay. |
| `SHUTDOWN_TIMEOUT_SEC` | `3600` | How long a drain may take. A blob is one long response, so this has to outlast the longest pull in flight or a deploy truncates an image mid-layer. |
| `ENVIRONMENT` | — | Reported to telemetry. |
| `OTEL_LOGGING_ENABLED` / `OTEL_TRACING_ENABLED` | `false` | Export logs and traces over OTLP. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Collector to export to. Both switches above are inert without it. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Comma-separated `key=value` pairs. |

## Build, test, run

Run these from `apps/`. The Go workspace is `apps/go.work`; commands outside it
will not resolve `common-go`.

```sh
yarn nx test image-service     # go test ./...
yarn nx lint image-service     # go vet ./...
yarn nx build image-service    # dist/apps/registry-proxy
yarn nx serve image-service
```

Coverage is reported through `make coverage:go` from the repository root, which
is also what CI uploads.
