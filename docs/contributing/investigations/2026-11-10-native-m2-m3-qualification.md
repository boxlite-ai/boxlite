**Status:** Implemented; qualification failures remain.

# Linux x86_64 native M2/M3 qualification

## TL;DR

Native device wiring and all four matrix runs are complete; native M3 passes, while M2 and libkrun M3 retain failures.

## Scope and inputs

The integration stacks on [guest bootstrap #2399](https://github.com/boxlite-ai/boxlite/pull/2399), rebased onto main `8f0af03e`.
The tested worktree starts at parent `57a114f37934682fa7d1b12595a47c03e6a9e29b` and includes the integration patch and new test inputs.
The [design](https://github.com/boxlite-ai/boxlite/issues/2515) preserves libkrun as the default engine and limits qualification to Linux x86_64.

All four complete runs used the same copied runtime and native kernel, four test workers, zero retries, required network egress and normally ignored tests enabled.
Their tracked source patches and test-input manifests are identical; subsequent temporary diagnostics were removed without changing the qualified implementation.
Final review corrected architecture descriptions and moved the unchanged socket binding tests into the existing VMM test directory; production behavior remained unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Native kernel, Linux 6.12.110 | `92d53ed5215ad803b221acdba2dac90700fb271968b8318011d417356c6aaa5b` |
| Shim | `f98cf42ef857a5c6639d393d8d493bcfb0c6c6db99b7a45cc3a99069e4b92e9d` |
| Guest agent | `e7e725d2313ca27aa4174672dc2547c0748739fde76b5fd00ebe27041aa015e9` |
| Tracked qualification patch | `e82a056f1d3a7ae6cf2515357ad8e99c6f2b7d368a3407443bebace7765272f4` |

The runner retains the selected-test JSON, complete runtime hashes, source patch, untracked test inputs, output and exit status for each run.
Logs remain local artifacts; this report summarizes results without publishing host paths or raw process records.

## Matrix results

| Suite | Engine | Passed | Failed | Selected | Runner skipped |
| --- | --- | ---: | ---: | ---: | ---: |
| M2 | native | 168 | 3 | 171 | 0 |
| M2 | krun | 169 | 2 | 171 | 0 |
| M3 | native | 40 | 0 | 40 | 0 |
| M3 | krun | 37 | 3 | 40 | 0 |

M2 includes the 14 milestone suites plus `network_spec`, `copy_ownership` and `execution_shutdown`.
M3 includes its five milestone suites plus `volume_matrix`.
The exact selections live in [make/test.mk](../../../make/test.mk), and [the usage guide](../../guides/native-vmm.md#linux-x86_64-m2-and-m3-matrices) gives reproducible commands.

| Directory volumes | Native | krun |
| ---: | --- | --- |
| 2 | Pass | Pass |
| 3 | Pass | VM startup fails |
| 8 | Pass | VM startup fails |
| 32 | Pass | VM startup fails |

Each directory case reads distinct host-created content inside the guest, writes back to every original host directory, and asserts stop and removal.
The mixed read-only/writable export security test also passes on both engines.

## Failures and interpretation

**Detached cleanup.** `detached_box_force_remove_reaps_whole_tree` and `detached_box_stop_reaps_whole_tree_and_keeps_box` each observe two remaining processes on both engines.
The assertions are unchanged, and cleanup after each completed run targets only its new runtime-owned process trees.
This cleanup does not turn either failed test into a pass.

**Non-root nginx.** Native M2 fails `test_non_root_image_user_exec_uid_and_inode_ownership` when container init exits before exec; the initial error is ENOENT.
Temporary diagnostics on both engines show UID 101, a root-owned stderr pipe with mode 0600, and nginx failing to open `/var/log/nginx/error.log`, which links through `/dev/stderr`, with EACCES.
Both diagnosed main processes exit with code 1.

The krun full-run pass therefore does not establish a healthy long-running nginx entrypoint: its assertions can finish before that exit.
The pipe setup is shared guest code in `ContainerStdio::pipes`, and the diagnostic wrapper changes timing, so these focused runs are separate evidence rather than replacements for the matrix results.
Repairing this shared stdio ownership behavior is a follow-up, outside device wiring.

**krun volume counts.** The 3, 8 and 32 directory cases fail VM startup, while two directories pass.
This resembles the boundary tracked by [#935](https://github.com/boxlite-ai/boxlite/issues/935); the generic startup error and empty console do not prove its IRQ-exhaustion cause.
No assertion or volume count is relaxed.

**KVM host gate.** The standalone hardware target has 7/8 hypervisor tests and 8/8 VMM tests pass.
`kick_before_entry_preserves_registers_and_dropped_handles_are_inert` returns KVM_RUN ENOSPC, matching the Linux 6.6 host limitation tracked by [#1831](https://github.com/boxlite-ai/boxlite/issues/1831).
It remains a failed hardware gate; the errno is not evidence that host storage is full.

## Additional checks

| Command or focused check | Observed result |
| --- | --- |
| `make test:unit:vmm` | Hypervisor 16 passed, 8 ignored; VMM 463 passed, 27 ignored |
| `make test:unit:rust FILTER=vmm::native::tests` | 10 adapter tests passed; hardware cases excluded |
| `make test:unit:guest` | 418 passed, 6 skipped; nextest marked 1 passed case as leaky |
| Seccomp regression with every production file at the unchanged parent | Child killed by SIGSYS 31 |
| Same seccomp regression with complete integration restored | Passed in native and REST unit builds |
| `make test:integration:vmm:native SETUP_DONE=1` | 6 shim/bootstrap boots and 1 ready/exec/stop/remove Box passed |
| `make test:integration:vmm:elf` | 1 passed |
| `make test:integration:vmm:linux` | 17 passed |
| `make test:integration:vmm:mounts` | 1 aggregate guest-mount acceptance passed |
| `make test:vmm:boot` | 9 script contract tests passed |
| `make test:unit:scripts` | 23 passed, 1 pre-existing skip; includes 4 matrix-runner tests |
| `make clippy:vmm`, `make clippy`, `make fmt:check:rust` | Passed |
| Bash syntax and ShellCheck for the matrix runner | Passed |

The new console lifecycle test publishes actual guest TX descriptors without a final queue kick and checks that `Vm::run` delivers them before returning.
Socket tests check partial bind failure, normal destruction, replacement paths and invalid configuration cleanup.
These are new composition contracts; the seccomp change is separately backed by the observed failure with production changes absent.

## Acceptance limits

All selected cases ran, but the matrices are not all green and do not complete either milestone.
Secret-substitution cases check configuration rather than mounted VM behavior.
Both engines print `open_tree` EPERM during the mount ID-mapping diagnostic, which does not fail its enclosing test; no successful ID-mapping claim follows from 40/40.
The guest unit run's leaky-process warning also remains a limitation; a passing test count does not establish complete process cleanup.

ARM/macOS qualification, virtio-rng, host-sleep clock recovery, full per-thread filtering and full filesystem conformance remain outside these runs.
The existing common shim exemption for in-process gvproxy still applies; the network-disabled seccomp path and network-enabled matrix are distinct evidence.
