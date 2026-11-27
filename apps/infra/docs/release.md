## TL;DR

Start `mbuild-release` on `main` to build a draft release, test its files on dev and publish the verified version.

## Release runbook

Merge the version bump and tag its commit on `main`. The tag must match the stable workspace version in `Cargo.toml`.

```bash
TAG=v0.15.0
gh workflow run mbuild-release.yml --ref main -f tag="$TAG"
```

The run creates the draft or selects the existing draft for that tag. Configure the package trusted publisher for PyPI and each npm package with `mbuild-release.yml` as the workflow filename. The prod GitHub Environment needs required reviewers.

### What runs

| Stage | Outputs and checks |
| --- | --- |
| Build | Runtime and CLI, wheels, npm packages and C SDK archives build in parallel and enter Actions Artifacts. Go tests and the Linux Runner build link the C archives from this run. |
| Prepare dev | `mbuild publish` pushes the declared images to GHCR. The Runner job uploads the original tarball as an OCI layer. Once the GHCR producers finish, the dev preparation job verifies image and Runner digests, saves the deployment candidate and requests dev approval. SDK tests and distribution packaging continue in parallel. |
| Dev approval and E2E | Approve the dev Environment in the run. The cloud suite reads only the Linux x64 CLI, Python wheel, C SDK and two npm tarballs from this run. It records their checksums with the accepted deployment digests. |
| Publish | Dev E2E success opens prod approval immediately. In parallel, publication waits for the complete distribution and Go tests, compares the tested client bytes, and attaches the verified files to the draft. The top-level PyPI and npm jobs publish the accepted packages. |
| Release and prod | When those publishers succeed, the workflow marks the draft public. Rust crates can then publish, and the Go job verifies the public C SDK downloads before tagging the tested commit. Approved prod deployment uses the same GHCR digests and can finish while the release is still a draft. |

The C SDK and Runner workflows each load CI configuration and validate the build commit in one preparation job. A regular release skips the lookup for a previous acceptance receipt. Once its own attachments succeed, npm and PyPI can start. Finalization requires both to succeed.

The Runner package at `ghcr.io/boxlite-ai/boxlite/runner` must allow anonymous pulls from hosts. First boot and in-place upgrade verify the OCI manifest against the release tag, source commit and archive digest before extracting the binary. Dev and prod receive those pins from the candidate. A version-only manual rollout reads the same pins from the published `release-candidate.json`.

### Retries

Rerunning the API build replaces that API version's GHCR tag with the rebuilt manifest. Other successful matrix entries keep their digests. A failed Docker upload retries the image already built by that job.

For a failed production job, use **Re-run failed jobs** in the original release run. Before requesting approval and after approval, production checks the saved dev acceptance against the run ID, accepted attempt, candidate artifact ID, manifest digest, tag and source commit. A different candidate needs its own dev E2E.

If finalization loses the GitHub response after publishing, retry the failed job. It verifies the published files and their digests without modifying them. PyPI compares existing wheel hashes before it uploads any missing files and verifies the full set afterward.

A same-version Runner rebuild changes the pinned manifest. Hosts record the installed manifest and archive digests and reapply when either changes.

Each Runtime or CLI tarball sidecar and the installer sidecar `install.sh.sha256` occupies one entry in the release inventory. The Release attachment job checks all existing selected files before uploading missing files. If a digest conflicts, the job stops before its first upload so the operator can inspect the originating run.

The npm publisher checks all existing platform packages and the main package before its first upload. It publishes missing platform packages before the main package and verifies each new registry digest. A retry reuses matching packages.

### Roll back to a release that predates the manifest

A version-only installation requires a published `release-candidate.json`. For a historical release missing the file, complete this one-time backfill before selecting the version for installation or rollback.

1. Resolve the product tag to its original commit and download the original Linux AMD64 Runner tarball and its checksum from that GitHub Release. Verify the exact filename and SHA-256 against the recorded checksum and the GitHub asset digest. Stop if the original bytes or independent evidence cannot be verified.
2. With approval to update that version, publish those verified bytes as the single `application/gzip` layer to `ghcr.io/boxlite-ai/boxlite/runner`. Use the same OCI artifact type and source, revision and version annotations as the **Push the exact Runner archive** step. Check the manifest and blob by digest with anonymous credentials.
3. Record the original `tag`, resolved commit in `sha`, OCI digest in `runner.manifest` and archive digest in `runner.archive`. For an `mdeploy-all` rollout, also populate `images` with the original verified manifest digest of each application image. Abort if a digest cannot be tied to the historical release.
4. Attach the verified metadata as `release-candidate.json` to that version and check its downloaded SHA-256. Preserve any existing manifest and investigate conflicting bytes. A rollback can then select the version and use the usual downgrade approval.

The host fetches its Runner bytes from GHCR by digest. Backfilling metadata does not confer a dev E2E acceptance receipt or make the historical build eligible for component repairs.

### Build and publish one component

Run `mbuild-release.yml` from `main` and select an existing product Release tag. Each command builds its own files, runs the component checks and publishes within this run. Standalone runs skip cloud deployment, dev E2E, prod approval and draft promotion.

| Command | Builds and publishes |
| --- | --- |
| `publish-runtime` | Runtime, CLI, installer and checksums → GitHub Release. An already public Release also permits crates.io publication. |
| `publish-wheels` | Platform wheels → GitHub Release and PyPI. |
| `publish-node` | Platform packages and main npm package → GitHub Release and npm. |
| `publish-c` | Platform C SDK archives → GitHub Release. |
| `publish-go` | Builds the C SDK matrix, tests Go, then tags `sdks/go/vX.Y.Z` only after downloading every versioned C SDK archive anonymously from the public Release and verifying its GitHub asset digest. |
| `publish-runner` | Builds the Linux x64 C SDK and Runner, pushes the Runner to GHCR and attaches its archive and checksum to GitHub Release. |

If Go tagging fails on a draft, finish the full release first. If a public Release lacks a C SDK archive, run `publish-c` for that tag and retry `publish-go`.

For example, `gh workflow run mbuild-release.yml --ref main -f command=publish-wheels -f tag=v1.2.3` selects fresh wheel publication. Set `build-only=true` to keep a standalone build in Actions. Use `source-ref` to build a branch or commit. A complete `publish` with `build-only=true` stages the GHCR images and Runner.

Component builds can overlap while a full release waits for prod approval. Jobs writing the same Release assets take a per-tag lock. Package publishers take a lock per registry and version. GitHub allows up to 100 pending jobs per group with `queue: max`.

On a full release retry, a rebuilt macOS wheel changes the distribution manifest. The run verifies all files again. It can reuse successful dev E2E if every tested Linux client hash and every deployment digest still matches the receipt.

### Manually republish a component

Open **Actions → mbuild-release → Run workflow** on `main`, select the product tag and choose `repair-runtime`, `repair-wheels`, `repair-node` or `repair-c`. Enter the candidate artifact ID from the original run. The matching dev acceptance receipt and candidate artifact must still be available. This command rechecks the tag and candidate and restores the selected attachments. Wheel and Node repairs also run the top-level PyPI or npm publisher. A repair on a draft leaves publication and prod approval to the original run.

### Approvals and notifications

Approve each cloud Environment in the parent run. The dev deployment and E2E share the dev stage concurrency lock. Prod uses the separate prod lock.

| Event | Slack destination |
| --- | --- |
| Release dev deployment, acceptance failure, prod approval and rollout results | Release Slack |
| Standalone dev and stage rollout results | Dev Slack |
| Standalone prod approval and rollout result | Release Slack |

Deployment results include a button to the originating run. The prod approval message includes successful dev acceptance. For standalone deployments, use the [deployment runbook](deployment.md#deploy-through-github-actions).
