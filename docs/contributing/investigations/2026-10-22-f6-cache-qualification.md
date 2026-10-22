## TL;DR

F6 passes V1–V5 with real runner caches, Docker image/build reuse and exclusive crash recovery.

## Details

Later rounds 8/9 also qualify [combined E](2026-10-22-combined-snapshot-swarm-cache.md)
after F5 adds cross-runner snapshot copying. The recipe now uses profile format 2
with `dns-search=["."]`; the original V4/V5 probe passes again in
`2026-10-22-f5-copy/f6-round9-docker-regression.log`, record `docker-cache-8f37fe6822`.
The round-7 results below remain historical evidence for their original profile.

Round 7 resumes `d42037b3` after the user removed the attempt limit. The only
correction needed to finish the strict Docker probe is using the installed SDK's
`list_info()` during failed-request cleanup. Cache lease/runtime production code
is unchanged. The [recipe](../../../apps/infra-local/fixtures/docker-cache.sh)
is promoted from the preserved incomplete fixture after qualification; see the
[usage contract](../../guides/runner-local-cache.md) and
[attempts](2026-10-22-f6-cache-attempts.md).

### Environment and storage

macOS 27.0.1 arm64; two independent runner processes on one physical Mac, ports
13003/13004, runtime homes `~/.bl/142b9945/qa` and `qb`. Each keeps its own
`cache-volumes/<organization>/<cache-id>/data` and private sibling lease.
Guest Linux 6.12.87-boxlite-dind; Docker 27.5.1, Compose 2.33.0, Buildx 0.20.1,
containerd v1.7.25, e2fsprogs 1.47.1-r1, util-linux 2.40.4-r1.
Docker and BusyBox images are pinned by digest in the harness.

Docker's root is `/var/lib/docker`, an ext4 loop mount backed by the 2 GiB
sparse `/cache/docker.ext4` on the actual runner-local volume. The test asserts
the loop BACK-FILE, mount type, Docker driver/root and host backing-file size.
Classic overlay2 is selected; containerd snapshotter is disabled. Managed
containerd's actual root `/var/lib/docker/containerd/daemon` is inside that same
image. This is not direct overlay2-on-virtiofs qualification.

The persisted profile fixes Docker/containerd versions, data root, filesystem,
size and storage mode. A mismatch fails before mounting or writing the image.
New images alone are formatted; existing images undergo `e2fsck -p`, accepting
only clean/corrected status. Normal stop waits for the daemon, synchronizes,
unmounts and detaches the loop. A guest-local lock prevents two entrypoints;
the runner's lifetime lease prevents another Box from mounting the same cache.
No cross-version or image-only daemon-state portability is promised.

### Real assertions

Logs are under `.apps-local/feature-acceptance/2026-10-22-f2-f6/`; named JSON
records and full guest logs are under `.apps-local/runner-acceptance/`.

| ID | Status | Evidence |
| --- | --- | --- |
| V1 | PASS | `f6-r7-cache-regression.log`, `cache-108ba945d4`: delete A, create B on the same runner, marker retained |
| V2 | PASS | Same record: identical logical ID on the two runners has distinct real disk/guest markers |
| V3 | PASS | Same: separate authenticated tenant, orderly runner restart, occupied-delete 409, idle cutoff, delete/404, fresh empty initialization |
| V4 | PASS | `f6-r7-docker-cache.log`, `docker-cache-d89895afdf`: identical local image ID after deletion, unique content with pull-never, repeated COPY/RUN hits |
| V5 | PASS | Same Docker record: exact lease refusal both live and after SIGKILL of dockerd, unchanged owner, deletion followed by checked recovery and retained image/content |
| S5 cache boundary | PASS | `cache-108ba945d4`: system marker survives snapshot, cache marker/path absent; explicit new child cache is independent |
| Profile mismatch | PASS | `docker-cache-d89895afdf`: mismatch rejected; complete image SHA256 unchanged before/after |
| Runner crash | PASS | `cache-108ba945d4-crash/`: SIGKILL of owned runner, persistent lease, occupied deletion still refused, native removal then sequential reuse |
| Combined E | PASS | [F6 round 9](2026-10-22-combined-snapshot-swarm-cache.md): F5 copy, cold children, different-runner Swarm and independent cache reuse |

Round-7 image ID:
`sha256:a6acb57df25b38ed44171d8d7b4c6d1887c12405405ba5299d2bc53a63345bcc`.
The final-path repeat also exits 0 in `f6-r7-final-docker-cache.log`, record
`docker-cache-aefc994500`, with image
`sha256:14cfc5f60ca01c72d60c952f9f97b374c06a133c6caf7103c482a6cd6b524eaa`;
all V4/V5/profile assertions pass and its resources are removed.
The Docker test reads the image before any build in B, runs with `--pull=never`,
and verifies both build hits and the unchanged image ID. Two unique rejected
request names and the exact cache-ownership error exclude the false name-conflict
pass discovered in round 5. Its historical printed V5 PASS remains invalid.

### Reproduction, cleanup and limits

With the DinD runtime installed and the isolated stack running, execute separately:

```sh
make test:runner-ci:cache
make test:runner-ci:docker-cache
make fmt:runner-ci
make lint:runner-ci
```

The probes change scheduling only temporarily and restore the previous values.
Do not run them concurrently with Swarm probes. Success removes test Boxes,
snapshots and caches; failures retain them and print their scene paths. All
rounds 4–6 logs, scripts and disks remain at the paths in the
[historical report](2026-10-22-f6-cache-incomplete.md); no old evidence is discarded.
Only reviewed summaries are committed. No push, PR or external issue was created.

Caches do not influence placement, synchronize or migrate. An unavailable cache
on another runner is a permitted miss. Stopped Boxes retain ownership. All
daemon state persists, including networks and Swarm membership: clean workloads
and leave the old Swarm before assigning the cache to a new cluster. The Docker
recipe and Swarm are independently qualified; the blocked combined path is not
presented as a pass. Memory snapshots remain outside F6.

The final F1 regression also exits 0 in `reopened-regression-f1.log`: guest
Docker pull/build/run and Compose HTTP still pass through SDK/API/runner.
`reopened-format-final.log` and `reopened-lint-final.log` record exit 0.
