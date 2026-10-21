# F1 — DinD: historical failure at round 6

This records the original cutoff. The user later removed F1's attempt limit;
[the resumed qualification](2026-10-22-f1-dind-qualification.md) records D1/D2 PASS.
The failure scene below remains historical evidence.

## Result

Six implementation/verification rounds used. D1 failed; D2 was blocked by D1.
All unfinished production changes were removed before this report's commit.
The real acceptance harness and local design remain. No Docker socket was
mounted, no network feature was disabled, and no mock was used for acceptance.

## Versions and reproduction

Base: `d3fb1fce00f0db67d435250cfa5f5550469b0c55`, branch `vibe_features`.
macOS 27.0.1 arm64, Darwin 27.0.0; Rust 1.97.1, Go 1.26.5, Node 26.11.0,
Python 3.14.6. Booted guest: Linux 6.12.87, aarch64,
`#1 SMP Fri May 8 14:25:15 CEST 2026`. Firmware: libkrunfw v5.4.0, prebuilt
arm64 tar SHA256 `1d1b848cee7053c3d26915f30312560343a4e382b5b4e83be1d6755939582de6`.

Input image `docker:27.5.1-dind`; observed client 27.5.1, Buildx 0.20.1,
Compose 2.33.0. Requested driver `overlay2`, data root `/var/lib/docker`.
The daemon never became usable, so no actual driver/cache reuse claim exists.

With the locally retained unfinished patch applied, run each command separately:

```sh
PATH=/opt/homebrew/bin:$PATH make dev:runner-ci
PATH=/opt/homebrew/bin:$PATH make test:runner-ci:infra
PATH=/opt/homebrew/bin:$PATH make test:runner-ci:dind
```

Expected: guest `docker info`, pull, build/run a unique marker image, then
Compose service-name HTTP returning that marker. Actual: daemon readiness
expires after 120 seconds. The entrypoint stops at iptables initialization:

```text
cat: can't open '/proc/net/ip_tables_names': No such file or directory
modprobe: can't change directory to '/lib/modules': No such file or directory
iptables: Failed to initialize nft: Protocol not supported
```

Guest evidence shows `/dev/vda` mounted as writable ext4, writable
`cgroup2 /sys/fs/cgroup`, writable `/sys`, no user mounts, and guest address
`192.168.127.2/24`. Guest logs show the privileged OCI shape (zero readonly
paths). This eliminates parameter dropping and read-only cgroup mounts as
the observed immediate cause; it does not establish all DinD requirements.

## Attempts

Logs below are relative to `.apps-local/feature-acceptance/2026-10-21/`.
Exit codes are from `make`, with inner failures noted where available.

| Round | Symptom / hypothesis | Modification | Validation / result |
| --- | --- | --- | --- |
| 1 | Remote path rejects guest privilege; forward core option | REST capability negotiation, API persistence/warm-pool exclusion, C/Go/runner forwarding | `make test:unit:rust FILTER=privileged`: exit 2, E0609 in old wire tests (`f1-r1-rust.log`) |
| 2 | Capability policy is now optional | Adapt old test field access | Same command: exit 2, E0507 moving a borrowed field (`f1-r2-rust.log`) |
| 3 | Test must borrow optional policy | Use `as_ref`; add isolated real infrastructure | Rust exit 0 (18 core +20 REST filtered executions); API controller exit 0 (39 tests); `make test:runner-ci:infra` exit 2: runner probe used `/health` instead of `/` |
| 4 | Runner is healthy at `/`; request can reach guest | Correct probe; add verify action | `make test:runner-ci:infra ACTION=verify` exit 0; `make test:runner-ci:dind` exit 2: Python constructor lacks privileged (`f1-r4-dind.log`) |
| 5 | Python binding was missing despite initial inventory | Add constructor/property and core conversion | Build exit 0; Python unit exit 0 (2 Python +1 Rust binding test); actual DinD exit 2: nft protocol unsupported (`f1-r5-dind.log`, `f1-r5-guest.log`) |
| 6 | Booted firmware lacks Docker network support | Draft pinned kernel builder/config and macOS firmware source override | `make kernel:dind` exit 2: builder Box was configured but never explicitly started. No kernel compiled or packaged (`f1-r6-kernel-build.log`). Limit reached; stopped. |

Round 5's first filtered Python command selected no tests (exit 2/pytest 5);
after adding the new binding test it was rerun successfully. This was test
setup within that round, not a product defect or new hypothesis. API
forwarding tests also passed (4); they do not count as D1/D2.

## Preserved scene and cleanup

- `f1-r6-unfinished.patch` contains tracked changes, excluding the user's hook
  edit. SHA256: `b5aa62d7043809322c4e7c3923442aa367ca5b9e7e77c5d6dce83235c82a962f`.
- `f1-r6-sources/` contains untracked builder, config, migration and harness;
  `f1-r6-scene/` preserves API/runner/guest logs and private database files.
  These are local only; raw state or credentials must not be published.
- API Box `vS6msEQ9bIJY` → runner `4b8c8467-2a7c-4044-8a19-53c20794443b`
  → runtime Box `tKLUq9jxjyLc`. Runtime home `~/.bl/142b9945/qa`;
  disk/console retained under `boxes/tKLUq9jxjyLc/`.
- Builder `ZFIacy695Ca6` remains configured in `~/.bl/142b9945/qk`.
  It never started; no builder kernel artifact exists.
- Scene was saved before requesting the DinD Box stop (`f1-stop.json`).
  Infrastructure was kept for independent features. Other-worktree services
  on 3001/3003/25432 were untouched.

After an explicitly authorized new attempt budget: start the builder, validate
its prerequisites (including bin2cbundle's Python ELF dependency), compile
the built-in network features, package the result into the actual runtime,
and verify the kernel in a fresh guest. Re-run D1/D2 without relaxing their
network/storage assertions. No extra F1 attempts are requested in this task;
dependent F2/F6 acceptance must retain the F1 failure.
