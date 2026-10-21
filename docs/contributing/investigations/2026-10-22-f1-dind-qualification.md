## TL;DR

F1 passed real D1/D2 through Python SDK → API → Runner → BoxLite → guest after
building and packaging Docker-capable firmware.

## Result and environment

Resumed on user authorization without the six-round cap; numbering continues at
7. Working base was `0f848848` on `vibe_features`. No push, PR, issue or
commit-push-auditor execution. The user's hook edit and target symlink are kept.

| Item | Observed value |
| --- | --- |
| Host | macOS 27.0.1, Apple Silicon arm64, 16 GiB RAM |
| Guest kernel | `6.12.87-boxlite-dind`, aarch64; libkrunfw ABI 5 |
| Docker / Compose / Buildx | 27.5.1 / 2.33.0 / 0.20.1 |
| Docker image | `docker:27.5.1-dind`, resolved manifest `sha256:ad9e28ccfdf76cf44248258090e07d8353b9628725d8a716bab176bd71200d7d` |
| Pulled test image | `busybox:1.37.0`, digest `sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` |
| Storage | classic overlay2, extfs backing (`/dev/vda`, ext4), `/var/lib/docker` |
| Cgroups / containerd | cgroupfs v2; managed containerd 1.7.25 under Docker data root |
| Actual placement | API Box `tRgmzOGW6Lw4`, runner `4b8c8467-2a7c-4044-8a19-53c20794443b` |
| Kernel Image SHA256 | `43da1a67150a70e7810454e4d79181a3a20276c5f8143e9ae709781d2150f6f9` |

Two independent local runners were running on this Mac; D1/D2 were scheduled on
runner A. This is not multi-node Swarm or Docker cache qualification.

## Real acceptance

Logs below are under `.apps-local/feature-acceptance/2026-10-22-f1-resumed/`.

| ID | Result | Evidence |
| --- | --- | --- |
| D1 | PASS | `r10-dind.log`, `r10-dind-commands.log`: guest dockerd PID and local socket; info, pull, BuildKit build including RUN, then `docker run --pull=never` returns unique marker |
| D2 | PASS | Same logs: two Compose services on their bridge network; client requests `http://backend:8080/`, HTTP 200 and exact marker |
| Firmware used | PASS | `r10-guest.log`: booted kernel suffix and working iptables nft backend; generated config and daemon network rules retained in command log |
| Cleanup | PASS | Compose down, dockerd termination observed, Box removed; acceptance command exits 0 |
| FS regression | PASS | `r10-regression-fs.log`: capture, error recovery, runner restart, metadata, restore and deletion through runner B |

The marker was `dind-cec4b23f6f9746c1b0759dc12ea56916`. No runner socket was
mounted; no bridge, DNS, NAT or firewall functionality was disabled. The driver
and Docker root were asserted, not inferred from a mount. Host sandbox defaults
remain independent of guest privilege and are covered by native conversion tests.

## Attempts and regressions

| Round | Hypothesis/change | Command and result |
| --- | --- | --- |
| 7 | Explicitly start retained builder; install pyelftools | `make kernel:dind`, exit 2: obsolete NFT_COUNTER symbol |
| 8 | Counter is built into NF_TABLES; try NAT chain selection | Same target, exit 2: NFT_CHAIN_NAT is also obsolete; inspect upstream Kconfig and Makefile together |
| 9 | NF_TABLES/NFT_NAT include those objects; verify all symbols | Same target, exit 2: compilation reaches IKHEADERS, missing cpio |
| 10 | Install cpio, keep all requested kernel functionality | Kernel and SDK/runner builds exit 0; D1/D2 and targeted regressions pass |

Before/after tests use an isolated checkout of `0f848848` with only test changes.
`baseline-python-native.log` reproduces missing privileged constructor/property;
`baseline-api-adapter-complete.log` reproduces request rejection, mapper field
loss and warm-pool eligibility; `baseline-node.log` reproduces dropped privilege.
All exit 2 from make. The API adapter only casts old DTO types in tests; assertions
are unchanged. `baseline-test-only.patch` preserves it. Initial missing-native
and TypeScript compilation failures are retained but are not defect evidence.

Passing checks: Rust privileged tests (`r9-rust.log`), Python binding/conversion
(`r10-python.log`), API validation/mapper/warm pool (`r10-api.log`, 36 tests), Go
privilege setter (`r10-go.log`), complete Node unit suite (`r10-node-full.log`),
CLI unit suite (`r10-cli.log`, 275 tests), reference capability adapter
(`r10-reference.log`). Full Rust unit/REST checks also pass (`r10-rust-full.log`);
the apps workspace build succeeds (`build-apps.log`). Python lint and Rust
format checks pass; formatting receipts are `format-*.log`. Unrelated baseline
formatting changes were reverted.

## Reproduce and retained artifacts

See [the DinD guide](../../guides/docker-in-docker.md) for build and usage. Run
each test command separately:

```sh
make kernel:dind
export BOXLITE_LIBKRUNFW_SOURCE="$PWD/.apps-local/runner-acceptance/firmware"
make dev:runner-ci
make test:runner-ci:infra ACTION=restart
make test:runner-ci:dind
```

Use `ACTION=up` for a fresh isolated stack. On failure, run
`make test:runner-ci:dind-diagnose` before removing the retained Box. The generated
firmware, full config and checksums remain at
`.apps-local/runner-acceptance/firmware/`. Kernel builder failures used
`~/.bl/142b9945/qk`; the successful build removed the builder after saving output.
Earlier six-round failures and their patch remain in the
[historical report](2026-10-21-f1-dind-incomplete.md).

Linux-host builds, Swarm (D3–D10/M1–M6), Docker cache reuse (V4/V5) and combined E
are not qualified by this F1 run. No RAM snapshot or performance claim is made.
