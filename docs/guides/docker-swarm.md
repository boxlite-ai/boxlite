# Docker Swarm in runner-managed guests

Use a privileged guest for each Docker Engine. On Linux x86_64, the `v5.4.0`
DinD release asset refreshed on 2026-10-23 includes built-in IPVS TCP/UDP,
round-robin scheduling, conntrack netlink, xtables IPVS/u32 and VXLAN. Follow
the [DinD build instructions](docker-in-docker.md#build-the-runtime) for
prerequisites and replacing an older firmware cache, then package the release
kernel through the normal runtime:

```sh
make kernel:dind
export BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware"
make dev:runner-ci
```

The release kernel uses `iptables-nft`; legacy tables remain disabled. The
ordinary prebuilt firmware is not interchangeable with this DinD asset.

For a local source build, `make kernel:swarm` remains available. Set
`BOXLITE_LIBKRUNFW_SOURCE` to
`$PWD/.apps-local/runner-acceptance/firmware-swarm` before rebuilding the runtime.
This alternative uses Linux 6.12.87, vendored libkrunfw patches and
`scripts/build/dind-kernel.config`, and also enables legacy tables.
The builder defaults to two jobs and checks
download hashes, effective Kconfig options and the embedded config. Preserve
the generated `SHA256SUMS` and `build-info.txt` with runtime evidence.
It requires the normal Linux compiler/binutils, make, bc, bison, flex,
libelf headers, patch, xz, curl, flock and project Python with pyelftools.
`BOXLITE_KERNEL_BUILD_DIR`, `BOXLITE_KERNEL_OUTPUT`, `BOXLITE_KERNEL_DOWNLOADS`
and `BOXLITE_KERNEL_JOBS` override its directories and parallelism.
Apple Silicon uses the [DinD firmware builder](docker-in-docker.md).

The guest must also contain iproute2, ipvsadm and complete iptables extensions.
The pinned qualification image needs `apk fix --no-cache iptables iptables-legacy`
inside its ext4 filesystem to restore both `libxt_MARK.so` and `libxt_mark.so`.
This is explicit guest preparation, not a general image-extraction fix.

Start the image's official `dockerd-entrypoint.sh` with classic overlay2 and
`--dns-search=.`. This performs DinD mount initialization and keeps service DNS
queries from acquiring a host search suffix. Keep Docker's normal bridge,
firewall, IPVS and ingress networking enabled. Docker `--network host` refers
to the guest network namespace; it never joins the runner's host namespace.

## Node reachability

Every Box has its own NAT network and may have the same `192.168.127.2` address.
That address cannot identify multiple Swarm nodes. Supply a reachable IP network
between guests, then use each guest's distinct address for both
`--advertise-addr` and `--data-path-addr`. Required paths are manager 2377/TCP
and node-to-node 7946/TCP+UDP plus 4789/UDP. BoxLite's public tunnel interface
transports TCP; declaring a UDP port there does not create the required IP network.

The [real acceptance harness](../../apps/infra-local/compose/swarm_acceptance.py)
provides a two-node example using OpenVPN 2.6.20 inside both guests. It assigns
`10.77.0.1` and `10.77.0.2` to TUN interfaces and carries the authenticated,
encrypted IP link through a BoxLite SDK TCP tunnel to guest port 1194.
Swarm control traffic and VXLAN UDP travel through that link. Container requests
still use Docker service names, VIP/IPVS or DNSRR, and the user overlay; no HTTP
proxy or published service port carries those internal requests.

This is an explicit deployment setup, not automatic BoxLite mesh networking.
The forwarding SDK client must remain alive and reachable from the peer guest.
The fixture uses the runner-host alias `192.168.127.254` because both runners
are on one physical host. A deployment on different physical hosts must provide
its own reachable forwarding endpoint and validate that topology separately.
Keys are generated per test and kept out of the committed evidence. The example
is two-node only; it does not provision a general multi-peer VPN or certificate
lifecycle. No throughput or startup-time claim is made.

The VPN MTU is 1400; user overlays and ingress use 1200 to allow encapsulation.
Configure ingress before publishing services, and wait for the old ingress
network to disappear before creating its replacement. VIP and DNSRR are separate
tests. DNSRR is not combined with ingress publication.

## External access and acceptance

Create the guest with explicit inbound enablement:

```python
network=boxlite.NetworkSpec(
    inbound=boxlite.InboundNetworkSpec(mode="enabled"),
)
```

Use `await box.network.tunnel(port)` and its `forward(...)` handle to reach
published ports. The configured BoxLite port proxy must point at the same API
and runners. The isolated test stack uses API 13001, runners 13003/13004 and
the existing BoxLite proxy on 14000. The proxy starts outside the ordinary
development stack's dotenv directory so its credentials remain isolated.

Run each command separately, after building the DinD runtime:

```sh
make dev:runner-ci:proxy
make test:runner-ci:infra ACTION=restart
make test:runner-ci:swarm TOPOLOGY=single
make test:runner-ci:swarm TOPOLOGY=same-runner
make test:runner-ci:swarm TOPOLOGY=different-runners
```

For a new isolated stack use `ACTION=up`. Do not run these topology probes or
cache probes concurrently: they temporarily control runner scheduling and restore
it afterward. Single-node acceptance checks D3–D10. Each two-node topology checks
Ready/Active nodes, constrained task placement, both directed pairs by service
name in VIP and DNSRR modes, and ingress access through the node with no backend
task. The JSON records Box/runner/Swarm IDs and communication addresses; guest
logs retain network inspect, DNS, HTTP markers, actual VXLAN and IPVS counters.
Readiness checks have deadlines. Successful runs remove their Boxes; failures
retain their disks and diagnostics under `.apps-local/runner-acceptance/`.

Use `make test:runner-ci:swarm-transport` to distinguish guest ingress HTTP
from SDK CONNECT failures on the latest retained scene. Logs can contain Swarm
join credentials; publish only reviewed summaries. See the
[attempt record](../contributing/investigations/2026-10-22-f2-swarm-attempts.md)
for actual results and previously failed hypotheses.
