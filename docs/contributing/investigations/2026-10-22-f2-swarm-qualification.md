## TL;DR

F2 passes D3–D10 and both two-node topology suites using actual guest Docker Engines.

## Details

Round 9 builds on `d42037b3` with the recorded fixture changes; see the
[design](2026-10-22-f2-f6-resumption.md), [attempts](2026-10-22-f2-swarm-attempts.md)
and [deployment guide](../../guides/docker-swarm.md). No mock participates.
Both runners are independent processes with separate runtime homes on one
macOS 27.0.1 arm64 physical host, as requested. Different physical hosts have
not been qualified.

The runtime boots Linux 6.12.87-boxlite-dind with builtin IPVS and VXLAN.
The actual firmware Image SHA256 is
`f4edee8b4803f4d3800583d7ec3e5b713200874dc78776955a30f838d1e10bf7`;
kernel.c SHA256 is
`69d74bf9b791312a7fb896c0bb5974e6537c6c53ed5d4536b7d18509ee6cbf02`.
Generated inputs remain at `.apps-local/runner-acceptance/firmware/`.
Docker 27.5.1, Compose 2.33.0, Buildx 0.20.1, containerd v1.7.25,
classic overlay2 on guest ext4 at `/var/lib/docker`; OpenVPN 2.6.20-r0,
iproute2 6.11.0-r0 and ipvsadm 1.31-r3. Both image digests are constants in
the committed harness; package versions and actual kernel are logged per guest.

### Acceptance and evidence

Logs below are under `.apps-local/feature-acceptance/2026-10-22-f2-f6/`.
JSON records and full guest logs are under `.apps-local/runner-acceptance/`.

| Scope | Status | Command and record |
| --- | --- | --- |
| D3–D10, single | PASS | `make test:runner-ci:swarm TOPOLOGY=single`; `f2-r9-single.log`; `swarm-single-7d7e0f67` |
| M1–M4/M6, same runner | PASS | `make test:runner-ci:swarm TOPOLOGY=same-runner`; `f2-r9-same-runner.log`; `swarm-same-runner-2dfed9e3` |
| M1–M4/M6, different runners | PASS | `make test:runner-ci:swarm TOPOLOGY=different-runners`; `f2-r9-different-runners.log`; `swarm-different-runners-d2c55971` |
| M5 | PASS | Both complete topology runs above, separate records |
| Combined E | PASS in later F5/F6 work | [Migration-backed snapshot copy and cached Engines](2026-10-22-combined-snapshot-swarm-cache.md) remove the former owner-placement block |

Every service has one running task constrained by actual Swarm node ID. VIP and
DNSRR each check both directed cross-node pairs by service name, HTTP 200 and
the target node's unique marker. VIP mode is Docker's default; DNS must match
the inspected VIP, and real IPVS counters must be nonzero. DNSRR is tested
separately and must resolve the actual task address. Active network namespaces
show VXLAN with UDP destination 4789; config files or `lsmod` are insufficient.

Ingress is the default publish mode and the backend is constrained to node B.
The external SDK tunnel reaches node A, which has no backend task, and returns
B's marker. Host publish and guest host networking are independent checks.
The existing BoxLite port proxy carries external ingress tests and the VPN's
TCP transport; internal service HTTP still crosses the Docker user overlay.
The guest VPN provides manager TCP 2377 and node TCP/UDP 7946 plus UDP 4789.
It requires a live forwarding client; no automatic network capability is claimed.

| Topology / node | Box | Runner | Swarm node | Address |
| --- | --- | --- | --- | --- |
| Same / A | `unmJfvSZ807l` | `4b8c8467-2a7c-4044-8a19-53c20794443b` | `it4zmtog1hpxgxuifbjwwhxvu` | `10.77.0.1` |
| Same / B | `RyIH1xsxVakw` | same runner | `y8ziavf4wph9sbw5bt6gcyy91` | `10.77.0.2` |
| Different / A | `hQd5OAPQQrpq` | `4b8c8467-2a7c-4044-8a19-53c20794443b` | `j4q3vzfdmbw9vxe4blsfs3giw` | `10.77.0.1` |
| Different / B | `XY42uoBKRg42` | `17dcb9ae-cffc-4403-8eca-cbfe595a8248` | `oatl8wk33hhurh69xvm7folym` | `10.77.0.2` |

### Failed hypotheses and reproducibility

Rounds 1–6 remain in the [historical report](2026-10-22-f2-swarm-incomplete.md).
Round 7 adds explicit inbound enablement but discovers the inherited proxy URI
points at another local stack. Round 8 starts an isolated proxy, then discovers
its dotenv loader overwrites the supplied key. Round 9 starts the proxy in an
isolated cwd; no guest routing or traffic assertion is weakened.
`f2-r7-scene/` and `f2-r8-scene/` retain exact scripts, JSON and guest logs;
failed guests were stopped after capture, with disks preserved. Earlier failure
disks and logs remain. Successful guests are deleted after their evidence is saved.

Build with `make kernel:dind`, then
`BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware" make dev:runner-ci`.
Run `make test:runner-ci:infra ACTION=restart` (or `ACTION=up` for a new stack),
then each command in the table separately. Infrastructure includes isolated
API 13001, proxy 14000 and runners 13003/13004. No remote publication occurs.
Private logs may include join tokens; this committed report omits them.
