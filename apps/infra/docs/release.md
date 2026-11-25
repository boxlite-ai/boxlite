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
| Prepare dev | `mbuild publish` pushes the declared images to GHCR. The Runner job uploads the original tarball as an OCI layer. The candidate records each image manifest digest, the Runner manifest and archive digests, and the file checksums. |
| Dev approval and E2E | Approve the dev Environment in the run. The cloud suite installs the candidate CLI and SDKs from Actions Artifacts. |
| Publish | After dev E2E passes, the release job uploads the accepted files to the draft and checks every remote asset digest. The top-level PyPI and npm jobs publish the accepted packages and the Go job tags the tested commit. |
| Release and prod | When those publishers succeed, the workflow marks the draft public. Rust crates publish after the runtime becomes public. The prod deployment uses its protected Environment and the accepted candidate. |

The Runner package at `ghcr.io/boxlite-ai/boxlite/runner` must allow anonymous pulls from hosts. First boot and in-place upgrade verify the OCI manifest against the release tag, source commit and archive digest before extracting the binary. Dev and prod receive those pins from the candidate. A version-only manual rollout reads the same pins from the published `release-candidate.json`.

### Retries

Rerunning the API build replaces that API version's GHCR tag with the rebuilt manifest. Other successful matrix entries keep their digests. A failed Docker upload retries the image already built by that job.

A same-version Runner rebuild changes the pinned manifest. Hosts record the installed manifest and archive digests and reapply when either changes.

Each Runtime or CLI tarball sidecar and the installer sidecar `install.sh.sha256` occupies one entry in the release inventory. A retry of an interrupted draft upload compares each existing attachment with the accepted file. A conflicting digest stops publication. Inspect the originating run before replacing an already distributed version.

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
