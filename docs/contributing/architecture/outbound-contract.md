# Outbound connection and replacement contract

This is the shared implementation contract for destination policy, upstream transport, and complete outbound replacement.
It does not advertise proxy, deny-rule, IPv6, or revision support before the corresponding backend implements and reports that capability.
The [design](../investigations/2026-11-16-egress-foundation.md) records the rationale; [shared examples](../../../tests/fixtures/outbound/contract-v1.json) supply inputs for each implementation layer.

## Connection ownership

Capture one immutable policy and route snapshot when a new guest flow enters the forwarding boundary, before resolution or dialing.
All setup attempts and upstream sockets belonging to that flow use the captured snapshot.
Publishing a replacement changes later flows; it does not switch an established flow to another policy or transport.

Disabling outbound networking continues to suspend the guest NIC rather than promising to terminate every established connection.

```mermaid
flowchart LR
    A[Guest flow] --> B[Capture snapshot]
    B --> C[Identify and check destination]
    C --> D[Controlled resolution if needed]
    D --> E[Check each candidate]
    E --> F[Selected transport]
```

Policy decides whether the real destination is permitted; transport decides how an approved destination is reached.
The proxy endpoint is not the business destination and cannot substitute for it in policy checks.

| Connection value | Meaning and owner |
| --- | --- |
| Original hostname | Canonical observed or authorized name, when available; retained for SNI, HTTP Host, and certificate verification. |
| Policy address | Guest destination before NAT; address rules must see this value. |
| Approved candidate | Literal IP that passed candidate checks; a connector must not resolve the business hostname again. |
| Connection address | Literal socket destination after the applicable NAT mapping; distinct from the policy address. |
| Port and protocol | Actual business destination port and transport protocol, independent of an upstream proxy's listening port. |
| Policy revision | Identity of the captured complete policy, when the revision protocol is supported. |
| Registration revision | Separate identity of the selected proxy registration, when proxy routing is supported; never a credential. |

Ordinary TCP, hostname-inspected TCP, and secrets MITM must use the same selected transport after their applicable checks.
Reuse the existing `resolveFunc`, `dialFunc`, `upstreamDial`, and `egressDialer` seams.
Retries check candidates individually and share one bounded setup deadline; cancellation releases unfinished setup resources.

Transport failure does not select a different route implicitly.

The local host alias keeps its existing direct NAT behavior.
A future remote transport must reject that alias unless it defines an explicit safe mapping; translated loopback is not the proxy server's equivalent destination.

### TCP transport implementation

The bridge's `egressTarget` carries the observed hostname, pre-NAT policy IP, approved connection IP, actual port, and protocol.
Ordinary TCP binds `egressDialer.byAddress`; inspected traffic binds either `byAddress` or `byName`, and MITM retains that bound dialer for its upstream connections.
The selected `connectFunc` receives this target after the applicable checks.
Its error is returned without selecting the direct socket dialer; an unset connector selects the existing direct transport.
Configure resolver and transport seams before installing the forwarder.

Initial unrestricted TCP also installs this boundary; unrestricted UDP delegates to the upstream forwarder.
Address setup and controlled hostname resolution each use a bounded setup context, including candidate retries and MITM redials.
The connector carries the captured policy revision; revisioned publication uses the control resources below.

The guest-stack transport tests consume the shared NAT and hostname examples, relay HTTP/TLS bytes to test-owned listeners, and verify refused targets never enter the connector.
The MITM test uses an isolated test CA in a subprocess so production certificate verification remains active; a wrong upstream certificate must receive no HTTP request.
For HTTP/2 fixture concurrency, `http2.Transport` owns connection pooling and stream sharing; each pool dial owns a fresh guest/proxy TLS pipe.

## Configuration boundary

The current policy shape is `{ "mode": "enabled" | "disabled", "allow_net": [...] }`.
An omitted `allow_net` has the existing empty-list meaning; disabled mode rejects a nonempty allowlist.
This foundation preserves the current rule grammar and does not increase rule limits or enable IPv6 forwarding.

Configuration contains user policy only.
Revisions, application status, platform constraints, and proxy authentication material belong outside the public policy object.
The future public proxy reference belongs at `network.outbound.proxy`; a Box selects at most one registration.
Proxy credentials use a separate host-only channel and do not enter Guest configuration, ordinary Box options, or exports.

| Replacement input | Required behavior |
| --- | --- |
| Current mode/allowlist request without a precondition | Preserve its unconditional public operation; serialize the internal replacement under the existing lock. |
| Versioned request | Require backend revision support and an internal expected revision; reject unsupported peers before claiming success. |
| Unsupported deny, proxy, or IPv6 input | Reject before application; parsing or retaining a field is not capability delivery. |
| Omitted future protection while it is active | Reject the incomplete replacement rather than clearing the protection. |
| Explicit empty deny list | Clears user denies once that feature is supported; does not clear platform constraints. |
| Explicit null proxy | Clears the user binding once supported; does not bypass destination policy. |

Future disabled configurations may retain supported deny or proxy settings, but those settings cannot enable traffic.
Their omission and clearing rules remain effective while the NIC is disabled.

## Extended destination rules

The extended rule policy defines `allow_net` and `deny_net` for backends that support them.
Each list accepts up to 64 entries, counted before normalization or deduplication.
Reject the entire policy if any entry is invalid.

Create and replace use the same rule grammar.
The shared fixtures specify parser, matcher, and request outcomes.
[Extended rule fixtures](../../../tests/fixtures/outbound/policy-rules-v1.json) · [Design and rationale](https://github.com/boxlite-ai/boxlite/issues/2831)

### Rule syntax

| Destination | Any port | One port |
| --- | --- | --- |
| Hostname or wildcard | `api.example.com`, `*.example.com` | `api.example.com:443`, `*.example.com:443` |
| IPv4 address or prefix | `192.0.2.8`, `192.0.2.0/24` | `192.0.2.8:443`, `192.0.2.0/24:443` |
| IPv6 address or prefix | `2001:db8::8`, `2001:db8::/32` | `[2001:db8::8]:443`, `[2001:db8::/32]:443` |

- Trim surrounding whitespace. Reject blank entries, internal whitespace, commas, inline `!` markers, and URLs.
- Hostname labels use 1–63 ASCII letters, digits, or hyphens with alphanumeric endpoints. A hostname is at most 253 bytes, excluding a leading `*.`.
- Rule hostnames omit the root dot. Lowercase both names before comparing and strip one root dot from the observed name. A wildcard matches one or more subdomain labels, excluding its apex.
- Parse addresses and prefix lengths strictly. Reject malformed dotted IPv4, IPv6 zones, and invalid prefix lengths. Mask CIDRs to their network.
- Split the port before classifying four nonempty decimal labels as IPv4. Reject an overlong or out-of-range octet, a leading zero, or a wildcard on that numeric suffix.
- Parse a bare IPv6 address or prefix in full. An IPv6 rule with an explicit port requires brackets. Each explicit port consists of decimal digits in the range 1–65535.
- Convert mapped IPv6 addresses and mapped prefixes of length 96–128 to IPv4 before matching. Reject shorter prefixes written with mapped literals. Native IPv6 prefixes match native IPv6 addresses.

Reject `192.0.2.999:443`, `192.0.02.8`, `192.0.2.1024`, and `*.192.0.2.8`.
`192.0.2.8:443` is an IPv4 rule and `192.api.example:443` is a hostname rule.

### Decision order

Evaluate external destinations against one captured snapshot.

| First applicable condition | Outcome |
| --- | --- |
| Outbound mode is disabled | Deny. |
| Trusted platform policy denies the destination | Deny. |
| A user deny rule matches | Deny. |
| A hostname deny applies to this port and the name is unavailable | Deny. |
| A user allow rule matches, or the existing HTTPS secrets permission applies | Allow subject to applicable candidate checks. |
| The allow list is empty | Allow subject to applicable candidate checks. |
| No rule grants permission | Deny. |

Use the actual transport destination port even when the HTTP Host header includes a port.

Address rules use the pre-NAT policy address for guest-addressed flows.
Check each candidate for platform and user address denies using its own address and the actual destination port.
A candidate matching user deny never reaches the connector, even when the guest address and observed name both match allow.

Skip denied DNS candidates. Try approved candidates in resolver order within the shared deadline.
If every candidate is denied, fail with zero connector calls.

With `192.0.2.0/24:443` denied, answers `192.0.2.8` and `203.0.113.8` call the connector only for `203.0.113.8:443`.
Answers `192.0.2.8` and `192.0.2.9` call it zero times.

After deny checks, route secrets by checked name first, then IP allow by address, then hostname allow by checked name, then empty allow by address.
For example, an allow for `api.example.com:443` can authorize the name while a deny for `192.0.2.0/24` filters a candidate at `192.0.2.8`.

When a hostname rule affects the decision, identify TLS ClientHello SNI or the first plaintext HTTP Host on any TCP port.
Bound inspection to 16 KiB and the 30-second setup budget, with at most ten simultaneous inspections per Box.

Close excess flows before dialing. Release the slot on completion or failure.
An invalid, conflicting, or hidden name, or expiration of the inspection budget, makes the name unavailable.

```mermaid
sequenceDiagram
    participant A as TCP flow requiring a name
    participant S as Per-Box inspection slots
    participant B as Competing TCP arrival
    A->>S: Acquire the tenth slot before inspection
    B->>S: Attempt acquisition
    S-->>B: All slots occupied
    Note over B: Close before dialing
    alt Observation completes
        A->>S: Release slot
    else Inspection fails or reaches a limit
        A->>S: Release slot
    end
    Note over S: Next eligible arrival can acquire the released slot
```

Name policy covers connection establishment using the first verified TLS SNI or plaintext HTTP Host and its required address association.
Filtering per request, URL path, later Host, or encrypted identity falls outside this boundary.

UDP and QUIC have no supported name observation.

| Address allow matches and name is unavailable | TCP | UDP and QUIC |
| --- | --- | --- |
| Additional hostname allow | Allow by address | Allow by address |
| Hostname deny covers the actual port | Deny | Deny |
| Hostname deny covers a different port | Allow by address | Allow by address |

The table assumes that mode, platform, and address deny checks passed. A hostname rule with no port covers all ports.

An applicable hostname deny requires a usable name even when the flow is otherwise allowed by its address or an empty allow list.
For a guest-addressed flow, controlled resolution must include the external business IP that the connector will dial.
An observed name without that association cannot rule out a hostname deny.

In the extended policy, direct and resolved targets both run mandatory address checks after unmapping IPv4-mapped IPv6.
Link-local, unspecified, IPv4 0/8, multicast, IPv4 limited broadcast, and trusted platform-denied addresses are refused.
Name-resolved candidates also exclude the Box subnet.

Cloud defaults block loopback, private, CGNAT, and IPv6 ULA regardless of Box allows.
Local direct access to those ranges follows user rules.
For a local resolved candidate in those ranges, a nonempty allow list must include an IP rule matching the candidate address and port.

User address rules evaluate the pre-NAT target.
Platform policy also checks the translated dial destination, so Cloud refuses translated loopback even when the pre-NAT address passes.
The local alias can map to host loopback when the pre-NAT policy permits it.

PR04 owns the UDP post-NAT platform check.
The current wrapper checks the guest address, then the pinned forwarder resolves NAT and owns endpoint creation and socket dialing.
[Pinned UDP forwarder](https://github.com/containers/gvisor-tap-vsock/blob/v0.8.7/pkg/services/forwarder/udp.go#L15-L41)

The UDP forwarder captures the translated address and port once and checks them against the flow's pinned policy.
It hands that exact destination to the socket.
A rejected translation reaches neither endpoint creation nor the external dial hook.

While egress stays enabled, an established UDP endpoint keeps its admitting snapshot until it closes or expires.
A new endpoint takes the latest snapshot, including reuse of a tuple after the old endpoint closes.

To verify a new deny, send over an established endpoint, then create a fresh one and observe zero dial attempts and no delivery.
The global disabled gate blocks forwarding for both.

```mermaid
sequenceDiagram
    participant C as Policy coordinator
    participant G as UDP handler
    participant E as Established endpoint
    G->>E: Admit flow under the current allow snapshot
    C->>G: Publish a replacement containing deny
    Note over C,G: Egress remains enabled
    E->>E: Relay with the captured allow snapshot
    Note over G: New flow is denied before endpoint creation
    E-->>G: Endpoint closes or expires
    Note over G: Reopened tuple also uses the deny snapshot
```

Platform rollout validates deployment address sets and trusted exceptions.

Enabled mode exempts DNS on the registered gateway TCP/UDP 53 endpoints, DHCP on the registered UDP 67 endpoint, and required ARP/NDP link control.
Other traffic to the gateway or guest IP and forwarded host aliases follows the normal policy.
Disabled mode continues to block forwarding and registered DNS/DHCP delivery.

### Creation and replacement

| Input | Required behavior |
| --- | --- |
| Image create omits `deny_net` | Start with an empty deny list. |
| Create with `checkpoint_id` | Inherit its complete saved policy. Keep existing restrictions on request overrides and reject a selected backend that cannot enforce the inherited policy. |
| Complete replacement omits `deny_net` | Reject if an effective or possibly active snapshot contains denies, including while disabled. Otherwise use an empty list. |
| Complete replacement supplies `deny_net: []` | Clear user denies. Platform constraints still apply. |
| `deny_net: null` | Reject invalid input. |
| Disabled mode supplies supported denies | Store the supplied denies and keep the NIC disabled. A nonempty allow list is invalid. |
| A valid request requires unsupported enforcement | Return unsupported. An explicitly supplied deny list requires support even when empty. |
| A supported replacement fails its revision precondition | Return 412 before applying the candidate. |

Under update ownership, a confirmed pending candidate becomes the effective policy before checking omission.
For unresolved attempts, check both committed and pending snapshots before normalizing the request.
An explicit replacement uses the existing revision and acknowledgement protocol to fence an older attempt.

Check backend support before reserving pending intent. Recheck support where the dedicated operation applies the snapshot.

Revision support identifies the replacement protocol. Require deny, port, and IPv6 policy enforcement separately when the policy uses them.

| A revision-capable peer lacks | Create | Complete replacement | Restart |
| --- | --- | --- | --- |
| Deny enforcement | Explicit member is unsupported before attach | Explicit member is unsupported before application | Nonempty effective deny is unsupported before attach |
| Destination-port enforcement | Unsupported before attach | Unsupported before application | Unsupported before attach |
| IPv6 policy enforcement | Unsupported before attach | Unsupported before application | Unsupported before attach |

Create and PUT require deny support whenever the request explicitly supplies the member, including `[]`.
Restart checks the reconciled, durably confirmed effective policy.

A peer without deny support can restart a Box with a confirmed empty deny list when it supports every other active rule.
This covers older records that omit deny and policies cleared by a confirmed operation.
Persist no historical presence marker.

Nonempty deny blocks unsupported attachment.
Unresolved active state cannot be treated as confirmed empty.
A refusal leaves committed policy intact.

A definitive refusal before application permits retiring that reservation under its ownership check.
A complete replacement can supersede an older attempt, but reservation alone does not fence it.

Omission checks see the older candidate's possible active denies until confirmation or an applied CAS fences it.
If the new candidate explicitly clears deny and the backend refuses it, retire only that reservation.
The older unresolved evidence remains durable across coordinator restart.

The guard also covers a backend-confirmed candidate whose durable commit failed.
Keep that candidate's denies visible during unresolved restoration, even if the restoration candidate contains no denies.
Matching the previously durable revision alone is insufficient.

Clear that evidence after confirmed restoration or durable reconciliation of the effective policy.
If reconciliation commits the deny, the committed list still blocks omission.

```mermaid
sequenceDiagram
    participant C as API coordinator
    participant S as Durable policy store
    participant B as Outbound backend
    alt Older deny apply is ambiguous
        C->>S: Reserve an explicit clear and retain evidence of the older deny
        C->>B: Try CAS for the complete clear
        alt Backend refuses before apply
            B-->>C: Definitive refusal
            C->>S: Retire the clear reservation and keep the older deny
        else CAS fences the older apply and completes
            B-->>C: Confirm the complete clear
            C->>S: Commit the clear and retire the fenced deny
        end
    else Deny applies but durable commit fails
        B-->>C: Confirm apply of the deny
        C->>S: Reserve restoration and retain the applied deny
        C->>B: Try restoring the previous policy
        alt Restoration remains unresolved
            C->>S: Keep the possibly active deny durable
        else Restoration completes
            B-->>C: Confirm restoration
            C->>S: Reconcile effective policy and retire the extra deny evidence
        end
    end
    C->>S: Reload committed policy and unresolved evidence after restart
    Note over C,S: Reject omission if any confirmed or possibly active deny remains
```

Ambiguous delivery retains pending evidence. Committed policy advances only after confirmed application of the complete candidate.

At create or restart, attach the guest NIC after the launched backend confirms full policy application. A refusal or uncertain startup leaves the guest unattached and preserves stored policy.

After rollout, nested create and outbound PUT accept up to 64 rules per list, including allow-only policies with 11 or 64 rules.
Deprecated flat create retains its 10-rule cap and grammar. An older receiver must decline an extended request before apply, including an allow-only policy above 10.

Nested create and PUT to an extended peer use the expanded grammar.
An old-peer PUT also requires the legacy peer grammar before dispatch.
It rejects malformed four-label numeric literals, including overlong octets, and numeric wildcard suffixes.

The deprecated flat-create API rejects `192.0.2.999`.
It can pass `192.0.2.1024` to the legacy bridge, which rejects the launch.
The mixed-label hostname `192.api.example` is valid on all paths without a port.

Public outbound PUT rejects blank allow entries with both capable and older peers. Legacy internal entry points retain their existing blank normalization.

Previously persisted legacy policies load with their effective allow lists and an empty deny list.
Every replacement obeys the omission check.

PR02 tests native IPv6 rule parsing and matching in Go.
Until dual-stack enforcement is available, hostname dials exclude native IPv6 candidates and make zero connector calls for a native-IPv6-only response.

Mapped addresses keep their IPv4 normalization. [Current IPv4 hostname dial](https://github.com/boxlite-ai/boxlite/blob/51b5cf5/src/deps/libgvproxy-sys/gvproxy-bridge/egress_dialer.go#L129-L166)

PR10 validates the virtual link, NDP, and routing.
PR11 validates native Guest forwarding and hostname dials against permitted and denied IPv6 targets.

Advertise each capability after its own acceptance. [Full dual-stack plan](https://github.com/boxlite-ai/boxlite/issues/2733)

### Go rule matching

`compileExtendedOutboundPolicy` validates both lists before returning an immutable policy.
The evaluator takes a pre-NAT target and platform facts for the same normalized address.
It returns a decision and selects a route after applying deny precedence.

An address allow can resolve a pending flow immediately when only a hostname allow could also match.
A possible secrets grant or a hostname deny for the actual port instead requests inspection.
The caller evaluates the completed observation against the same policy.

```mermaid
flowchart LR
    T[Typed target and address facts] --> E[Evaluate captured policy]
    E -->|Inspection pending| I[Caller inspects TCP]
    I --> E
    E -->|Address association required| A[Caller verifies name and socket address]
    A -->|Verified| E
    A -->|Unavailable or mismatched| X[Refuse]
    E -->|Name or secrets route| C[Check normalized DNS candidate]
    E -->|Deny or allow miss| X
```

For example, a matching address allow and an applicable hostname deny require the observed name to resolve to the actual socket address.
An association for a different address leaves the decision denied.

`checkCandidate` evaluates one normalized DNS candidate and its classification.
For a restricted local candidate and nonempty allow list, the candidate needs an IP rule covering its actual port.
The caller selects the connector and enforces transport eligibility.

The shared rule fixtures exercise the compiler and matcher. Trusted extended TCP snapshots use both functions at guest connection setup.
[Design and handoff](https://github.com/boxlite-ai/boxlite/issues/2874)

### Extended TCP enforcement

The bridge's trusted Go controller compiles extended TCP rules into a snapshot alongside the legacy UDP filter.
Current wire inputs still select the legacy transport policy. The bridge advertises the complete extended capability after its owning integration slices.

At flow entry, capture the snapshot and the pre-NAT and translated addresses. For example, an IP allow for `192.0.2.254:8080` can admit a local alias to loopback, subject to the platform check on `127.0.0.1:8080`. A Cloud snapshot refuses that translated socket.

The extended forwarder classifies TLS ClientHello or a complete HTTP/1.x header on any TCP port. It preserves all bytes for relay and releases the inspection slot before resolving or dialing. ECH, incomplete headers, and conflicting authorities leave the name unavailable.

The initial 30-second deadline covers observation, required DNS association, candidate dialing, and the first verified MITM upstream TLS connection. The guest TCP handshake uses gVisor's own timer; a late endpoint closes before inspection or dialing. An MITM guest with no first request also closes at the deadline.

```mermaid
sequenceDiagram
    participant G as Guest
    participant F as TCP forwarder
    participant U as Selected upstream
    G->>F: New flow starts 30-second setup budget
    G->>F: Complete gVisor TCP handshake
    alt Setup budget expired
        F-->>G: Close before inspection or dial
    else Budget remaining
        F->>F: Inspect if needed and check destination
        opt Secrets MITM
            G->>F: Send first request within setup budget
        end
        F->>U: Dial approved literal within remaining budget
        opt Secrets MITM
            F->>U: Verify first upstream TLS by the same deadline
        end
        F-->>G: Relay without the setup deadline
        Note over F,U: A later MITM socket has its own budget
    end
```

Plaintext Host can match user rules. Only TLS SNI on actual port 443 can grant secrets MITM. Subsequent MITM sockets re-resolve and check candidates with the captured policy and a fresh setup deadline.

An HTTP/1.1 upgrade keeps its tunnel open for bidirectional traffic. Closing the guest connection releases the per-flow MITM listener, including after an upgrade.

An extended DNS route screens raw answers with the TCP policy, independent of the legacy UDP allow list. Only approved IPv4 literals reach the chosen connector. An address route keeps its translated socket and requires a matching controlled DNS answer when the matcher requests name association.

Trusted replacement keeps the legacy UDP filter and publishes through the existing NIC transition. Both wire PUT resources return 409 for a valid incomplete write when a trusted TCP snapshot is configured, including while disabled. While disabled, both reads project an empty legacy allow list; re-enable restores the preserved UDP filter and allow list.

| Requested transition | Before NIC call | On success | On NIC failure |
| --- | --- | --- | --- |
| Disable | Publish candidate with disabled gate and pending status | Confirm disabled candidate | Keep disabled gate and report uncertain status |
| Re-enable | Keep previous disabled gate and publish pending status | Publish and confirm enabled candidate | Keep previous disabled gate and report uncertain status |

Policy GET returns 503 while either operation is pending or uncertain. The status resource reports the snapshot and its application state.

[TCP design and acceptance](https://github.com/boxlite-ai/boxlite/issues/2880)

## Revisions and acknowledgements

A revision is an opaque, Box-scoped token; clients compare for equality rather than ordering tokens or interpreting timestamps.
Existing records receive a documented initial token when revision support is introduced.
Each successful change receives a fresh token, including restoration after a failed persistence attempt.

One trusted coordinator creates the candidate token once and propagates it unchanged through API, Runner, Runtime, and gvproxy.
The complete snapshot includes normalized policy and the selected route identity, including a registration revision when applicable.
Internal metadata does not become an extra field accepted by strict policy decoders.

| Boundary | Contract |
| --- | --- |
| Public policy read | Return the existing policy shape and a strong ETag identifying its persisted revision. |
| Conditional public replacement | Evaluate `If-Match` under the update lock; a false precondition returns 412 before applying the candidate. |
| Internal replacement | Compare the expected current revision under the existing ownership lock, then apply the complete candidate snapshot. |
| Applied acknowledgement | Identify the exact installed candidate; missing, malformed, stale, or mismatched identity is not success. |
| Live status | Distinguish persisted revision, observed applied revision when available, and an explicit application state. |
| Old backend | Reject version-aware operations explicitly rather than silently discarding metadata or using unchecked replacement. |

Expose application metadata through a separate outbound status resource.
A stored policy or a successful HTTP status alone does not prove that the matching snapshot is live.
Confirmed application describes the control-plane snapshot; it is not an Internet-connectivity probe.

Example: connection A captures `rev-a`, which permits `api.example.com` through direct transport.
A conditional replacement installs `rev-b`, which permits only `updates.example.com`.
Later `api.example.com` connections are rejected before dialing, while A retains its original snapshot.

An update carrying stale `If-Match: "rev-a"` receives 412 without application.

## Application and recovery

Reuse the current Box update lock, Runtime persistence operation, and Cloud row-lock transaction.
All complete replacements, including future proxy rotation, share this ownership boundary.
Validate and compile the entire candidate before publishing it for new flows.

### Bridge snapshot publication

The bridge installs its TCP and UDP handlers once, before attaching the guest.
An atomic pointer publishes the complete immutable policy, filter, dialer, and application state; a TCP flow keeps the snapshot captured at entry, including while resolution is paused.
The gVisor IPv4 input/forward gate reads the same snapshot before registered endpoint delivery.
Enabled traffic continues through the existing filter-table chains, including the embedded DNS service.

Disabling publishes a rejecting snapshot before NIC suspension; enabling retains that gate until the NIC has enabled successfully.
NIC errors retain the disabled gate and mark application uncertain.
Policy GET returns 503 while application is pending or uncertain, and successful GET/PUT retain the existing policy JSON shape.
The separate status resource reports the observed snapshot identity and application state without changing the policy body.

The registered-DNS regression fixture binds native gVisor UDP/TCP endpoints on port 5353 and forwards received DNS messages to a test-owned host listener.
It exercises endpoint demultiplexing without replacing the global mode gate, and includes a new query on an established TCP DNS connection.
Controlled NIC pauses separately verify the interval before suspension and the interval after enabling but before policy publication.

### Bridge revision protocol

| Control resource | Contract |
| --- | --- |
| `GET /network/outbound` | Existing policy JSON plus a strong ETag; 503 while application is pending or uncertain. |
| `PUT /network/outbound` | Existing complete policy replacement, optional HTTP `If-Match`; the bridge chooses a fresh revision. |
| `PUT /network/outbound/snapshot` | Version-required internal replacement; one strong expected revision in `If-Match` and a fresh candidate in `X-Boxlite-Outbound-Revision`. |
| `GET /network/outbound/status` | Policy, observed `revision`, `application_state`, and capabilities including `revision-v1`; no persistence or Internet-connectivity claim. |

Version-aware clients use the dedicated snapshot resource and never fall back to legacy PUT.
An old handler may ignore extra headers on its existing resource; a new resource makes unsupported peers reject the operation before application, including after a capability-probe/backend-restart race.
Coordinator headers on the legacy resource are rejected rather than silently ignored.

For a snapshot initialized as `initial`, this request returns policy JSON with `ETag: "rev-b"` only after NIC suspension succeeds:

```http
PUT /network/outbound/snapshot
If-Match: "initial"
X-Boxlite-Outbound-Revision: rev-b
Content-Type: application/json

{"mode":"disabled"}
```

A stale expected revision returns 412 without application.
Candidate metadata requires a single strong expected token; missing, empty, ambiguous, oversized, reserved, or current candidate identities are rejected.
Trusted coordinators allocate fresh candidate IDs once and propagate them unchanged; the bridge does not keep a historical ID registry.
Legacy conditional requests use HTTP strong comparison, including tag lists and wildcard matching.

Startup wire metadata may supply `outbound_revision` to restore an existing identity.
Without a seed, the bridge generates a fresh 128-bit token for that startup, avoiding an initial-token reset across unseeded restarts.
Internal identities use 1–128 ASCII letters, digits, hyphens, or underscores; clients treat them as opaque values.
The public Rust `GvproxyConfig` shape remains unchanged; restoring Runtime-owned revisions belongs to its private bootstrap metadata path.

A matching status revision is not an acknowledgement while `application_state` is `pending` or `uncertain`.
This capability describes the gvproxy control boundary; Runtime persistence and Cloud/Runner propagation require their own completed implementation and verification.

### Runtime control client

`NetworkBackend::outbound_snapshot` reads the backend's policy identity and installation phase.
It requires the `revision-v1` capability and rejects invalid tokens, policies, or phases.
An observed `pending` or `uncertain` phase remains visible to the caller; an identity match alone does not establish completion.

`replace_outbound_snapshot` sends an `OutboundReplacement` to the dedicated snapshot resource.
The validated operation keeps expected and candidate revisions separate from user policy JSON.
It returns `Applied` only for HTTP 200 with exactly one matching strong ETag and the complete matching policy response.
Missing, weak, duplicate, or different acknowledgements produce an error with an uncertain application outcome.
HTTP 412 returns `PreconditionFailed`, a must-use outcome that does not represent successful application.
Unsupported backends return an explicit error; the versioned operation never falls back to the existing unconditional setter.

The existing setters and public configuration structs retain their signatures and wire shapes.
Backends inherit unsupported defaults for the added methods, so an existing custom implementation still compiles.
These methods verify the Runtime-to-gvproxy control boundary, independently of durable recovery or Cloud/Runner propagation.

### Runtime pending attempts and persistence

Runtime replacement uses the existing Box operation lock, including its disk refresh and VM-handle identity checks.
Control metadata lives under `outbound_control` in the stored state JSON; public `BoxState` and user policy structs keep their existing fields.
Records without control metadata use the initial token `initial`.
Lifecycle state writes preserve both the latest policy and its control metadata, including when a handle holds an older state copy.

Before contacting the backend, Runtime durably records the expected live revision and the complete candidate.
Only a matching ACK or a matching `confirmed` readback permits policy and revision to be committed together.
For example, after an ambiguous attempt from `rev-a` to `rev-b`, observing `rev-a` does not clear the pending attempt.
Observing `rev-b` while pending does not confirm completion either.
A later mutating operation may finish persistence once `rev-b` and its policy are confirmed; a persisted-policy read performs no such reconciliation.

If confirmed application succeeds but persistence fails, restoration compares against the applied candidate and uses a fresh identity.
Restoring the old policy as `rev-c` never makes a stale `If-Match: "rev-a"` valid again.
A rejected restoration or failed restoration persistence leaves explicit uncertainty and the durable pending evidence.
An ambiguous timeout never causes an unchecked replay or compensation.
A newly requested unconditional complete replacement may use the observed revision for a fresh CAS, fencing a queued older request once acknowledged.

`NetworkHandle::outbound_snapshot` reads persisted policy and identity without claiming live confirmation.
`replace_outbound_snapshot` applies a trusted coordinator's validated candidate and returns the explicit precondition outcome.
The existing unconditional setter retains its old-backend path only while no versioned control metadata exists.
A versioned call, or a Box already using versioned state, cannot silently fall back to that path.

### Revision-aware REST transport

The Rust REST backend carries `outbound_snapshot`, `outbound_status`, and conditional replacement through the same typed NetworkHandle API.
The policy GET decodes user policy and one strong ETag; the separate status GET retains durable/live comparison and pending evidence.
A response claiming confirmation must contain matching durable and completed live snapshots with no pending attempt.

Internal replacement uses `PUT /boxes/{id}/network/outbound/snapshot`, one expected token in `If-Match`, and the candidate in `X-Boxlite-Outbound-Revision`.
Only policy enters the JSON request body.
HTTP 200 requires one strong matching ETag and the complete matching policy; 412 remains a distinct rejected-precondition outcome.

Missing, weak, duplicated, malformed, or mismatched acknowledgements cannot establish application.
Unsupported routes never trigger the old policy setter, whose unconditional request shape remains unchanged.
Revision control exchanges have a ten-second total bound, including response reading.

Socket-backed REST tests run requests through NetworkHandle and the real HTTP encoder/decoder.
They cover exact request metadata, matching and rejected acknowledgements, old peers, invalid stored policy, and contradictory confirmed status.

### Native C revision boundary

The additive C ABI exposes `boxlite_network_outbound_snapshot`, `boxlite_network_outbound_status`, and `boxlite_network_replace_outbound_snapshot`.
Read calls allocate JSON strings owned by the caller; release them with `boxlite_free_string`.
Their output pointer is initialized to NULL before validating other inputs.

Replacement takes separate expected revision, fresh candidate revision, and complete policy JSON strings, borrowed for the blocking call.
For example, expected `rev-a`, candidate `rev-b`, and `{"mode":"disabled"}` preserve the same identity through NetworkHandle and its selected local or REST backend.
`Ok` with `out_applied=1` confirms application; `Ok` with `out_applied=0` reports a failed precondition.

Errors also initialize `out_applied` to zero and keep the existing error-code ABI.
Malformed UTF-8, invalid tokens, repeated/reserved candidates, invalid policy, and null required pointers are rejected before dispatch.
These are trusted-coordinator operations; the existing unconditional setters retain their signatures.

The C boundary tests call the actual exported functions through a REST runtime and inspect the resulting HTTP requests.
They free returned strings and check output initialization and rejection without dispatch.

### Go coordinator API

`Network.OutboundSnapshot` reads durable intent; `Network.OutboundStatus` reads the durable/live comparison and pending evidence.
`ReplaceOutboundSnapshot(ctx, expected, candidate)` preserves the coordinator's fresh candidate across the C ABI and selected Runtime backend.
Check both its error and `OutboundReplaceOutcome`: `OutboundPreconditionFailed` with a nil error is a rejected update, not application.

`OutboundPolicy` supplies explicit wire field names without changing the existing `OutboundNetworkSpec` structure or setter request shapes.

Revision strings are validated before C-string conversion, including embedded NUL, length, and ASCII-token checks.
Network calls retain a shared lifetime lock; Close takes the exclusive lock before freeing the C handle.
Policy updates remain serialized by Runtime's Box operation lock, while a concurrent status read through the same Go Network handle remains available.

As with the existing blocking setters, context cancellation is checked before entering the native call; it does not cancel an in-flight native update.

Go tests use the actual Go/C/Rust stack against controlled HTTP peers, including a held update with concurrent status read.
They cover precondition failure, malformed ACK, unsupported peers, and invalid or cancelled calls rejected before dispatch.

Durable-control tests use the real Runtime operation lock and SQLite database with controlled backend replies.
They cover lost ACKs, pending readback, late requests, competing writers, failed pending writes, fresh restoration identities, stale compensation, and restoration persistence failure.
These tests exercise the new revision protocol; the existing unversioned setter's compatibility behavior is covered separately.

### Runner control resources

Runner exposes policy GET, status GET, and dedicated snapshot PUT under its existing bearer-authenticated Box network routes.
Reads use request-owned Runtime handles without starting a VM; replacements require a running Box.

The independent network handle retains its native ownership after the temporary Box wrapper closes.
Readback leaves borrowed lifecycle cache entries untouched.

Policy GET returns the policy body and persisted revision as a strong ETag.

Snapshot PUT requires one strong expected revision and one fresh candidate header before acquiring a Runtime handle.
A stale comparison returns 412; only the explicit `applied` outcome returns the matching policy and candidate ETag.

Runner tests execute its production bearer and error middleware over HTTP.
Missing, malformed, and wrong credentials cannot reach control lookup; the configured bearer can use all three resources.
A separate client test crosses the actual Go/C/Rust transport against a controlled Runtime peer, including stopped-Box reads and refused mutation.

### CLI serve control resources

The CLI serve router implements the same resources.
Its existing public policy PUT accepts HTTP `If-Match`, including tag lists and wildcard matching, while retaining the unconditional response shape.
Coordinator headers on that public resource are rejected; trusted candidates use the dedicated snapshot path.

A rejected CAS triggers a fresh predicate check; tag lists and wildcard requests may still match a competing revision.
The server retains one candidate identity across at most two CAS attempts, then returns conflict if contention persists.
Transport errors and uncertain outcomes return immediately without retry or an unconditional fallback.

The diagram uses illustrative revision tokens; HTTP tests allocate the candidate through the real coordinator.

```mermaid
sequenceDiagram
    participant Caller
    participant Serve as CLI serve
    participant Other as Concurrent coordinator
    participant Runtime
    Caller->>Serve: PUT with If-Match [rev-a, rev-b]
    Note over Serve: Allocate candidate rev-c once
    Serve->>Runtime: Read persisted snapshot
    Runtime-->>Serve: rev-a
    Other->>Runtime: Replace rev-a with rev-b
    Runtime-->>Other: ACK rev-b
    Serve->>Runtime: CAS expected rev-a, candidate rev-c
    Runtime-->>Serve: 412, candidate not applied
    Serve->>Runtime: Read persisted snapshot
    Runtime-->>Serve: rev-b
    Note over Serve: The public tag list still matches
    Serve->>Runtime: CAS expected rev-b, same candidate rev-c
    Runtime-->>Serve: Matching ACK rev-c
    Serve-->>Caller: 200, ETag rev-c
```

Local status reports the same durable snapshot in `persisted` and `runtime_persisted` because this server has no separate Cloud store.
Absent pending and observation-error fields are omitted; an existing pending revision remains a string.
HTTP tests exercise the actual API-key middleware and verify denied requests cannot reach Box lookup or Runtime control.

### Cloud-to-Runner control adapter

`RunnerOutboundControl` uses the dedicated snapshot and status resources through the assigned Runner's existing control endpoint and bearer credential.
It never retries a versioned operation through the unconditional policy route.

```mermaid
flowchart LR
    C[Cloud coordinator] -->|Expected revision and full candidate| A[RunnerOutboundControl]
    A -->|Authenticated snapshot PUT or status GET| R[Assigned Runner]
    R -->|Revision-aware SDK and FFI| T[Runtime]
    T -->|Snapshot or refusal| R
    R -->|HTTP response| A
    A -->|Verified result or classified failure| C
```

Only HTTP 200 with the exact strong candidate ETag and complete matching policy acknowledges replacement.
HTTP 412 is a distinct precondition outcome; bare 404, 405, or 501 reports unsupported control.

Status requires `revision-v1`, valid complete snapshots, and an explicit application phase.
Runtime confirmation requires matching persisted and observed snapshots, a confirmed observation, and no pending revision or observation error.

For example, a live `rev-b` with unfinished Runtime persistence remains pending or uncertain, even when its policy matches.
This adapter validates Runtime completion; the Cloud coordinator must additionally compare its own durable state.

Every HTTP call has a ten-second deadline including response-body consumption and a 64 KiB response limit.
Redirects are rejected, and public errors omit endpoint credentials and upstream diagnostics.

`make test:apps:api TEST_FILES=runner-adapter/outbound-control.spec` exercises actual loopback HTTP, including stalled bodies and invalid acknowledgements.
The fixture models a Runner control peer; it does not boot a guest VM.

### Cloud durable intent

`OutboundPolicyStore` keeps private control metadata in the Box's nullable `outboundControl` JSONB column.
Apply pre-deploy migration `AddOutboundControl1794888000000` before deploying callers; older records use revision `initial`.
Ordinary entity reads omit the column.

The pending record contains the expected Runtime revision, full candidate policy and revision, and assigned Runner identity.
Policy and persisted revision change together when finalization clears pending.

`OutboundPolicyCoordinator` reserves pending in one transaction before dispatch.
A second transaction reacquires the same organization-scoped Box row lock and verifies that reservation and Runner still own the attempt.
It holds the lock through matching acknowledgement or confirmed Runtime readback and final persistence.

Five seconds bounds database lock acquisition; each Runner request independently has the adapter's ten-second deadline.
Failed or ambiguous application leaves the already committed pending evidence intact.

```mermaid
sequenceDiagram
    participant C as Cloud coordinator
    participant P as PostgreSQL primary
    participant R as Runner / Runtime
    C->>P: Tx1 lock Box; write full pending
    P-->>C: COMMIT reservation; release lock
    C->>P: Tx2 lock Box; verify exact pending owner
    C->>R: CAS expected to candidate
    R-->>C: Matching complete ACK
    C->>P: Write policy + revision; clear pending; COMMIT
    alt COMMIT reply received
        P-->>C: Completion; release lock
    else Publication failed or COMMIT outcome unknown
        C->>P: Release failed connection; new primary transaction and lock
        P-->>C: Durable policy, revision, pending owner
        alt Matching candidate is already durable
            Note over C,P: Keep the committed candidate; no restoration
        else Original pending still owns the previous durable policy
            C->>P: Write fresh restoration pending; COMMIT reservation
            C->>P: Reacquire Box lock; verify restoration and Runner owner
            C->>R: CAS acknowledged candidate to fresh restoration
            Note over C,R: Failed restoration keeps its pending evidence
            Note over C,P: Completed restoration uses the same finalization path
        else Superseded owner or primary unavailable
            Note over C,R: Return failure; no restoration dispatch
        end
    end
```

`OutboundCommitUnknown` distinguishes an unacknowledged commit from an error inside the transaction callback.
Recovery reads through a new primary transaction before deciding whether restoration is allowed.
A matching durable candidate needs no restoration; a superseded owner or unavailable database cannot authorize one.

Proven failed persistence may reserve the previous policy with a fresh revision and apply it conditionally against the acknowledged candidate.
Restoration failure preserves its own pending evidence and returns failure.
A successful restoration repairs state but does not make the original failed replacement successful.

Cloud status compares its persisted snapshot with both Runtime persistence and completed backend observation.
GET does not reconcile pending or wait behind the writer's row lock.

A later mutation may finalize a completed pending candidate before checking its public precondition; stale callers then receive 412.
An unconditional complete replacement may fence unresolved older requests through a fresh CAS.

Run `make test:apps:api TEST_FILES=outbound-policy.store.integration` with loopback `DB_HOST`, `DB_PORT`, `DB_USERNAME`, and `DB_DATABASE`.
The suite owns a temporary schema and a PostgreSQL frame proxy that disconnects before forwarding COMMIT or before forwarding its server completion.
It combines real transactions and HTTP with a controlled Runner peer; it does not exercise a guest VM or deployed Cloud instance.

A real PostgreSQL trigger rejects final publication after the Runner ACK to exercise restoration and failed-restoration intent.
Socket loss and pending/uncertain readback checks distinguish matching revisions from completed application.

### Public Cloud control resources

Public policy GET returns the existing policy object with a strong revision ETag; status GET returns completion metadata separately.
Policy PUT retains its complete-replacement body and accepts optional HTTP `If-Match`, including strong tag lists and wildcard matching.
The coordinator allocates candidate revisions; caller-supplied internal candidate headers are rejected.

Public lists ignore empty elements; an empty list matches no revision, while weak tags never satisfy strong comparison.
Wildcard stands alone, and the complete field is validated before any matching tag can authorize a mutation.
Only HTTP SP and HTAB count as surrounding whitespace, including on internal single-revision control resources.

These rules follow [RFC 9110 list parsing and whitespace](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6).

Reads require organization membership; writes also require the existing Box write permission.
Status describes control-state agreement and does not probe destination connectivity.
MCP access to these outbound resources requires an API key under its OAuth default-deny policy.

The HTTP authorization suite runs actual API-key and signed-JWT strategies and organization guards with controlled credential, membership, Redis, and Box storage.
It checks canonical, organization-prefixed, and legacy paths; it does not boot the production Cloud application or guest VMs.

### Runtime readback and coordinator recovery

`NetworkHandle::outbound_status` compares a durable snapshot with the backend's observed snapshot and installation phase.
It reports `persisted`, optional `observed`, overall `application_state`, optional `pending_revision`, and optional `observation_error` outside user policy JSON.
The durable policy, revision, pending attempt, and VM identity come from one SQLite row version.
Neither this status call nor `outbound_snapshot` acquires the mutating Box operation lock, so reads remain available during a pending update.
Both calls leave pending records and policy unchanged.

Overall `confirmed` requires an exact policy/revision match, a confirmed backend phase, and no durable pending attempt.
A pending backend phase remains `pending`; any mismatch or unresolved attempt is `uncertain`.
Backend observation has a ten-second bound; a failed observation retains durable intent and a diagnostic without claiming live confirmation.
An unsupported backend returns an explicit unsupported error.
A stopped Box returns uncertainty without starting a VM; a handle from an older VM epoch cannot query through its cached backend.
A newly acquired running handle can read the existing control socket without booting or attaching the guest.

After coordinator loss, a surviving backend can report the confirmed pending candidate while durable policy still identifies its predecessor.
GET preserves that divergence as uncertainty.
A subsequent mutating operation can reconcile the matching confirmed candidate before evaluating the caller's precondition; a caller using the predecessor then receives `PreconditionFailed`.
When the backend restarts from committed policy, matching the old durable revision still does not resolve the pending attempt.
A new unconditional complete intent can replace that uncertain state with a fresh candidate through CAS.

Recovery acceptance uses real SQLite storage and a real gvproxy instance over its Unix control socket.
A test-only cancellation point stops the coordinator after a matching backend ACK and before durable commit, then reacquires the Box handle with the backend surviving or restarting.
The VM and guest session remain test fixtures; this checks the control and persistence boundary, rather than an operating-system process crash or guest-VM boot.
Run these checks with real dependencies:

```sh
make test:unit:rust FILTER=outbound_recovery RUST_UNIT_CORE_ARGS='-p boxlite --all-features --lib'
```

### Runtime bootstrap identity

New and restarted VMs receive the persisted revision alongside their persisted policy.
Records without control metadata use `initial`.
An unresolved pending candidate is not replayed at startup: the committed policy and revision seed the backend, and the pending record remains available for reconciliation.
Reattaching to a surviving backend does not replace its live identity.

The revision travels in a private field of the existing stdin launch message, then in the private JSON object passed to gvproxy.
`InstanceSpec`, `NetworkBackendSpec`, `GvproxyConfig`, and `BoxState` keep their public fields.
The existing `GvproxyInstance::from_config` constructor remains available; the explicit revision constructor restores a coordinator-owned identity.
The shim validates the optional token before starting the backend; absent metadata preserves the legacy launch contract.

The shared `bootstrap-v1.json` example passes through the production launch encoder, shim parser, and gvproxy JSON encoder.
Real-library tests create gvproxy with a restored revision, verify live readback and conditional replacement, reject a stale replacement, and repeat after backend restart.
These checks exercise the Rust/Go control boundary without requiring a guest VM.

Run the bootstrap checks with real dependencies, because stub mode cannot link the shim or gvproxy FFI:

```sh
make test:unit:rust FILTER=outbound_bootstrap RUST_UNIT_CORE_ARGS='-p boxlite-shim --bin boxlite-shim'
make test:unit:rust FILTER=outbound_bootstrap RUST_UNIT_CORE_ARGS='-p boxlite --all-features --lib'
```

Install stable TCP and UDP entry points before guest traffic starts, with one shared snapshot reference.
Enabled-to-enabled replacement publishes that reference once; delayed setup, retries, and MITM upstream sockets retain their flow's captured snapshot.

Disabled mode rejects new flows independently of the empty allowlist.
A mode gate before IP endpoint demultiplexing also covers registered services such as DNS, which bypass default transport handlers.
This gate uses the same snapshot and leaves enabled-mode DNS behavior unchanged.
Packets arriving under disabled mode cannot start new DNS forwarding; work accepted before publication retains established-work semantics.

To disable, publish the disabled snapshot before suspending the NIC, then acknowledge only after suspension succeeds.
To enable, retain the disabled snapshot until NIC enabling succeeds, then publish the enabled candidate.
Mark application pending before publication or a mode transition.
On a failed mode transition, retain the disabled gate and report uncertainty; do not confirm the candidate or a stale previous revision.
Compilation failure before publication preserves the previous confirmed snapshot.

An acknowledgement timeout leaves the outcome uncertain because the candidate may already be live.
Perform bounded readback and distinguish the expected, candidate, and another revision; unresolved state remains explicit.
Observing the expected revision does not prove rejection while the original request can still apply later.

Keep uncertainty until completion or fencing is established; this contract does not require a new fencing API.

After confirmed application, persistence failure can trigger conditional compensation against the candidate revision.
Restoration uses a fresh token, so stale clients cannot succeed after a change-and-restore cycle.
Do not replay or compensate blindly after an ambiguous timeout.

If recovery cannot confirm both application and persistence, return failure and preserve readback diagnostics.

Database unavailability cannot support a durable-state claim; require readback after recovery.

The crash check stops the coordinator after a matching acknowledgement and before persistence.
Repeat with gvproxy surviving the coordinator, then with gvproxy restarting too.
Reconcile observed and persisted revisions or expose uncertainty; never label a stale stored revision as confirmed live state.

## Application and recovery timing

The coordinator marks application pending before publication or a NIC transition.
The following sequence expresses the application and recovery contract above; it is an implementation target.

```mermaid
sequenceDiagram
    participant C as Coordinator
    participant S as gvproxy snapshot
    participant N as Guest NIC
    participant D as Persistence
    Note over C,S: Complete candidate is validated and compiled
    C->>S: Mark application pending
    alt Disable
        C->>S: Publish disabled snapshot
        C->>N: Suspend NIC
    else Enable
        Note over S,N: Keep disabled snapshot during NIC enabling
        C->>N: Enable NIC
    else Enabled-to-enabled replacement
        C->>S: Publish candidate once
    end
    alt Mode transition fails
        Note over C,N: Retain disabled gate; report uncertainty without confirmation
    else Publication or transition succeeds
        opt Enabling
            C->>S: Publish enabled candidate after NIC enabling succeeds
        end
        alt Exact candidate application confirmed
            S-->>C: Acknowledgement or readback identifies exact installed candidate
            C->>D: Persist candidate
            alt Persistence succeeds
                Note over C,D: Application and persistence confirmed
            else Persistence fails
                C->>S: Conditional compensation against candidate with fresh token
                C->>D: Persist restoration if application confirmed
                Note over C,D: Unconfirmed restoration or persistence remains uncertain
            end
        else Application unresolved
            C->>S: Bounded readback after acknowledgement timeout
            S-->>C: Expected revision observed; application may still be running
            Note over C,S: Old-revision readback cannot prove rejection while request can still apply
            Note over C,S: Remain uncertain until request completion or fencing is established
            Note over C,D: Preserve uncertainty; no blind replay or compensation
        end
    end
```

## Shared examples and evidence

`tests/fixtures/outbound/contract-v1.json` separates current policy examples from versioned replacement and connection-boundary examples.
The versioned cases are implementation targets; the fixture file does not enable a backend capability.
Runtime, Runner, Cloud, and forwarding tests should consume the applicable cases through their real production boundaries.

| Boundary | Required evidence |
| --- | --- |
| Destination and transport | Allowed ordinary, hostname, and MITM flows reach the selected connector; rejected targets never reach it. |
| NAT and controlled DNS | Pre-NAT checks, approved literal dialing, candidate changes, cancellation, and setup budgets retain their contract. |
| Replacement | Stale writes and stale compensation lose under controlled interleavings. |
| Mode transitions | TCP/UDP and registered DNS stay gated during paused NIC transitions and after injected NIC failures; enabled controls still succeed. |
| Acknowledgement | Missing or mismatched acknowledgement cannot appear as confirmed success. |
| Recovery | Persistence errors, delayed application after old-revision readback, and the specified crash windows retain explicit uncertainty. |
| Compatibility | Existing mode/allowlist clients retain their documented behavior; unsupported extensions and old backends fail explicitly. |
