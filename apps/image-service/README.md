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

> **Status: no credentials yet.** The proxy pulls what an upstream serves
> anonymously. Registry credentials, and with them private images, arrive with
> the credential store.

## Endpoints

| Method | Path | Answers |
| --- | --- | --- |
| `GET` `HEAD` | `/v2/` | The version check. Unauthenticated, `401` with a `Basic` challenge. |
| `GET` `HEAD` | `/v2/<org>/<host>/<repo…>/manifests/<tag or digest>` | The upstream manifest, byte for byte. |
| `GET` `HEAD` | `/v2/<org>/<host>/<repo…>/blobs/<digest>` | The upstream blob, streamed. |
| `GET` | `/health` | Liveness, for the platform's probes. |

Everything else under `/v2/` is a `404`: this proxy pulls and does not push.

### Why the version check challenges

A client reads `GET /v2/` to decide whether to send a credential at all.
BoxLite's own runtime does this in `oci-client`: it pings, reads
`WWW-Authenticate`, and **sends nothing on every later request when the header
is absent**. A `200` with no challenge therefore produces a puller that never
authenticates, and the failure surfaces as "the credentials are configured but
every pull is refused".

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

## What a pull passes through

```
GET /v2/acme/ghcr.io/acme/app/manifests/1.2   Authorization: Basic …
 │
 ├─ route          <org>/<host>/<repo> split out            400 if it carries no route
 ├─ authenticate   runner API key → control plane, cached   401 · 503 if it cannot be asked
 ├─ authorize      is ghcr.io a host we pull from?          403
 ├─ meter          this runner's and organization's rate    429 + Retry-After
 │
 ├─ forward        GET https://ghcr.io/v2/acme/app/manifests/1.2
 │                  └─ 401 → read the challenge, fetch a token, retry once
 │                     the token is kept per (org, endpoint, repository)
 │
 └─ relay          status, headers and body, unread and unmodified
```

The caller's own credential stops at `authenticate`: it identifies a runner to
this proxy and means nothing upstream, so it is never forwarded.

Unmodified takes one deliberate act. Go's HTTP transport offers `gzip` on any
request that did not ask for an encoding itself, then decodes the answer and
drops `Content-Encoding` and `Content-Length` on the way — a convenience when
reading a body, a defect when relaying one, since the caller would receive
different bytes under a digest that no longer covers them. Compression is
therefore disabled on the upstream transport, and what the caller asks for is
forwarded so the answer is the caller's own to decode.

Two things are refused rather than forwarded. An upstream host that is not on
the list, because the host arrives in the request path and an authenticated
caller would otherwise choose what this process connects to. And any connection
to an address off the public internet — checked after DNS resolution, on the
resolved address, for the first request and for every redirect a registry
chooses, since a blob handed off with a `302` names an address we did not pick.

## Layout

| Package | Holds | Must not know |
| --- | --- | --- |
| `internal/oci/` | The distribution protocol: how a pull spells itself in a URL, which endpoint serves a registry host, how to issue that pull upstream. | That anyone is authenticated, rate-limited, or proxied at all. |
| `internal/proxy/` | What only the registry proxy needs: the `<org>/<host>/<repository>` convention, the HTTP surface, caller authentication, per-runner and per-organization rate limiting, upstream token exchange, and the address rule. | — |
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
| `BOXLITE_API_URL` | — | **Required.** The control plane. A runner API key is an opaque column rather than a signed token, so a caller can only be checked by asking. |
| `REGISTRY_PROXY_UPSTREAM_HOSTS` | `ghcr.io,docker.io` | Registries this proxy will pull from, written as the names an operator knows — never `registry-1.docker.io`. |
| `REGISTRY_PROXY_CREDENTIAL_TTL` | `60s` | How long a verified caller is taken on trust. Also the delay between revoking a runner and this proxy noticing. |
| `REGISTRY_PROXY_REJECTION_TTL` | `30s` | How long a refused credential is remembered, so a caller with a bad key cannot turn this proxy into a load generator aimed at the control plane. |
| `REGISTRY_PROXY_PULLS_PER_SECOND` / `REGISTRY_PROXY_PULL_BURST` | `50` / `200` | The rate each runner and each organization may pull at. Requests, not bytes: the burst has to clear a whole image. |
| `REGISTRY_PROXY_TRACKED_METERS` | `4096` | How many runners and organizations are metered at once. Past it, callers share one meter rather than being refused. |
| `REGISTRY_PROXY_UPSTREAM_TIMEOUT` | `30s` | Connect and TLS handshake. Not the body: a blob legitimately takes minutes. |
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

## Known limits

- The rate limit is per process. Several instances multiply it, which is the
  trade for not putting a shared store on the pull path.
- Nothing caps how many relays run at once. The meter bounds how fast pulls
  arrive, and a blob is a single long response, so concurrent streams are
  governed by the instance count and its memory rather than by this service.
- The organization in the path is not yet bound to the caller. Nothing links a
  runner to an organization — runners are shared and belong to none — so the
  organization meter is a number the caller can choose, and only the runner
  meter beside it actually bounds anyone. It becomes enforceable when the
  control plane says whose pull this is.
- Addresses in `198.18.0.0/15` are reachable, although that block is reserved
  for benchmarking. VPN and split-DNS resolvers hand it out for ordinary public
  hosts — on a machine running one, `ghcr.io` resolves into it — and refusing
  it would refuse every pull there. The cost is that anything a network places
  in that range is reachable through this proxy as a public host would be.
  None of this stack's own ranges are in it
  ([`providers/gcp/network.ts`](../infra/mdeploy/stack/providers/gcp/network.ts)),
  but the cloud permits it as a subnet range. There is no setting to refuse it:
  a deployment that must is a change to `offInternet` in
  `internal/proxy/guard.go`.
- An allowed registry names its own token endpoint, and any HTTPS one is
  accepted: Docker Hub's is on a different host from its registry, so the two
  cannot be required to match. Nothing is sent to it today, because the
  exchange is anonymous. It becomes a way to steer a credential the moment one
  exists, and belongs with the credential store that introduces it.
