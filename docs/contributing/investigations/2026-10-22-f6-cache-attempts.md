## TL;DR

F6 reopened without a round limit; round 7 passes cache checks, and rounds 8 onward qualify the combined path.

## Details

Base `dcc15340`; private logs: `.apps-local/feature-acceptance/2026-10-22-f2-f6/`.
Earlier rounds are recorded in `2026-10-21-runner-ci-attempts.md`.

### F6 round 4 — qualify ext4 cache image

- Hypothesis: a loop-mounted ext4 image in the exclusive virtiofs cache provides
  overlay2's required Linux metadata while retaining all Docker data on runner disk.
- Change: explicit version/profile-checked guest entrypoint, filesystem recovery,
  orderly unmount; real V4/V5 acceptance through the SDK/API/runner chain.
- Command: `PATH=/opt/homebrew/bin:$PATH make test:runner-ci:docker-cache`;
  log `f6-r4-docker-cache.log`; exit 2 after the 90-second daemon deadline.
- Guest `6XU4zXfgm8tx`, cache `docker-cache-f41b161b7b`, retained. Its cache
  stayed empty: the exact version guard expected `1.7.25` but containerd reports
  `v1.7.25`. No loop image or daemon was created. The storage hypothesis was not
  reached. `make test:runner-ci:docker-cache-diagnose` exits 0 and records versions,
  empty cache, processes and mounts in `f6-r4-diagnosis.log`.

### F6 round 5 — correct the pinned containerd guard

- Hypothesis: the version-format mismatch, not storage compatibility, caused the
  prior early exit. Match the actual pinned `v1.7.25` and print explicit mismatch
  errors. Keep the storage, image identity and cached-build assertions unchanged.
- Command: `PATH=/opt/homebrew/bin:$PATH make test:runner-ci:docker-cache`;
  log `f6-r5-docker-cache.log`.
- Exit 0; real V4 succeeds, image
  `sha256:067b069bd75ed5393f89726c53d62891612520838d23c6b7ed12810a8317f151`
  survives recreation; cached COPY/RUN and pull-never content pass. Recovery also
  retains the image. **The emitted V5 PASS is rejected on evidence review:** the
  second conflict reused a failed request name and hit name uniqueness rather
  than the cache lease. The broad error check incorrectly accepted the cache ID
  in that error. See `docker-cache-0bc505bb76.json` and its guest log.

### F6 round 6 — require the actual lease refusal

- Hypothesis: a unique failed-request name and exact admission-error assertion
  distinguish live/crashed cache ownership from unrelated name conflicts.
- Change: unique conflict names, exact `cache is exclusively owned by another Box`
  assertion, unchanged owner verification, cleanup of only rejected test rows.
  Add profile mismatch/image-byte-integrity verification and explicit mountpoint/
  dockerd version guards to the recipe. No lease implementation change.
- Planned command: `make test:runner-ci:docker-cache`, log `f6-r6-docker-cache.log`.
  This is F6's final allowed round; any unresolved failure stops F6 work.
- Exit 2: guest `c4ek4XzcaWnl`, cache `docker-cache-1c0ce3e0e0`. Exact cache
  ownership refusal is observed, then cleanup calls unavailable `runtime.list()`.
  Real SDK methods differ from the older fixture in `test_box_management.py`.
  No further fix is attempted: **6/6 used, F6 incomplete**. V4 retains round 5
  evidence; V5 and profile mismatch remain unqualified. Diagnose target exits 0.
- Scene copied to `f6-r6-scene/`; the live cache image and VM remain at the paths
  in its JSON record. Move the unfinished entrypoint into an explicitly incomplete
  infra-local reproduction fixture; do not ship it as a supported example.

### F6 round 7 — use the actual SDK cleanup interface

- User removed the round limit; numbering continues. Revision `d42037b3` plus
  the one-line harness correction; unchanged Docker recipe and lease code.
- Failure: round 6 cleanup used unavailable `list()`. Hypothesis: `list_info()`
  matches the installed SDK and allows the remaining strict assertions to run.
- Change: use `list_info()`; no weaker error matching or storage changes.
- Command: `PATH=/opt/homebrew/bin:$PATH make test:runner-ci:docker-cache`,
  `f6-r7-docker-cache.log`, exit 0. V4 and V5 pass, including two distinct exact
  cache-ownership refusals, orderly reuse, killed-daemon recovery, and profile
  mismatch refusal with unchanged image SHA256. No Docker socket is shared.
- Scene `docker-cache-d89895afdf{.json,-guest.log}` records image
  `sha256:a6acb57df25b38ed44171d8d7b4c6d1887c12405405ba5299d2bc53a63345bcc`.
  The JSON's old static revision label is superseded by the revision above.
  Successful Boxes and test cache were deleted; previous failed scenes remain.
  V1–V3 regression and final documentation follow before declaring F6 complete.
- `make test:runner-ci:cache` exits 0, `f6-r7-cache-regression.log`, record
  `cache-108ba945d4`. V1–V3 and S5 pass again, including actual runner SIGKILL,
  lease preservation until native Box deletion, tenant separation and explicit
  cache replacement for snapshot children. The ordinary conflict check now
  requires the same exact lease error and unchanged owner as the Docker check.
  Successful resources and separately provisioned tenant credentials are removed.
- Promote the unchanged qualified entrypoint to `fixtures/docker-cache.sh`,
  replace the stale hard-coded revision label with actual git HEAD, and rerun
  the complete Docker probe against that final path (`f6-r7-final-docker-cache.log`).
- Final probe exits 0: `docker-cache-aefc994500`, image
  `sha256:14cfc5f60ca01c72d60c952f9f97b374c06a133c6caf7103c482a6cd6b524eaa`.
  Both exact ownership conflicts, full V4/V5 and byte-preserving profile rejection
  pass again. Test resources are removed. Format/lint exit 0. F6 finishes after
  7 numbered rounds; combined E remains blocked by F5's runner-local placement.

### F6 rounds 8–9 — combined snapshot/Swarm/cache path

After the F5 extension, round 8 tests the unchanged cache recipe with actual
snapshot children on two runners. The default VIP DNS assertion fails on an
inherited `localdomain` suffix, despite working Engines and cluster membership.
The full failing scene is saved before stopping its guests. Round 9 fixes only
the daemon DNS search configuration and persisted profile. The same combined
probe passes, as do strict V4/V5 and profile-mismatch regression checks.
See the [complete hypothesis, commands, exit codes and scene paths](2026-10-22-combined-snapshot-swarm-cache.md).
F6 now finishes after nine rounds. The former E block is resolved.
