# Per-box network rate limit API design

Status: accepted

## Decision

A box's network bandwidth is capped per direction, in kilobits per second,
named from the box's point of view: `tx` is what the box sends, `rx` is what
reaches it. The cap is expert-only configuration and travels with the other
expert knobs under `advanced` on every surface, rather than widening the
top-level box API:

| Surface | TX | RX |
| --- | --- | --- |
| Rust, Python, REST | `advanced.network_rate_limit.tx_kbps` | `advanced.network_rate_limit.rx_kbps` |
| Node.js / TypeScript | `advanced.networkRateLimit.txKbps` | `advanced.networkRateLimit.rxKbps` |
| Go | `AdvancedBoxOptions.SetNetworkRateLimit(NetworkRateLimit{TxKbps: …})` | `…{RxKbps: …}` (same call) |
| C | `boxlite_advanced_options_set_network_rate_limit(opts, tx_kbps, rx_kbps)` | (same call) |
| CLI | `--net-tx-kbps` | `--net-rx-kbps` |
| Hosted API (`POST /api/v1/boxes`) | `networkTxKbps` | `networkRxKbps` |

Omitting a direction, or `0`, leaves it uncapped. One predicate,
`NetworkRateLimit::is_unlimited`, decides this everywhere: no surface
re-encodes the zero rule, and a one-sided cap sends its explicit `0` verbatim.

Shaping happens below IP in the gvproxy bridge, so one budget per direction
covers TCP, UDP, ICMP and ARP together. Which side opened a connection does
not matter: traffic arriving over an inbound forward is charged to `rx` like
a reply to an outbound request. The cap is on the interface, not on a
connection's direction.

A cap on a box whose outbound network is disabled is rejected — there is no
interface to shape. `BoxOptions::sanitize_common` enforces this once, at
`BoxliteRuntime::create`, on both the local and the REST path.

The cap is create-time configuration. Like the capability policy, the BoxLite
REST `Box` schema does not report it; the hosted API's own `Box` response
echoes the persisted columns because the row is what the runner replays.

## Compatibility and rollout

Every versioned boundary negotiates support before a cap can be silently
dropped:

- A remote SDK reads `capabilities.network_rate_limit_enabled` from
  `GET /v1/config` before a capped create and refuses with `Unsupported` when
  it is absent. The read is cached, unlike the Linux-capability gate: a
  dropped cap costs bandwidth, it does not widen what the guest may do, and
  the uncached re-read exists for gates whose silent failure is a privilege
  change.
- Every in-repo server fails closed on the field itself when it predates it:
  `boxlite serve` through `deny_unknown_fields`, the reference server through
  `extra="forbid"`, and a pre-feature hosted API by refusing `advanced`
  outright. A stale positive in the client cache can therefore only degrade
  the error message, never the outcome.
- An uncapped or all-zero limit never probes the server and never puts
  `advanced` on the wire, so an ordinary create keeps the shape every server
  version already handles.

On the hosted control plane the cap has one carrier: the `Box` row.
`BoxStartAction` hands the persisted entity, not the request, to the runner
adapter, and recover, stop/start and migration all replay that row. The two
nullable `integer` columns (`networkTxKbps`, `networkRxKbps`, pre-deploy
migration) are therefore load-bearing, not a cache; `bigint` was avoided
because TypeORM maps it to a JavaScript string, and int4's ~2.1 Tbit/s ceiling
is far above any real link. From the row the cap reaches the runner's
`CreateBoxDTO` and `RecoverBoxDTO`, then the Go SDK's advanced-options handle,
then the same gvproxy shaper a local box uses.

Two control-plane rules follow from "never drop silently":

- A capped request always gets a fresh box. A warm-pool box is already booted
  and the pool key carries no bandwidth, so claiming one would return 201
  with a box that ignored the cap (`requiresFreshBox`).
- A cap on a box whose network ends up blocked — explicitly, or through the
  organization's limited-egress default — is a 400 at the API, checked after
  that default resolves. The runner's core would refuse the pairing anyway;
  refusing earlier turns a doomed CREATE_BOX job into an error the caller
  sees.

The hosted `/v1/config` advertises `network_rate_limit_enabled` only in the
same change that carries the field end to end: flipped earlier, the Rust
client would send caps into a 400 or, worse, into a server that accepts and
drops them. Once capped boxes exist, roll forward rather than back to a build
that predates the columns.

There is no platform bandwidth policy today, so the capability is a boolean
and no `max_network_*_kbps` ceilings are advertised. The only bound is the
hosted API's column range, reported as a validation message, not as protocol.

## Project research

The projects below were reviewed at their current primary-source interfaces.
They agree on the shape: per-direction caps on the interface, zero meaning
unlimited, with hypervisors exposing a token bucket and container stacks
reaching for `tc`.

| Project | Interface and relevant behavior |
| --- | --- |
| Firecracker | Per-interface `rx_rate_limiter` / `tx_rate_limiter: Option<RateLimiterConfig>` on the net device ([net.rs:31-33](https://github.com/firecracker-microvm/firecracker/blob/16f9023f8b66/src/vmm/src/vmm_config/net.rs#L31-L33)); a `TokenBucket` of `size` bytes refilled over `complete_refill_time_ms` with an optional `one_time_burst` ([rate_limiter/mod.rs:58-92](https://github.com/firecracker-microvm/firecracker/blob/16f9023f8b66/src/vmm/src/rate_limiter/mod.rs#L58-L92)). BoxLite's bridge bucket and its guest-relative `tx`/`rx` naming follow this model. |
| Cloud Hypervisor | `NetConfig.rate_limiter_config: Option<RateLimiterConfig>` with bandwidth and ops buckets ([vm_config.rs:448-479](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/4b8efa549e0f/vmm/src/vm_config.rs#L448-L479)), plus named `rate_limit_group`s shared across devices ([vm_config.rs:396-401](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/4b8efa549e0f/vmm/src/vm_config.rs#L396-L401)). |
| Kata Containers | Sandbox-wide `rx_rate_limiter_max_rate` / `tx_rate_limiter_max_rate` in bits/sec, `0` = unlimited ([configuration-qemu.toml.in:439-447](https://github.com/kata-containers/kata-containers/blob/d72ce7a3f3ab/src/runtime/config/configuration-qemu.toml.in#L439-L447)); enforced host-side with tc HTB, plus ifb for the tx direction ([network_linux.go:242-249](https://github.com/kata-containers/kata-containers/blob/d72ce7a3f3ab/src/runtime/virtcontainers/network_linux.go#L242-L249), [:1449](https://github.com/kata-containers/kata-containers/blob/d72ce7a3f3ab/src/runtime/virtcontainers/network_linux.go#L1449), [:1605](https://github.com/kata-containers/kata-containers/blob/d72ce7a3f3ab/src/runtime/virtcontainers/network_linux.go#L1605)). |
| CNI bandwidth plugin | `BandwidthEntry { ingressRate, ingressBurst, egressRate, egressBurst }` in bits/sec, `0` = no limit, and a rate must come with its burst ([main.go:42-51](https://github.com/containernetworking/plugins/blob/9abb55bf7b65/plugins/meta/bandwidth/main.go#L42-L51), [main.go:74-78](https://github.com/containernetworking/plugins/blob/9abb55bf7b65/plugins/meta/bandwidth/main.go#L74-L78)); tbf on the container's veth. |
| Kubernetes | Pod annotations `kubernetes.io/ingress-bandwidth` and `kubernetes.io/egress-bandwidth`, handed to the CNI bandwidth plugin rather than modelled as a resource ([network plugins — traffic shaping](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/#support-traffic-shaping)). |
| Cilium | Bandwidth Manager honours `kubernetes.io/egress-bandwidth` with EDT-based BPF pacing and explicitly does not shape ingress ([Bandwidth Manager](https://docs.cilium.io/en/stable/network/kubernetes/bandwidth-manager/)). |
| libvirt | Per-interface `<bandwidth>` with `<inbound>` / `<outbound>` `average`, `peak`, `burst` in kilobytes per second ([domain XML — quality of service](https://libvirt.org/formatdomain.html#quality-of-service)). |
| Docker / Moby | `HostConfig` throttles block I/O (`BlkioDeviceReadBps` / `BlkioDeviceWriteBps`, [hostconfig.go:380-381](https://github.com/moby/moby/blob/d0ecdbf8f0de/api/types/container/hostconfig.go#L380-L381)) but carries no network bandwidth field; network shaping is left to the host's `tc`. |

## Alternatives rejected

- **Top-level fields next to `network`:** the object-shaped `NetworkConfig`
  wire types are the outbound and inbound halves of the REST form and deny
  unknown fields; a cap is bidirectional and belongs to neither. Grouping it
  under `advanced` matches the capability policy and keeps creation
  extensible.
- **Advertising `max_network_*_kbps` ceilings:** there is no platform policy
  to back them, so the numbers would be invented. The one real bound, the
  hosted column range, is a validation message. Ceilings can be added when a
  policy exists.
- **Clamping to a platform minimum:** silently tightening is a second
  interpretation of the caller's number. This surface rejects rather than
  strips, and the same applies to rewriting.
- **Uncached capability re-read:** reserved for policies whose silent loss
  changes privilege. Every server rejects the field when it predates it, so
  the cache can only affect the message.
- **Normalising `Some(0)` to absent on the wire:** a third encoding of the one
  zero rule, in the place most likely to drift from the other two.
- **`bigint` columns, pointer fields in the runner DTO:** TypeORM maps
  `bigint` to a string, and `0 == absent` already holds, so a pointer would
  express a distinction the core does not make.
- **A throughput assertion in the CLI e2e:** it cannot tell a slow host from
  a dropped cap. The CLI test proves the wire is open; the timing assertion
  lives in the control-plane e2e, against an uncapped baseline.
