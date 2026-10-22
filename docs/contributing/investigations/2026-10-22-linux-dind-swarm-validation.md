# Linux x86_64 DinD and Swarm validation

## Scope and design

Validate commits `017b5c88` and `72b99497` at `121d1837` on Linux/KVM,
using the published DinD firmware, real guest Engines, and the existing
SDK/API/runner acceptance commands. Historical macOS results are not Linux
evidence. Preserve downloaded dependencies while removing previous build outputs,
guest disks, and owned processes before rebuilding.

### Research before implementation

- `src/deps/libkrun-sys/build.rs`: `BOXLITE_LIBKRUNFW_SOURCE` is consumed only
  by the macOS build. Linux downloads the ordinary firmware unconditionally
  unless it rebuilds the vendored kernel. Thus the documented override cannot
  select the requested DinD firmware on Linux.
- [libkrunfw v5.4.0](https://github.com/boxlite-ai/libkrunfw/releases/tag/v5.4.0)
  supplies `libkrunfw-kernel-dind-x86_64.bin`, an ELF kernel, SHA256
  `d6686ee95c855e42fe0a1fd89442d3a6cefbc0c762b981a3b45aefd5b788fc75`.
  The release workflow copies `vmlinux`; it is not a shared library.
  Its DinD config patch enables bridge, netfilter and nftables, but does not
  explicitly enable IPVS or VXLAN. Actual device/service creation below confirms
  both features are unavailable in that binary.
- The vendored `bin2cbundle.py` preserves ELF load/entry addresses and emits
  the firmware ABI. Reusing it can package the release kernel through the
  existing runtime without forwarding host-local kernel paths through REST.
- [Docker's Swarm prerequisites](https://docs.docker.com/engine/swarm/swarm-tutorial/#open-protocols-and-ports-between-the-hosts)
  require 2377/TCP, 7946/TCP+UDP, and 4789/UDP. The existing guest OpenVPN
  fixture transports those IP protocols over a BoxLite tunnel; service HTTP
  must still traverse Docker overlay and service DNS/VIP.
- `compose.swarm_acceptance` already asserts task placement, both directions,
  endpoint mode, DNS, IPVS counters, VXLAN, and external ingress. Its two-runner
  topology uses two processes on one physical host. This cannot demonstrate
  different-host deployment.

### Approach

First verify host KVM and clean only identified project resources. Rebuild from
this checkout. Extend the existing explicit firmware override to Linux if
needed, preserving its default behavior and packaging the checksum-verified
release binary through the normal runtime. Use the existing acceptance harness
and fix only observed failures. Do not substitute host Docker, disable Docker
networking, or replace overlay requests with published ports.

### Validation plan

Record firmware hashes, loaded runtime paths and guest kernel identity. Run D1–D2,
then D3–D10, then both M1–M6 topologies sequentially. Every result needs an actual
assertion and retained log. For fixes, run the regression with all production
changes reverted, then restored. Mark unavailable topology or kernel features
as blocked/failed, never as a pass based on configuration or historical reports.

## What the requested commits implement

`017b5c88` adds guest privilege throughout the SDK/API/runner path, advertises and
rechecks the API capability, persists the option and avoids privileged warm-pool
reuse. It grants the guest capabilities needed by dockerd while keeping the
runner-side sandbox. It also introduces the DinD firmware workflow and D1/D2
behavioral checks. The original firmware-source override was macOS-only.

`72b99497` adds Swarm kernel configuration, the D3–D10/M1–M6 acceptance harness
and deployment documentation. The harness establishes a guest OpenVPN IP link
over a BoxLite TCP tunnel, then tests genuine Docker overlay/VIP/DNSRR and
ingress. It does not implement automatic cross-runner mesh networking. Earlier
results used Apple Silicon; neither those results nor the config file qualified
the Linux x86_64 kernel or image pin.

## Environment and cleanup

The host is Linux x86_64 with KVM, four logical CPUs and approximately 8 GiB RAM.
The checkout started at `121d1837`. Five identified previous project VMs were
stopped, old build/runtime artifacts and Box data removed, and approximately
51 GiB reclaimed. Downloaded dependency archives and language package caches
were preserved. Unrelated host Docker workloads were untouched.

Private evidence is under `.apps-local/linux-acceptance/`, with scenario JSON
and guest logs under `.apps-local/runner-acceptance/`. `cleanup.json` records
the initial cleanup. These are local artifacts, not material approved for
publication; raw API/Swarm logs can contain credentials.

## Kernel evidence

| Artifact | Identity / outcome |
| --- | --- |
| Published DinD ELF | `6.12.87`, SHA256 `d6686ee95c855e42fe0a1fd89442d3a6cefbc0c762b981a3b45aefd5b788fc75` |
| Published ELF packaging | `firmware-provenance.json`: all ELF load segments and entry/load addresses match the packaged firmware blob |
| Published D10 | VXLAN creation: `Unknown device type`; IPVS service creation: `Protocol not available` |
| Local Swarm derivative | `6.12.87-boxlite-dind-swarm`, ELF SHA256 `31f5fcd1b335899a84a4452c159c11709c99ecff1f2642dbc6119849806e6225` |
| Derivative firmware library | SHA256 `bb2e40d5874330ea8619c3d53196bab506fe8533d75b08c8163cb2498c87c488` |
| Derivative D10 | Actual VXLAN device add/show/delete and IPVS TCP virtual service add/list/delete all succeed |

`kernel-release-probe/verified-tools/` and `kernel-swarm-probe/verified-tools/`
contain commands, exit codes and runtime results; `D10-comparison.json` contains
the combined assertions. No conclusion here depends on `lsmod`.

The derivative uses Linux 6.12.87, vendored libkrunfw revision `e0647fa7`, the
checksum-pinned public DinD recipe at `7e20dfa0`, and this branch's
`scripts/build/dind-kernel.config`. Its generated, embedded and runtime configs
are checked, and it is packaged through `BOXLITE_LIBKRUNFW_SOURCE` and the normal
runtime build. This is not an exact rebuild of the published release binary:
complete build provenance for that release was unavailable. The original
release binary is preserved separately.

## Observed issues and changes

| Issue | Action and decisive evidence |
| --- | --- |
| Linux ignored `BOXLITE_LIBKRUNFW_SOURCE` | Honor the existing explicit override and invalidate the ordinary firmware marker. The real build-script regression returns `default` before the fix and `dind` afterward; `firmware-red.log`, `firmware-green.log`. |
| Swarm/cache image pinned to ARM64 manifest | Pin the multi-architecture Docker 27.5.1 index. Registry-backed tests import both production constants: `image-pin-red.log`, `image-pin-green.log`. |
| Published DinD kernel lacks Swarm features | Add `make kernel:swarm`, preserving pinned inputs, effective config and packaged hashes. Actual D10 changes from failure to success. |
| D1 required absent `/proc/config.gz` | Make config capture optional; keep guest daemon, socket isolation, pull/build/run and network assertions. `dind-config-red.log`. |
| Cold create outlives API's 30-second wait | Recover the accepted Box by unique name and verify its ID under a total deadline, without repeating POST. Full-baseline regression: `provision-red.log`; green: `provision-green.log`. |
| Guest external downloads timed out | An explicit optional download-proxy setting reuses the machine's reachable egress. Service clients assert no proxy variables; internal communication stays on Docker networks. `dind-egress.log`, `dind-proxy-probe.log`. |
| Auxiliary Redis shared-directory chown returned EINVAL | Keep isolated Redis/PostgreSQL fixture data in guest writable disks. This changes only the acceptance fixtures, not the general volume contract. |
| Force removal left live VM processes | Login-session processes could not migrate into the Box cgroup (EACCES), but the error was ignored. Run this host's stack in a delegated user scope; retain the runtime's silent migration/removal behavior as an unresolved defect. `orphan-vm/` has process and migration evidence. |

## Behavioral results

The unchanged published DinD kernel passes D1/D2 after the Linux harness fixes:
`dind-release-proxy.log` and `dind-release-guest.log` record real pull, build,
unique content execution and Compose HTTP. It also passes a separately asserted
Swarm init/Ready/Active check (`swarm-release-init.log`). Its Swarm acceptance
stops at actual VXLAN creation (`swarm-release.log`), so overlay/VIP/ingress
are not claimed to pass on that kernel.

The packaged Swarm derivative passes the following real runs:

| Requirement | Result | Command / evidence |
| --- | --- | --- |
| D1–D2 | PASS | `make test:runner-ci:dind`; `dind-final.log`, `dind-final-only-guest.log` |
| D3–D10 | PASS | `make test:runner-ci:swarm TOPOLOGY=single`; `swarm-single-5b550516.json` and `-guest.log` |
| M1–M4, M6: same runner | PASS | `TOPOLOGY=same-runner`; `swarm-same-runner-77c16e86.json` and `-guest.log` |
| M1–M4, M6: distinct runners | PASS | `TOPOLOGY=different-runners`; `swarm-different-runners-8ddd0d81.json` and `-guest.log` |
| M5 | PASS within the local two-runner topology | Two different runner IDs, processes and runtime homes on **one physical Linux host**; different physical hosts were not tested |

Every Swarm record maps Box IDs, runner IDs, Swarm node IDs and communication
addresses. Both two-node runs use `10.77.0.1` and `10.77.0.2`; each has four
successful directed requests: A→B and B→A in each of VIP and DNSRR modes.
Placement constraints and observed task NodeIDs agree. Cross-node ingress is
published in `ingress` mode; its only backend task is on B, while the external
SDK tunnel targets A. Internal HTTP requests use service names and no published
ports. The logs retain HTTP 200 and target-specific markers, DNS, endpoint
configuration, VXLAN devices, IPVS packet/connection counters and socket/firewall
diagnostics. D9 additionally compares the container and guest network namespace.

`dind-final-runtime.json`, `swarm-same-runner-runtime.json` and
`swarm-different-runners-runtime.json` show actual VM library mappings, matching
firmware hashes and Box cgroup membership. The final D1 run also exercises real
cold-create recovery on the second runner. `verification-summary.json` checks
the completed records, distinct nodes/runners, directed pairs and runtime
artifacts; `verify-results.py` reruns those evidence assertions.

### Reproduction and checks

Run sequentially with `BOXLITE_LOCAL_STATE_ROOT` set to a short writable path
(this run used a directory under `/tmp`) and, where required,
`BOXLITE_ACCEPTANCE_DOWNLOAD_PROXY` set to the site's reachable download proxy.
Keep the explicit firmware source set during native builds:

```sh
make kernel:dind
export BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware"
make dev:runner-ci
systemd-run --user --scope --quiet make test:runner-ci:infra
make test:runner-ci:dind

make kernel:swarm
export BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware-swarm"
make dev:runner-ci
systemd-run --user --scope --quiet make test:runner-ci:infra ACTION=restart
make test:runner-ci:dind
make test:runner-ci:swarm TOPOLOGY=single
make test:runner-ci:swarm TOPOLOGY=same-runner
make test:runner-ci:swarm TOPOLOGY=different-runners
```

This run's derivative output was relocated to
`.apps-local/linux-acceptance/firmware-swarm` using the documented output setting.
The Python build used `env -u CONDA_PREFIX` because Maturin rejects simultaneous
Conda and project-venv activation. Native builds used two jobs with debug symbols
and incremental compilation disabled to fit the host.

`make test:unit:scripts` passes 14 tests. `make fmt:check:rust`,
`make fmt:runner-ci`, `make lint:runner-ci`, the actual native/SDK build and
`git diff --check` pass. Firmware and provisioning regressions were first run
against the complete pre-change production baseline. The same real detached
Box removal probe fails in the login session and passes in the delegated scope;
both logs and the probe are under `orphan-vm/`.

### Limits and remaining defects

- The released DinD x86_64 kernel does **not** satisfy Swarm D10. The successful
  Swarm runs require the built and packaged local derivative.
- Two runner processes on one physical host do not qualify different physical
  hosts. That deployment needs a reachable peer forwarding endpoint and another
  full M1–M4/M6 run; no remote-host result is claimed here.
- Guest IP connectivity is explicitly provided by the two-node OpenVPN fixture.
  The branch does not automatically provision a general runner mesh.
- The runtime still ignores a failed rootless cgroup migration and can report
  successful removal while leaving detached VMs. Delegated launch fixes the
  tested environment, not that product defect. Auxiliary shared-volume chown
  EINVAL also remains outside the DinD guest-disk configuration tested here.

Successful scenarios removed their test Boxes. The final cleanup stops the
isolated API/runners/proxy and removes the auxiliary PostgreSQL/Redis Boxes,
with process/port checks in `final-cleanup.json` and `final-cleanup.log`.
New build artifacts, evidence and downloaded dependencies are retained for
inspection and reuse.
