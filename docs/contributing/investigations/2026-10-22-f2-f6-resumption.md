## TL;DR

Qualify Swarm over an explicit guest IP tunnel and Docker cache reuse on an
ext4 image stored in the existing exclusive runner cache.

## Details

Starting revision: `dcc15340`. F1 now supplies a real guest Docker 27.5.1 daemon.
F2 has used 0/6 rounds; F6 has used 3/6. Both runners are processes on one Mac.
Existing user hook edits and historical failure disks remain untouched.
These are the original design's starting counts; the reopening section below
records the later removal of both limits. Final results are in each feature's
qualification and continuing attempt report.

### Research and decisions

| Observation / source | Decision and reason |
| --- | --- |
| `src/boxlite/src/net/constants.rs` assigns every guest 192.168.127.2; REST rejects host port publication and supplies authenticated TCP tunnels | Reuse `box.network.tunnel().forward()` as transport for a guest-to-guest VPN. Do not advertise the duplicate NAT address to Swarm. |
| [Swarm required protocols](https://docs.docker.com/engine/swarm/swarm-tutorial/#open-protocols-and-ports-between-the-hosts) require 2377/TCP, 7946/TCP+UDP, 4789/UDP | Give guests distinct tunnel IPs; all these protocols must traverse that IP network. Service requests still traverse Docker's user overlay, including real VXLAN and VIP/IPVS. |
| [OpenVPN 2.6 manual](https://openvpn.net/community-docs/community-articles/openvpn-2-6-manual.html), DESCRIPTION and TCP options, supports IP tunnels over TCP/NAT | Use an authenticated guest VPN over the existing TCP transport. The forwarding client must remain alive and be reachable from the peer. This is an explicit deployment constraint; no automatic cross-runner network is advertised. Reject an HTTP service proxy as insufficient. |
| Actual packaged F1 kernel has TUN and LOOP, but disables IPVS/VXLAN | Extend the firmware build with built-in Swarm dependencies. Test operations in the booted guest and preserve artifact checksums. Single-node tests run before both multi-node topologies. |
| Existing `caches.go` owns cache paths and leases; mounts are virtiofs | Reuse its tenant isolation, placement, exclusion from snapshots and exclusive lifetime lease. No scheduler affinity or new volume origin is needed. |
| [Docker overlay2 setup](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/#configure-docker-with-the-overlay2-storage-driver) permits a separately mounted filesystem at the data root | Store a sparse ext4 image inside the cache and mount it in the guest at `/var/lib/docker` before starting Docker. This keeps Linux metadata and overlay backing semantics on ext4, with image bytes on the runner cache disk. Test the loop backing path and actual layer reuse. |
| [Docker data directory](https://docs.docker.com/engine/daemon/#daemon-data-directory) includes daemon state and warns against concurrent writers | Persist an exact Docker/configuration profile; refuse mismatches. Retain whole daemon state, including images/build cache; do not promise cross-version reuse. Pin classic overlay2, containerd snapshotter disabled, managed containerd under the data root. |
| [VFS driver](https://docs.docker.com/engine/storage/drivers/vfs-driver/) copies whole layers | Do not silently switch drivers. Prefer measured ext4/overlay2 reuse; VFS would be a separate explicitly documented configuration and acceptance. |

### Interfaces, ownership and failure handling

Public creation uses the existing privileged guest option, cache volume spec and
network tunnel API. No capability claims automatic Swarm networking or arbitrary
Docker store compatibility. Provide reproducible guest setup and acceptance
targets, and document the exact qualified configuration.

The cache recipe creates its filesystem only when absent, never reformats an
existing image, checks the stored profile before mount, checks ext4 before reuse,
and fails closed on unrepaired corruption. Normal stop waits for dockerd and
containerd before unmounting and detaching the loop. Box deletion releases the
runner lease only after native absence. A crash must not allow a second live
writer; recovery requires deletion of the previous Box and filesystem recovery.
FS snapshots exclude this external image; children receive explicit cache mounts.

Swarm tunnel addresses are scoped to the cluster; runners still schedule normally.
The acceptance fixture temporarily disables scheduling to select the requested
topology and restores it afterward. VPN keys stay in local private fixtures.
No services move into the runner namespace; guest host networking remains guest
host networking. VPN MTU and Docker overlay MTU are explicit; no throughput claim.

### Validation plan

F2: D3–D10 on one guest, then M1–M6 independently on two guests on one runner
and on different runners. Assert Ready/Active nodes, constrained placement,
both directed service-name requests for VIP and DNSRR, and ingress on the node
without the backend task. Keep node mappings, DNS, IPVS, VXLAN, tunnel routes,
service/network inspection and outside HTTP responses.

F6: V4 image ID/content and `--pull=never` survive deletion/recreation; repeat
the identical build and assert cached steps. Prove the loop image resides in the
runner's leased cache. V5 refuses a second Box while dockerd is live; abrupt
daemon/Box failure must preserve exclusivity until deletion and permit checked
recovery. Repeat V1–V3 after changes. Check profile mismatch without altering data.

Every test is a standalone `make test...` command with bounded readiness. Failed
runs retain their guests, cache files, private diagnostics and patches before any
cleanup. Append hypothesis/change/command/exit/result to each feature's attempt
record. Do not spend the other feature's budget or replace real checks with mocks.

### Reopened after round 6

The user removed the attempt limit for F2 and F6. Continue numbering at 7,
preserving all earlier failed scenes and assertions. Starting revision is
`d42037b3`; the two runners remain independent processes on one physical Mac.
The immediate corrections use existing interfaces: enable inbound explicitly
for Swarm's SDK tunnels and use `list_info()` for rejected cache-request cleanup.
Neither change relaxes admission checks or changes runtime storage semantics.
Run Docker cache qualification, single-node Swarm, then both multi-node
topologies sequentially because their scheduling controls share the same API.
Re-run ordinary cache lifecycle checks and investigate the combined path's
runner-local snapshot placement before claiming combined acceptance.
