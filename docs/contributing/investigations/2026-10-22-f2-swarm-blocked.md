## TL;DR

This is the historical pre-resumption report; the [current six-round result](2026-10-22-f2-swarm-incomplete.md) is incomplete, with single-node passes.

## Details

### Historical blocking dependency


F1 exhausted its six rounds without a usable guest Docker daemon. Its failure
report is committed in `43ba6f6a`; no unfinished F1 production code remains.
Swarm requires a Docker Engine in every participating sandbox. Restoring that
unfinished path or repairing its kernel under F2 would reset F1's attempt
budget, so F2 stops before implementation. F2 has used **0 of 6 rounds**.

The user approved two independent local runner processes on the same physical
Mac. Only the first isolated runner was started during F1. No second-runner
or multi-sandbox cluster was created, and no topology has passed.

## Evidence and reproduction

See [F1's report](2026-10-21-f1-dind-incomplete.md) for versions, the unfinished
patch, commands, exit codes and exact private scene paths. Specifically:

- Base `d3fb1fce`, F1 draft patch SHA256
  `b5aa62d7043809322c4e7c3923442aa367ca5b9e7e77c5d6dce83235c82a962f`.
- macOS 27.0.1 arm64; actual guest Linux 6.12.87.
- `make test:runner-ci:dind` exited 2, with guest nft protocol unsupported.
- `.apps-local/feature-acceptance/2026-10-21/f1-r5-guest.log` captures writable
  cgroups, the guest mount table and `192.168.127.2/24` guest identity.
- Runtime disk/console remain in `~/.bl/142b9945/qa/boxes/tKLUq9jxjyLc/`.

Source inspection found that the arm64 vendor configuration disables VXLAN
and netfilter, but macOS actually boots a downloaded v5.4.0 firmware artifact.
That config is not runtime IPVS/VXLAN evidence. No claim is made that editing
it would fix the booted guest. The runner's current tunnel endpoint transports
TCP streams; multi-node communication needs separately verified node addresses
and TCP/UDP reachability. HTTP publication is not an overlay substitute.

## Acceptance

| ID | Status | Evidence / remaining requirement |
| --- | --- | --- |
| D3 | BLOCKED | No usable guest Engine; init/Ready/Active untested |
| D4 | BLOCKED | Overlay service replicas and traffic untested |
| D5 | BLOCKED | Default VIP, DNS, HTTP and IPVS untested |
| D6 | BLOCKED | Independent DNSRR DNS/HTTP untested |
| D7 | BLOCKED | Default ingress through BoxLite exposure untested |
| D8 | BLOCKED | Host publish independently untested |
| D9 | BLOCKED | Guest host network independently untested |
| D10 | BLOCKED | Actual booted IPVS/VXLAN operations untested |
| M1 same runner | BLOCKED | No two-node cluster or node mapping |
| M2 same runner | BLOCKED | No constrained placement/directed HTTP pairs |
| M3 same runner | BLOCKED | VIP and DNSRR pairs untested |
| M4 same runner | BLOCKED | Ingress via node without backend task untested |
| M1 different runners | BLOCKED | Second local runner not started |
| M2 different runners | BLOCKED | Directed pairs untested |
| M3 different runners | BLOCKED | VIP and DNSRR pairs untested |
| M4 different runners | BLOCKED | Cross-node ingress untested |
| M5 | BLOCKED | Neither required topology passed |
| M6 | BLOCKED | No cluster/task/overlay evidence exists |

No additional Swarm resources or production patch were created. Next step
requires resolving F1 under a newly authorized budget, then building and
packaging the actual kernel, provisioning real node transport, and executing
both topologies independently. This report does not request that authorization.
