# Outbound proxy contract

**Status:** Proposed capability. This contract and its fixture scenarios define the behavior
that later changes will implement and verify.

The host enforces a Box's selected proxy through the existing
[outbound snapshot](outbound-contract.md#connection-ownership). Destination policy checks
the business target first. The captured transport then connects to the approved literal IP
and port, preserving the hostname for origin TLS and HTTP.

The proposed paths use the same captured route for approved TCP and external DNS queries.

```mermaid
flowchart LR
    guest[Guest]
    subgraph host[BoxLite host]
        snapshot[Outbound snapshot]
        target[Destination checks]
        dns[Gateway and host resolvers]
    end
    guest -->|TCP| target
    guest -->|DNS| dns
    snapshot -.->|Captured route| target
    snapshot -.->|Captured route| dns
    target -->|Approved IP and port| proxy[Registered proxy]
    dns -->|Pinned DoH endpoint| proxy
    proxy --> business[Business target]
    proxy --> doh[DoH service]
```

## Registration and binding

An organization can register named proxies, each with one public endpoint URL. A Box selects
at most one registration by name in `network.outbound.proxy`. Names are immutable and unique
within the organization, matching `^[a-z0-9][a-z0-9-]{0,62}$`.

Under the existing organization prefix, `/proxies` accepts `POST` and `GET`, and
`/proxies/{name}` accepts `GET`, `PATCH`, and `DELETE`.

Members may read. Dedicated organization permissions govern mutation, and Box writers may
bind within their organization.
Missing and foreign names both return HTTP `404`.

The optional `credential` is a write-only object with `username` and `password` strings.
Omitting it on `PATCH` preserves it, and explicit `null` clears it. A change in scheme or
authority for a credentialed registration requires an explicit credential choice.

Registry readbacks expose the name, canonical URL, registration revision, and
`credential_configured`. Credential material travels only through authenticated host
control. Registry and outbound readbacks, Guest inputs, ordinary Box options, logs, and
exports omit it.

### Cloud registry

The registry uses the current organization from the Box API authentication context.
Members can list and read registrations. Creating or updating one requires
`write:proxies`, and deleting one requires `delete:proxies`.

Credential submission uses JSON over the REST API. The MCP operation catalog excludes
credential writes.

API key and organization role requests and responses carry outbound proxy grants in
the optional `proxyPermissions` array. For example, use `permissions: ["write:boxes"]`
and `proxyPermissions: ["write:proxies"]` to grant both capabilities. The existing
`permissions` field retains its published values.

When updating a role, omit `proxyPermissions` to keep its current proxy grants or send
`[]` to clear them. A role must have at least one permission across both fields.

Cloud stores each accepted revision with its own authenticated credential envelope.
For example, a successful `PATCH` that returns revision 2 reports what the registry
accepted. A Box may still hold revision 1.

An active or pending reference protects its exact revision and blocks deletion with `409`.

The API enables the registry with `OUTBOUND_PROXY_REGISTRY_ENABLED=true`.
Operators supply `OUTBOUND_PROXY_REGISTRY_KEYS` as a deployment secret containing a JSON
map from key IDs to Base64-encoded 32-byte keys. The API checks that its configured ring
can read every retained key ID before starting with the registry enabled.

Provision dedicated, unique key material and keep older keys for persisted envelopes and backups.
Provision the next key to every reader before activation.
Activate the initial key before submitting credentials to a new registry.

The registry store can activate a key and re-encrypt a revision while preserving
its identity. It can retire an inactive key after its last envelope is gone.

Enable the feature only on a deployment qualified to fence the previous database
generation during cutover. Runner credential dispatch and recovery also require
exact-epoch validation.

| Box input | Required behavior |
| --- | --- |
| Create with `proxy` omitted or `null` | Leave the Box unbound. |
| Create or replace with a registration name | Resolve it in the Box's organization. |
| Complete replacement omits `proxy` on a bound Box | Reject the incomplete replacement, including while outbound is disabled. |
| Complete replacement specifies `proxy: null` | Request explicit unbind through revisioned control. Destination policy still applies. |
| Disabled mode includes a binding | Retain the binding and block new egress. |

For example, `{"mode":"enabled","allow_net":["packages.example.com"],"proxy":"build-egress"}`
selects `build-egress` for allowed traffic. Failure to use the proxy ends the attempt.

The first release requires enrolled HTTPS Runner V0 with proxy bootstrap, staging, and
readback support for every binding. Bound create skips the warm pool. Ineligible placements
fail before dispatch or credential delivery, including HTTP-only and V2 Runners.

A protected Box can unbind only if its assigned Runner can attest the exact unbound state.
If the Runner cannot do so, refuse before reservation or dispatch and retain the existing
binding and references.

## Protocols and DNS

| Scheme | Default port | Tunnel and authentication |
| --- | --- | --- |
| `http` | 80 | HTTP/1.1 CONNECT, unauthenticated or Basic over plaintext TCP. |
| `https` | 443 | HTTP/1.1 CONNECT inside TLS, unauthenticated or Basic with verified endpoint identity. |
| `socks5` | 1080 | SOCKS5 CONNECT, unauthenticated or RFC 1929 username/password over plaintext TCP. |

Canonicalize the URL host and reject userinfo, query, fragment, non-root paths, invalid ports,
and unsupported schemes. Each credential field has 1–255 printable ASCII bytes, and a Basic
username cannot contain a colon.

Reject redirects, authentication downgrade, and SOCKS
commands other than CONNECT. Use TLS CONNECT for first-hop credential confidentiality.

Normalize mapped IPs before candidate checks. Refuse private, deployment-protected, and
non-public special addresses, including the host alias.

Check both pre-NAT and approved connection addresses for business TCP. Ordinary TCP,
inspected TCP, and secrets MITM use the same selected route.

Setup, including resolution and candidate retries, has a 30-second budget or the shorter
caller deadline. Direct bootstrap DNS resolves only registered proxy endpoint names.

Gateway DNS serves local records. With a binding, both gateway listeners and the host business
resolver send external lookups to a deployment-pinned DoH endpoint through the captured proxy.
An unbound route uses its configured system resolver.

Proxy or DoH failure ends the operation. A proxy-capable bridge limits external DNS to 64
concurrent lookups and accepts up to 32 gateway TCP DNS sessions in either mode.

The lookup budget is five seconds. The bridge closes a session after a ten-second message read or write deadline.

Bind blocks external UDP, including UDP DNS and QUIC, and closes existing external UDP endpoints
before acknowledgement. The UDP delivery boundary is a complete frame written to the guest-link
Unix socket. The bridge discards old replies still queued for that writer and waits for admitted writes.

Guest reads can occur after acknowledgement for frames completely written before it. A partial
stream frame leaves the link unusable for confirmation until framing is re-established. Shutdown closes
the guest-link socket to release blocked writes before joining delivery work.

Gateway DNS and DHCP remain available. Unbind restores ordinary policy for new direct endpoints.

The trusted host startup call selects a proxy-capable bridge. It supplies an optional binding
separately from the ordinary bridge configuration.

The host-only snapshot PUT carries the next route and its revision. A null route explicitly unbinds.
The services socket exposes the same zone store as the two managed DNS listeners.

```text
Bound DNS lookup → captured proxy → pinned DoH
Old UDP reply → IPv4 fragments retain the generation → tap → guest-link writer drops sealed fragments
```

The UDP relay marks replies with their generation. The bridge applies two version-pinned dependency
patches to preserve that marker through IPv4 fragmentation and the tap frame writer.

The native archive build, bridge unit tests, coverage, and vet use the same patch script. It runs
`git apply` on temporary copies, so the module cache and any local vendor tree keep their upstream sources.

Dependency upgrades must rebase both patches and pass the real-tap IPv4 fragment test.

### Bridge proxy connector

The bridge connector accepts one approved proxy socket address and a checked IPv4 TCP target.
It verifies both business addresses and the proxy address before opening a socket.
HTTPS verifies the endpoint certificate chain and registered name before sending CONNECT.

The connector caps all HTTP response headers for a tunnel at 32 KiB, including interim replies.
A final 2xx starts raw tunnel data at the end of the headers, regardless of HTTP body framing.
SOCKS5 offers exactly one authentication method and validates the complete reply before returning.

One deadline covers dial, TLS and proxy negotiation, and the connector releases the socket on failure.
The by-name dialer can advance past a refused connection IP or a well-formed SOCKS5 host-unreachable or
connection-refused reply. Proxy failures stop the operation, and combined setup remains bounded
by the original deadline.

```mermaid
sequenceDiagram
    participant D as TCP dialer
    participant C as Proxy connector
    participant P as Selected proxy
    D->>C: Approved target and setup deadline
    C->>C: Check proxy and business addresses
    opt Addresses pass the checks
        C->>P: Dial and negotiate within the deadline
        P-->>C: Proxy reply
    end
    alt Successful setup
        C->>C: Clear deadline and finish cancellation handoff
        C-->>D: Tunnel with buffered bytes
    else Candidate-specific refusal
        C->>C: Close any setup socket
        C-->>D: Refusal allows another candidate
        opt Budget remains
            D->>C: Try the next approved address
        end
    else Proxy failure or budget expiry
        C->>C: Close any setup socket
        C-->>D: End setup with a redacted error
    end
```

The bridge pins its public address tables in [proxy_address_ranges.csv](../../../src/deps/libgvproxy-sys/gvproxy-bridge/proxy_address_ranges.csv).
Deployment deny prefixes override registry results.

The longest special-purpose match must be globally reachable. Native IPv6 proxy addresses
also require an allocated unicast range.

| IANA XML snapshot | Updated | SHA-256 |
| --- | --- | --- |
| [IPv4 special-purpose](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xml) | 2025-10-09 | `37f334466c842387a8aee8d1ae7a6d5b2208ef27eb8964072538b73ee2f5b21d` |
| [IPv6 special-purpose](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xml) | 2025-10-09 | `660acf0201b462b8d820605ba1cb20c4ed216acd883ee4a55a17453d73d4c3aa` |
| [IPv6 unicast allocations](https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.xml) | 2025-10-10 | `22f9a545e020ea6b9adea9ea0276f3157e32c838682459a45bfe7760de0aefc3` |

On refresh, split each special-purpose address list into one row per prefix and keep only
`True` as `allow`. Keep `ALLOCATED` as `allow` for the IPv6 allocation rows and `deny` for
every other value in either table. Review the diff and run `make test:unit:gvproxy`.

## Revisions and failure behavior

The [shared revision contract](outbound-contract.md#revisions-and-acknowledgements) owns
the update precondition, complete snapshot, and common acknowledgement format. The
registration revision identifies the proxy version independently of the Box policy revision.
A stale public `If-Match` returns `412` before mutation or Runner dispatch.

Bind acknowledges publication after the host has stopped external UDP relays and settled writes
to the guest-link socket.

```mermaid
sequenceDiagram
    participant Cloud
    participant Runner
    participant Host as Runtime and gvproxy
    Cloud->>Runner: Conditional bind for the assigned epoch
    Runner->>Host: Apply the complete candidate
    Note over Host: Close external UDP endpoints and fence guest-link writes
    Note over Host: Install and persist the new snapshot
    Host-->>Runner: Report installed route and epoch
    Runner-->>Cloud: Return authenticated application evidence
    alt Exact evidence
        Note over Cloud: Confirm the candidate
    else Evidence is missing or mismatched
        Note over Cloud: Preserve pending references and reconcile
    end
```

Confirm a proxy update only with authenticated application evidence matching the Box,
assigned Runner, runtime epoch, policy, and exact registration revision or explicit unbound
state. Exact same-epoch readback of the durable, installed candidate can settle a lost
acknowledgement. An old read or a pending attempt leaves the outcome uncertain.

While an update is uncertain, retain the committed and pending references and return `409`
to conflicting writes. Deleting a referenced registration or retiring a referenced version
returns `409`.

New flows capture the installed route, and established TCP keeps its captured route. Rotation
does not immediately revoke established tunnels.

After reassignment, keep new egress closed until the old runtime epoch is confirmed terminated
and durable state is reconciled. Ordinary Box deletion retains evidence and references while
the old instance or its application state is unresolved. A generic Runner `404` alone does
not establish that the exact epoch terminated.

A policy-only legacy write refuses a bound or unresolved Box before mutation. Legacy
destructive recovery likewise refuses before destruction unless the exact assignment and
epoch are clear of binding and recovery state. Clear unbound Boxes use the existing controls.

The outbound status resource separates desired, committed, pending, and installed identities.
For the current confirmed installation, `proxy.diagnostic.code` can report the last
terminal business TCP proxy failure as `proxy_unreachable`, `proxy_auth_failed`,
`proxy_handshake_failed`, or `proxy_timeout`.

DNS-only failures and locally refused destinations leave the sample intact.
A replacement starts with an empty sample.
If state is changing or the Box row cannot be read without waiting, ordinary status
remains available and omits the diagnostic.

When every placement candidate is known incompatible, a bound create returns HTTP 503
with `code: outbound_create_rejected` and no Box ID. Its `diagnostic.code` is
`runner_proxy_tls_unsupported` if an HTTP V0 candidate exists and
`runner_proxy_unsupported` otherwise. Inconclusive capability checks retain the
generic capacity response.

A stopped bound Box on V2 returns the unsupported diagnostic before writing
start intent. Proxy-triggered auto-resume uses the same guard before writing
the intent. Guest applications receive native network failures.

## Protected Runner bootstrap

On GCP, `mdeploy` delivers `OUTBOUND_PROXY_REGISTRY_KEYS` by reference to a
numeric Secret Manager version. Registry enablement requires that reference and
the old-writer isolation in [the registry contract](#acceptance-and-ownership).

To provision an empty selector, set
`OUTBOUND_PROXY_REGISTRY_FIRST_KEY_ID` to a key from that key ring. Concurrent API
starts given the same first key converge on one selector.

An attempt to select a different first key fails startup and preserves the
current selection. Clear the first-key setting before a later key rotation.

### HTTPS V0 enrollment

An operator enrolls a fresh, non-default mdeploy Runner slot with an admin-registered V0 UUID and HTTPS API URL. Set `STACK_RUNNER_PROTECTED_PROXY_SLOTS` to a JSON object keyed by the slot's resource name, such as `Runner-runner-2`. The registered URL must use the enrolled DNS name and the Runner service port.

Each entry contains `runnerId`, `url`, `caPem`, `caFile`, `certFile`, `keyFile`, `dohUrl`, and `dohAddress`. Provision the certificate, key, and CA files at those absolute host paths. The CA stays scoped to that Runner in Cloud, and both upgrade probes verify the DNS name and CA over loopback HTTPS.

For `Runner-runner-2`, provide the pre-registered slot token through the deployment secret `STACK_RUNNER_PROTECTED_PROXY_TOKEN_RUNNER_RUNNER_2`. Cloud uses the same token saved by the admin registration, and the deployment renders it only for that Runner slot.

`BOXLITE_RUNNER_ENV` cannot override the enrolled identity, TLS, or resolver settings during boot or managed updates.

For example, an enrolled slot can listen at `https://runner-2.example.com:3003/` with a deployment CA and use a pinned DoH endpoint at `1.1.1.1:443`. Ordinary extra slots use automatic V2 registration and loopback HTTP readiness. Cloud checks the enrolled Runner's authenticated bootstrap capability before scoring and truncating candidates for a protected placement.

```mermaid
flowchart LR
    operator[Operator]
    deployment[mdeploy slot enrollment]
    cloud[Cloud Runner adapter]
    subgraph host[Enrolled Runner host]
        readiness[Upgrade readiness probe]
        runner[V0 Runner HTTPS listener]
    end
    operator -->|Register UUID, endpoint and CA| cloud
    operator -->|Provide slot identity, token and TLS files| deployment
    deployment -->|Render service environment| runner
    deployment -->|Render CA and DNS name checks| readiness
    readiness -->|Verified loopback HTTPS| runner
    cloud -->|Enrolled TLS and capability before ranking| runner
```

Cloud prepares the selected Box with ordinary startup skipped and no network interface configured. The enrolled Runner checks TLS, bearer authorization, and the assigned UUID before decoding the host-only request. Runtime stores the attempt and its epoch, then sends the route and effective policy to the shim on a versioned, single-use stdin record.

On Linux, the Runner needs a cgroup v2 that can contain the shim and its namespace descendants. Runtime checks membership before sending credentials and keeps the attempt unresolved until it can establish that the exact child and its process tree have exited. A delayed request for a retired attempt is refused even after the Runner reopens the Box.

Protected bootstrap requires automatic removal to be disabled. Runtime retains protected attempt and retirement records during restart recovery, including when the Box directory is missing.

Runtime gives the private pipe five seconds to transmit the launch record. A timeout or cancellation closes stdin and signals the pending shim to terminate.

The protected receipt requires Guest readiness and exact installed policy, registration, and epoch evidence from gvproxy. Until an authorized bootstrap settles, policy-only changes and legacy recovery cannot replace the protected route. Cloud registry transactions and live rotation use their respective [registry and runtime-update slices](#acceptance-and-ownership).

An authorized recovery launch can supply a gate generation. The bridge closes Guest egress before attaching the NIC and retains the gate across policy replacement. The enrolled Runner can release the gate only with matching boot attempt, epoch, generation, policy revision, and route evidence.

Sealing records a durable release fence, closes ingress, and waits for admitted UDP writes before returning success. Runtime preserves the fence across reopening and retains a confirmed recovery attempt until it proves both sealing and termination. A replacement Runner reaching `STARTED` leaves the previous assignment intact when the previous Runner still holds an outbound proxy reference.

For a running gated epoch, complete route updates reserve the predecessor and candidate under the Runtime Box lock. A successful unbind records a durable marker alongside its new revision. Both policy-only writes remain blocked until Cloud commits the exact unbound state and Runtime confirms release of the marker.

If Runtime cannot persist a live candidate, it can restore the same predecessor route under a fresh revision. Cloud requires matching installed and durable readback, the exact failed attempt and predecessor, and cleared Runtime pending state before adopting that revision. The database transaction keeps the predecessor pin and removes only the abandoned candidate pin.

If Cloud cannot finalize a confirmed update, it reacquires the Box lock and reads primary state. When the exact candidate remains installed and Cloud still owns the original pending attempt, it reserves one restoration to the pinned predecessor. Cloud retains the failed candidate's pin until restoration is confirmed or the epoch is sealed and terminated.

Cloud reserves a named binding with the Box before first boot. The Runner first prepares the Box without a Guest network, and Cloud verifies the assigned Runner and pinned registration again before supplying the route. A lost boot reply leaves the pin in place until exact readback or retirement settles it.

Cloud admits up to sixteen Boxes per reconciliation tick. Pending settlements and registry rollouts each get up to eight slots when both have due work. Either can use unused slots from the other.

An eligible unbound Box uses the same managed bridge with an explicit unbound route. For a running Box on an older bridge, stop it and request a start before binding. Once it has started, send a complete outbound replacement naming the registration.

The rollout worker scans due work every 30 seconds. A tick claims up to 16 Boxes, checks up to 16 registry markers, and backs off unreachable Boxes by desired version. Registry PATCH returns the new registry revision while the committed and installed Box versions may still reflect the prior route.

For stop, deletion, or reassignment, Cloud saves the authenticated sealed snapshot before acting on termination. The Runner deletes only the exact retired attempt and keeps a receipt in SQLite so a lost removal reply can be retried. Recovery starts a fresh epoch with the pinned version and opens egress only after Cloud confirms the fresh gate and the prior epoch's termination.

Read `GET /boxes/{box_id}/network/outbound/status` for the desired, committed, pending, and installed proxy identities. An unknown readback leaves the installed identity empty, and the policy fields retain Cloud's last committed view. With the Rust REST SDK, use `create_with_outbound_proxy` or `update_outbound_proxy` for a name or explicit unbind.

```mermaid
sequenceDiagram
    participant Cloud
    participant Runner as Enrolled Runner
    participant Runtime
    participant Shim as Shim and gvproxy
    Cloud->>Runner: Prepare Box with startup and network disabled
    Cloud->>Runner: Send exact attempt over enrolled HTTPS
    Runner->>Runtime: Admit attempt under Box lock
    Runtime->>Runtime: Store attempt and epoch
    opt Preparation succeeds
        Runtime->>Runtime: Record potential child before spawn
        Runtime->>Shim: Spawn and verify child identity and containment
        Runtime->>Shim: Write launch record with a five-second deadline
        alt Write completes within the deadline
            Runtime->>Shim: Close stdin for the shim to decode the record
        else Pipe times out or caller cancels
            Runtime->>Shim: Close stdin and signal the child to terminate
            Runtime->>Runtime: Retain attempt until termination is proved
        end
    end
    alt Guest ready and installed route matches
        Shim-->>Runtime: Confirm policy, registration and epoch
        Runtime-->>Runner: Exact confirmed receipt
        Runner-->>Cloud: Authenticated confirmed receipt
    else Uncertain or failed launch
        Cloud->>Runner: Request exact attempt retirement
        Runner->>Runtime: Serialize retirement with startup
        alt No child was created or exact termination is proved
            Runtime-->>Runner: Persist and return retired receipt
            Runner-->>Cloud: Authenticated retired receipt
        else Child termination is unconfirmed
            Runtime-->>Runner: Leave attempt unresolved
        end
    end
```

```mermaid
sequenceDiagram
    participant Cloud
    participant Old as Previous enrolled Runner
    participant New as Assigned enrolled Runner
    participant Bridge as New Runtime and gvproxy
    Cloud->>Old: Seal exact old epoch and drain admitted writes
    Old-->>Cloud: Return sealed durable and pending evidence
    Cloud->>Cloud: Persist evidence and keep previous ownership
    Cloud->>Old: Terminate exact old attempt
    alt Exact termination confirmed
        Old-->>Cloud: Return terminal receipt
        Cloud->>Cloud: Resolve references and retire previous assignment
        Cloud->>New: Start with pinned route and fresh gate generation
        New->>Bridge: Close egress before connecting Guest network
        New-->>Cloud: Attest fresh epoch and installed route
        Cloud->>Cloud: Confirm fresh epoch and pinned route
        Cloud->>New: Release exact attested gate
        New->>Bridge: Open egress under confirmed policy
    else Termination still uncertain
        Cloud->>Cloud: Retain old evidence and withhold new gate release
    end
```

The Registry integration pins the exact registration revision to the Box, assigned Runner, and attempt before dispatch. The pending reference can omit the epoch until Runtime allocates it. An exact successful receipt promotes the reference and records that epoch atomically.

Once known, the epoch also has to match readback or retirement evidence. An exact retirement receipt can omit the epoch when Runtime retired the attempt before allocation. Any uncertain result keeps the pending reference in place.

On a disposable Linux KVM host, add loopback aliases `11.23.0.1` through `11.23.0.5` as `/32` addresses. Set `BOXLITE_TEST_PROTECTED_BOOT_TLS` to the directory containing `host.pem` and `host.key`. Trust the certificate issuer on the host and include `resolver.test` and `protected.test` in the certificate.

Run `make test:integration:runner FILTER=TestIntegrationProtectedBootTCPPaths`. Its recovery subtest restarts a Box with a closed gate. It checks Guest TCP, UDP, and DNS before and after an authenticated HTTPS release.

The proxy test runs `curl --noproxy '*'` in the Guest and checks CONNECT and application requests received by the fixtures.

### V2 capability listener

For an existing GCP V2 slot, include `apiVersion: 2`, a private HTTPS `url` on port
`3004`, `clientCaFile`, and `clientDnsName` in its enrollment. Use `Runner` as
the key for the default slot.

Keep the slot's existing UUID under `runnerId`.
GCP convergence applies the matching settings and preserves the slot token.
Removing enrollment clears the private listener settings from that slot.

The HTTPS probe returns the serving process UUID and binary identity. An
empty operations list means the process offers the capability probe only.
Ordinary V2 health and the job poller use the existing service configuration.

## Acceptance and ownership

[Fixture scenarios](../../../tests/fixtures/outbound/proxy-contract-v1.json) record proposed
inputs and expected evidence. They cover stale `If-Match` and zero business DNS fallback during
outages. They also require retaining references when old termination or durable evidence is
missing.

| Slice | Production acceptance it owns |
| --- | --- |
| 01 Contract | Public fields, support matrix, visible errors, and fixture scenarios. |
| 02 Connector | Controlled tunneling, authentication, address checks, timeouts, cancellation, socket cleanup, and zero direct fallback. |
| 03 DNS and UDP | Both gateway listeners, host business resolution, bootstrap exceptions, and UDP cutover during bind and unbind. |
| 04 Runtime and Runner | Host-only credential authorization and delivery, enrolled Runner identity, and a common route for ordinary, inspected, and MITM TCP. |
| 05 Registry | Organization authorization, authenticated encryption and key retention, redaction, and reference protection in deletion races. |
| 06 Runtime update | Complete snapshots and route evidence, stale writes, rotation, loss of acknowledgement, exact-epoch recovery, and deletion or legacy control safety. |
| 07 SDK and CLI | OpenAPI parity, actual requests, and write-only credential handling. |
| 08 Cloud acceptance | Controlled proxy and target, observed traffic and failures, DNS latency, and combinations with BUI-209 in the joint acceptance. |

The [PR01 design](https://github.com/boxlite-ai/boxlite/issues/2861) describes these boundaries.
The [overall design](https://github.com/boxlite-ai/boxlite/issues/2734) tracks dependencies and
the [detailed proposal](https://github.com/boxlite-ai/boxlite/issues/2832) records the planned
recovery and credential mechanisms.
