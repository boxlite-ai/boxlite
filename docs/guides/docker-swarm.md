# Docker Swarm across Boxes

Each Swarm node runs Docker inside a privileged Box. Use the Linux x86_64
[v5.4.0 DinD kernel](https://github.com/boxlite-ai/libkrunfw/releases/tag/v5.4.0),
which includes IPVS, VXLAN and the netfilter features required by Docker 27.5.1.
Follow the [DinD guide](docker-in-docker.md) for guest creation and firmware.
Apple Silicon single-node Swarm uses the ARM kernel built through the same
guide's [Apple Silicon workflow](docker-in-docker.md#apple-silicon-firmware).

## Give nodes distinct reachable addresses

Each Box has its own NAT network, so multiple Boxes can share the guest address
`192.168.127.2`. Swarm needs distinct reachable addresses for
`--advertise-addr` and `--data-path-addr`. Its control and data paths require
2377/TCP, 7946/TCP+UDP and 4789/UDP between nodes.

The [acceptance example](../../tests/docker/swarm.py) creates an authenticated
OpenVPN TUN link between guests, with addresses `10.77.0.1` and `10.77.0.2`.
It carries this IP link through BoxLite's TCP tunnel API to guest port 1194.
Swarm control traffic and VXLAN use the TUN link; service requests use Docker
service names and their overlay network.

```text
host A: BoxLite TCP forwarder ◄──────── guest B: OpenVPN TCP client
             │                                  │
       guest A: OpenVPN                    TUN 10.77.0.2
       TUN 10.77.0.1                             │
             └──── Swarm / VXLAN / services ─────┘
```

For two Boxes on one host, guest B reaches the forwarder through the host alias
`192.168.127.254`. Across hosts, `--peer-address` supplies host A's LAN address.
The forwarder must remain alive and reachable from guest B. This example
provisions two nodes; larger deployments need their own routed guest network.

## Docker networking

Use the official `dockerd-entrypoint.sh`, overlay2 and `--dns-search=.`.
The qualification image also needs iproute2, ipvsadm, OpenVPN and complete
iptables extensions. The harness restores both `libxt_MARK.so` and
`libxt_mark.so` using Alpine's package manager. The published kernel uses
iptables-nft; keep Docker's firewall and bridge networking enabled.

The TUN MTU is 1400, and user overlays and ingress use MTU 1200 to allow
encapsulation. Configure ingress before creating published services and wait
for a removed ingress network to disappear before recreating it.

| Docker mode | Behavior checked |
| --- | --- |
| Default VIP | Service DNS resolves its VIP; IPVS routes HTTP to the backend |
| DNSRR | Service DNS resolves task addresses; clients still request the service name |
| Ingress publish | A node without a backend task routes an external request to another node |
| Host publish | External traffic reaches the node running the published task |
| Host network | The container shares the guest network namespace |

DNSRR is tested separately from ingress publication. Docker host networking
refers to the guest, while external requests originate on its physical host
and enter through BoxLite's TCP exposure path.

## Acceptance

Build the same SDK and runtime on both hosts, then run each topology separately:

```sh
make test:docker:swarm DOCKER_ACCEPTANCE_ARGS='--runner-a user@host-a --root /path/to/boxlite --output /path/to/evidence --topology single'
make test:docker:swarm DOCKER_ACCEPTANCE_ARGS='--runner-a user@host-a --root /path/to/boxlite --output /path/to/evidence --topology same-runner'
make test:docker:swarm DOCKER_ACCEPTANCE_ARGS='--runner-a user@host-a --runner-b user@host-b --peer-address host-a-address --root /path/to/boxlite --output /path/to/evidence --topology cross-runner'
```

On Apple Silicon, build the native SDK with the ARM DinD firmware and run the
single-node checks locally:

```sh
make test:docker:swarm DOCKER_ACCEPTANCE_ARGS="--runner-a local --root '$PWD' --state-root '/path/to/acceptance state' --output '/path/to/evidence' --topology single"
```

The single-node run checks D3–D10. Each two-node run checks Ready/Active nodes,
placement constraints, both directed cross-node pairs in VIP and DNSRR modes,
and ingress through the node without a backend task. Each backend has a unique
marker; HTTP status and body must both match. Node IDs, runtime/host identities,
overlay configuration, DNS and actual IPVS/VXLAN operations are logged.

The same-runner run uses one native SDK runtime for both Boxes. The cross-runner
run requires distinct runtimes on distinct physical hosts. See
[evidence and cleanup](../../tests/docker/README.md#evidence-and-cleanup) for
commands, retained scenes and log locations.

## Limitations

The example explicitly supplies a guest IP network; BoxLite does not
automatically create a cross-host mesh. The tests qualify correctness rather
than throughput, and do not deploy a cloud control plane. Runner creation is
covered separately by its real Docker integration test.
Apple Silicon acceptance covers single-node Swarm; the same-runner and
cross-runner two-node topologies are qualified on Linux x86_64.
