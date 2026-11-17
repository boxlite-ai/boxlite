# Outbound transport and policy update foundation

**Status:** Accepted; implementation and traffic validation are pending.

Design: https://github.com/boxlite-ai/boxlite/issues/2715

Implementation contract and shared examples: [outbound connection and replacement contract](../architecture/outbound-contract.md).

## TL;DR

Unify outbound connection setup and versioned policy replacement so target checks, transport selection, persistence, and application acknowledgements use one consistent snapshot.

## Problem

BoxLite currently has separate socket paths for ordinary TCP, inspected hostname traffic, and secrets interception.
The ordinary forwarder calls `net.Dial` directly; hostname traffic already has injectable resolver and dial functions.
See the [forwarder](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/src/deps/libgvproxy-sys/gvproxy-bridge/forked_tcp.go#L149) and [dialer](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/src/deps/libgvproxy-sys/gvproxy-bridge/egress_dialer.go#L33).

Runtime and Cloud already serialize outbound replacement, apply it, persist it, and attempt rollback on persistence failure.
They do not correlate application with a policy revision, and Cloud currently accepts a successful status without validating an acknowledgement body.
See [Runtime replacement](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/src/boxlite/src/litebox/box_impl.rs#L1787), [Cloud replacement](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/apps/api/src/box/repositories/box.repository.ts#L113), and [Runner acknowledgement handling](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/apps/api/src/box/runner-adapter/network-policy.ts#L7).

These boundaries need a common contract before adding independent policy and upstream transport extensions.

Policy replacement also installs TCP and UDP handlers before changing the NIC state.
For a disabled candidate with an empty allowlist, this can publish unrestricted handlers before NIC suspension.
See the [installation order](https://github.com/boxlite-ai/boxlite/blob/b81a1a6b24005b8d644ec94efd02b3ce72f3385f/src/deps/libgvproxy-sys/gvproxy-bridge/network_policy.go#L61-L82).
Registered DNS endpoints bypass default transport handlers, so gating those handlers alone cannot preserve disabled mode when NIC suspension fails.
See the [endpoint distinction](https://github.com/boxlite-ai/boxlite/blob/b81a1a6b24005b8d644ec94efd02b3ce72f3385f/src/deps/libgvproxy-sys/gvproxy-bridge/forked_udp.go#L10-L15).

## Scope

Extend the existing gvproxy process, resolver/dial seams, network controller, Runtime lock, and Cloud transaction.
Preserve current mode/allowlist behavior, connection-time DNS checks, pre-NAT policy matching, and established-flow semantics.
Add conditional updates, revision-correlated acknowledgements, capability checks, and explicit readback of uncertain application state.

Proxy protocols, registration, credential storage, new deny matching, larger rule limits, and an IPv6 data plane are separate implementations.
Their eventual configuration must use the same snapshot and replacement operation; this foundation must reject unsupported capabilities.

## Related work and lessons

| Method | Projects and primary sources | Trade-off | Stance |
| --- | --- | --- | --- |
| Check resolved candidates, then dial a pinned address | [BoxLite's existing dialer](https://github.com/boxlite-ai/boxlite/blob/0c15a54267a87c529ff5f587adeaa20d1c62e9e8/src/deps/libgvproxy-sys/gvproxy-bridge/egress_dialer.go#L104), [Smokescreen](https://github.com/stripe/smokescreen/blob/master/pkg/smokescreen/smokescreen.go) | Domain approval alone does not approve every resolved IP; centralization must preserve NAT and cancellation. | **Pick:** adapt existing seams; do not add a second resolver/dialer. |
| Gate disabled mode before endpoint demultiplexing | [gVisor input filtering](https://github.com/google/gvisor/blob/a174eb65023f/pkg/tcpip/network/ipv4/ipv4.go#L1207-L1216), [gVisor target interface](https://github.com/google/gvisor/blob/a174eb65023f/pkg/tcpip/stack/iptables_types.go#L382-L388) | Covers registered DNS endpoints as well as default forwarders; adds per-packet filtering cost, which must be measured before claiming equivalent performance. | **Pick:** adapt the existing dependency's input/forward hooks, retain NIC suspension, and share the immutable mode snapshot. |
| Conditional replacement | [Kubernetes resource versions](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions), [HTTP If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1) | Prevents stale client writes; requires a compatibility path for existing clients. | **Pick:** optional HTTP preconditions for current clients, mandatory internal compare-and-swap for versioned operations. |
| Correlate acceptance with configuration identity | [Envoy xDS](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol.html#ack-nack-and-resource-type-instance-version), [go-control-plane](https://pkg.go.dev/github.com/envoyproxy/go-control-plane/pkg/cache/v3) | A success without an identity cannot identify which update was applied; xDS streaming is unnecessary here. | **Pick:** adapt versioned acknowledgement over existing control channels. |
| Add a separate proxy or configuration service | [Envoy in Istio](https://istio.io/latest/docs/ops/deployment/architecture/) | Strong isolation and extensive features, with additional processes and operational scope. | Reject for this foundation; the existing embedded boundary is sufficient. |
| Retain separate dial paths and status-only success | Current BoxLite source above | Smallest immediate change, but future transport and policy paths can diverge. | Reject as the integration contract. |

Smokescreen's [documented rule precedence](https://github.com/stripe/smokescreen/blob/master/README.md#ip-filtering) differs from a deny-first policy, so its precedence is not adopted.
Its [hostname normalization advisory](https://github.com/stripe/smokescreen/security/advisories/GHSA-gcj7-j438-hjj2) motivates mixed-case and trailing-dot tests.
The [SSRF defense study](https://www.usenix.org/conference/usenixsecurity24/presentation/wessels) is historical failure evidence; it does not establish the best current update protocol.

## How it works

A policy determines whether a destination is allowed; a transport determines how an approved connection reaches it.
A snapshot fixes both choices for one flow, with one policy revision and an optional upstream registration revision.

Example: revision `rev-a` allows only `api.example.com` through the direct transport.
Connection A to `api.example.com:443` captures `rev-a`, checks its resolved candidates, and dials an approved literal IP.
A conditional replacement with `If-Match: "rev-a"` installs `rev-b`, allowing only `updates.example.com`.

After the matching acknowledgement, new `api.example.com` connections are blocked before dialing, while connection A retains `rev-a`.
The applied acknowledgement identifies `rev-b`; a later update with stale `If-Match: "rev-a"` returns 412 without application.

```text
Guest flow → capture snapshot → identify/check target → controlled resolution
           → check each candidate → selected transport dials approved IP

Complete replacement + expected revision → existing update lock → validate/compile
           → apply candidate revision → validate matching acknowledgement → persist
```

### Connection boundary

Reuse `resolveFunc`, `dialFunc`, `upstreamDial`, and `egressDialer`.
Ordinary TCP, inspected TCP, and secrets upstream connections must enter the same transport boundary after their applicable target checks.
The boundary carries the original hostname, literal connection address, actual destination port, protocol, and snapshot identity.

Keep pre-NAT policy addresses distinct from translated connection addresses.
The current host alias retains its local direct behavior; a future remote transport must explicitly reject unsupported local aliases.
Do not interpret a translated loopback address as an equivalent destination on a remote proxy.

Hostname authorization resolves through the selected controlled resolver, checks candidates individually, and dials only approved literal addresses.
Preserve the hostname for SNI, Host, and certificate verification; retries recheck candidates and share one bounded deadline.
Transport failure must not implicitly choose a different route.

### Configuration and revision contract

| Object | Contract |
| --- | --- |
| Policy | User configuration only; no credentials, application status, or update metadata. |
| Snapshot | Complete normalized policy plus an opaque revision; future route identity and registration revision belong to the same applied snapshot. |
| Internal replacement | Expected current revision plus the candidate snapshot; compare under the existing lock. |
| Acknowledgement | Exact candidate revision after installation; a missing, malformed, or different revision is not success. |
| Status | Persisted revision, observed applied revision when available, and an explicit application state; stored configuration alone does not prove live state. |

Revisions are opaque strings scoped to a Box, never timestamps or values ordered by clients.
Existing records start with a documented initial token; successful changes receive fresh tokens.
The initiating trusted coordinator chooses a candidate once and propagates it unchanged through API, Runner, Runtime, and gvproxy.

Keep the existing PUT policy body and successful policy response shape.
Add GET on the outbound policy resource with its strong ETag; conditional PUT uses `If-Match`, and a false precondition returns 412 before application.
Expose live/persisted comparison through a separate outbound status resource so application metadata does not enter strict policy decoders.

Current legacy mode/allowlist setters remain unconditional at the public boundary, while the server uses its locked current revision internally.
Version-aware operations must fail explicitly against an old backend rather than silently degrade to an unchecked update.
New protections cannot be cleared by an old caller omitting fields: future deny and proxy integration must reject incomplete replacements when those fields are active.
Explicit empty deny clears user denies; explicit null proxy clears the binding; neither clears platform constraints.

Disabled retains the current nonempty-allowlist rejection and NIC suspension behavior.
Future deny/proxy configuration may remain stored while disabled, but cannot enable traffic; their omission and clearing rules still apply.

### Application, persistence, and recovery

Compare-and-swap is performed under the current Box update lock and Cloud row lock; all callers, including future rotation jobs, share it.
Compile and validate the complete candidate before publication.
Install stable TCP and UDP entry points before guest traffic starts; each new flow loads one shared immutable snapshot, including mode, filter, transport, and revision.
Enabled-to-enabled replacement publishes one snapshot reference; existing flows retain their captured snapshot for delayed resolution, retries, and MITM upstream connections.

A disabled snapshot explicitly rejects new TCP and UDP flows, regardless of its empty allowlist.
Install a mode gate before IP endpoint demultiplexing, including registered DNS endpoints, using the existing gVisor input/forward filtering hooks and the same snapshot reference.
The pinned gVisor version calls [input filtering before local delivery](https://github.com/google/gvisor/blob/a174eb65023f/pkg/tcpip/network/ipv4/ipv4.go#L1207-L1216); its [target interface](https://github.com/google/gvisor/blob/a174eb65023f/pkg/tcpip/stack/iptables_types.go#L382-L388) supports a mode-dependent verdict.
This gate drops guest IP packets while disabled, even if NIC suspension fails; enabled-mode DNS behavior remains unchanged.
Work already accepted before publication may finish under its captured snapshot, subject to NIC suspension; a new DNS request arriving after publication cannot start host forwarding.
To disable, publish that snapshot before suspending the NIC; acknowledge only after suspension succeeds.
To enable from disabled, retain the disabled snapshot while enabling the NIC, then publish the enabled candidate after enabling succeeds.
Thus a packet arriving between either NIC operation and publication remains denied.
NIC disable continues to suspend traffic rather than promising to terminate every established connection.

Mark application pending before publication or a NIC transition.
An installation or NIC failure cannot acknowledge the candidate or describe the previous revision as confirmed live state.
Keep the disabled flow gate on a failed mode transition, expose uncertainty, and require readback/reconciliation before confirming another replacement.
Compilation failure before any publication preserves the previous confirmed snapshot.

An acknowledgement timeout is uncertain, because the candidate may already be live.
Use bounded status readback to reconcile the expected, candidate, or another revision; unresolved state is reported explicitly and never acknowledged as success.
Do not replay or compensate blindly after a timeout.

Reading the expected revision after a timeout does not prove rejection: the original application may still be in flight.
Keep the outcome uncertain until that request is known complete or fenced against later application.
This foundation need not add a fencing API; without such proof, preserve uncertainty and require subsequent readback.

If persistence fails after confirmed application, compensate conditionally against the candidate revision.
Restoration uses a fresh revision rather than reusing an old token, preventing stale clients from succeeding after a change-and-restore cycle.
If compensation or its persistence cannot be confirmed, retain diagnostic context and expose uncertainty through live status readback.
When the database itself is unavailable, durable status cannot be promised; return failure and require readback after recovery.

See the [application and recovery timing visual](../architecture/outbound-contract.md#application-and-recovery-timing) for named actors, NIC publication order, delayed application, and conditional compensation.

## Validation

Source inspection is complete; implementation and traffic validation below are planned.

| Claim or risk | Check | Expected result |
| --- | --- | --- |
| Common transport covers every TCP branch | Real guest-stack forwarding through ordinary, hostname, and secrets paths with an injected transport; retain allow/deny controls | Every allowed upstream uses the selected transport; blocked targets never reach it. |
| Existing behavior survives extraction | Current network suites, NAT alias, normalization, DNS candidate changes, cancellation, and blackholes | Same target decisions and bytes; bounded connection setup and cleanup. |
| Mode changes cannot expose an unrestricted interval | Pause after publishing disabled and before NIC suspension; probe denied TCP/UDP targets; repeat while enabling and inject NIC failures | Denied targets never reach a connector; a failed transition stays gated and cannot report a confirmed revision. |
| Registered endpoints cannot bypass disabled mode | Send guest UDP and TCP DNS queries after disabled publication, during paused NIC transitions and after injected NIC failure; observe a test-owned DNS upstream | No new guest query starts host forwarding while disabled; enabled-mode DNS controls still succeed. |
| Concurrent replacements cannot overwrite newer state | Controlled interleavings through controller, Runtime storage, and Cloud transaction | One expected revision wins; stale candidates and stale compensations are rejected. |
| Success identifies an installed snapshot | Missing/mismatched ACK, delayed ACK, old backend, and status readback tests | No status-only success; unsupported or uncertain state is explicit. |
| Recovery preserves state | Persistence failure, compensation failure, lifecycle writes, handle reacquisition, and restart | Confirmed configuration/revision survive; uncertainty cannot appear as confirmed live state. |
| A crash cannot turn live/persisted divergence into confirmed success | Stop the coordinator after a matching ACK and before persistence; restart with gvproxy surviving, then repeat with gvproxy restarting | Reconcile the observed and persisted revisions, or expose uncertainty; never report a stale persisted revision as confirmed live state. |
| Public compatibility is intentional | OpenAPI compatibility/default checks and production request/response tests | Legacy requests retain documented behavior; conditional requests enforce their precondition. |

Publish capability and acceptance evidence per layer; a parsed future field or a module-only test does not establish a working proxy or IPv6 data plane.
