# Runner CI acceptance attempts

## Environment

Base `d3fb1fce00f0db67d435250cfa5f5550469b0c55`, branch `vibe_features`.
macOS 27.0.1, arm64; Rust 1.97.1, Go 1.26.5, Node 26.11.0.
Private logs: `.apps-local/feature-acceptance/2026-10-21/`.
F1's unfinished production changes were saved locally and removed after round 6.

## F1

1. Existing remote clients reject guest privilege. Hypothesis: forwarding the
   existing guest option, without changing host security, enables DinD remotely.
   Added capability negotiation, API persistence, C/Go/runner forwarding and
   isolated acceptance harness. `make test:unit:rust FILTER=privileged` exited 2:
   old wire-type tests accessed the now-optional capability policy directly
   (`E0609`). Log `f1-r1-rust.log`; no guest acceptance executed.
2. Updated old tests for optional capabilities. Same command exited 2 with
   `E0507` (test attempted to move out of a borrowed request). Log
   `f1-r2-rust.log`. This is a test adaptation failure, not Docker evidence.
3. Borrow policy with `as_ref()`: unit tests pass; infrastructure probe uses the
   wrong runner health path and times out.
4. Correct health probe: infrastructure passes; DinD fails at Python constructor.
5. Add missing Python binding: real guest starts; dockerd fails on missing nft.
6. Draft kernel build: builder was never started; build fails. Stop at the cap.

See [F1's complete failure record](2026-10-21-f1-dind-incomplete.md) for commands,
exit codes, hypotheses, versions, retained patch and guest evidence.

### F1 resumed (2026-10-22; user removed the attempt limit)

7. Restore the explicit builder lifecycle and install pyelftools. Builder
   `ZFIacy695Ca6` starts, downloads and verifies Linux 6.12.87, applies all vendor
   patches, then stops at `Kconfig refused NFT_COUNTER`: that old symbol no
   longer exists. `make kernel:dind` exits 2. Upstream 6.12 netfilter/Makefile
   includes nft_counter.o directly in NF_TABLES; remove the obsolete separate
   symbol and include NFT_CHAIN_NAT. No kernel artifact yet. Log:
   `.apps-local/feature-acceptance/2026-10-22-f1-resumed/r7-kernel-build.log`.
8. Counter support is built in, but the proposed NFT_CHAIN_NAT replacement is
   also obsolete: `make kernel:dind` exits 2 at the symbol assertion. Check
   upstream Kconfig and Makefile together: NFT_NAT includes nft_chain_nat.o.
   Remove both obsolete symbols; retain NF_TABLES/NFT_NAT and check all requested
   symbols in one pass. Log `2026-10-22-f1-resumed/r8-kernel-build.log`.
9. All requested Kconfig assertions pass and real kernel compilation proceeds.
   `make kernel:dind` exits 2 because the vendored IKHEADERS configuration also
   needs cpio. Install cpio and resume the retained build tree. Log
   `2026-10-22-f1-resumed/r9-kernel-build.log`; kernel/Makefile:159 reports the
   missing executable. No kernel feature was disabled to bypass this failure.
10. Install cpio; kernel compilation and firmware packaging pass. Build SDK and
    runner with `BOXLITE_LIBKRUNFW_SOURCE`, restart the isolated API and both
    runners, then `make test:runner-ci:dind` exits 0: actual guest kernel
    `6.12.87-boxlite-dind`, Docker 27.5.1 overlay2/ext4, pull/build/run and Compose
    HTTP 200 with the unique marker. Source defaults still preserve host sandbox.
    See [resumed qualification](2026-10-22-f1-dind-qualification.md) for regression
    commands, before/after evidence and artifacts. F1 completes after ten total
    rounds, four after reopening; other features are not requalified by this run.

## Remaining features

F2: zero rounds, BLOCKED by F1; see [Swarm report](2026-10-22-f2-swarm-blocked.md).
F3–F6: zero implementation/verification rounds. No acceptance claim yet.
