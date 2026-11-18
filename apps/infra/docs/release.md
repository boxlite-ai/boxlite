## TL;DR

Publish a stable release to build its artifacts, validate dev, and receive a Slack link to approve that version's prod deployment.

## Release runbook

The examples use `v0.10.3`; replace it with your stable `vX.Y.Z` release tag.
Pre-release suffixes are unsupported.

### Before you start

- Merge the version bump into `main` and pass its required checks.
- Configure repository Actions secret `SLACK_WEBHOOK_URL` with a Slack incoming webhook.
- Configure required reviewers on the `prod` GitHub Environment.
- Ensure the dev/prod stage declarations, cloud credentials, and cloud E2E credentials are configured.
- Have permission to start workflows and approve the deployment Environments.

Publication needs package write permission; orchestration needs Actions write permission.
Neither job binds a cloud Environment; the existing deployment and E2E workflows retain their own approvals.

### 1. Publish the GitHub Release

Sync `main`, then create and push the release tag:

```bash
git switch main
git pull --rebase origin main

TAG=v0.10.3
git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" \
  --repo boxlite-ai/boxlite \
  --verify-tag \
  --generate-notes
```

Pushing the tag starts no release build; publishing the Release starts the SDK/runtime builds and
`Publish Release Images`. The latter dispatches `mbuild-release` from `main` with `build-only=false` by default.
The successful release C SDK build starts `Build Go SDK` and `Build Runner Binary`.

### 2. Follow the dev acceptance pipeline

Open **Actions → mbuild-release**:

```text
Publish all declared images to GHCR
  → Wait for required GitHub Release assets
  → dispatch mdeploy-all: dev, this tag → wait for success
  → dispatch e2e-cloud: dev, this tag → wait for success
  → verify dev deployment history and prod reviewers
  → dispatch mdeploy-all: prod, this tag (approval pending)
  → report results to Slack and the GitHub job summary
```

The publisher reads the tagged commit's artifact declaration and builds its current four images:
`api`, `proxy`, `otel-collector`, and `registry-proxy`.
Their address is `ghcr.io/boxlite-ai/boxlite/<artifact>:vX.Y.Z-<full-commit-sha>`.
Publication logs manifest digests and reuses existing images without overwriting them.
Dependency audit failures stop publication; receiving cloud registries enforce image scans after import.

Asset readiness checks the Release API for uploaded, nonempty files, rather than waiting for every SDK workflow:

| Consumer | Required release assets |
| --- | --- |
| Runner | `boxlite-runner-vX.Y.Z-linux-amd64.tar.gz` and its `.sha256` |
| Python E2E | `boxlite-X.Y.Z-cp312-cp312-manylinux_2_28_x86_64.whl` |
| Node E2E | `boxlite-ai-boxlite-X.Y.Z.tgz`, `boxlite-ai-boxlite-linux-x64-gnu-X.Y.Z.tgz` |
| C E2E | `boxlite-c-vX.Y.Z-linux-x64-gnu.tar.gz` |
| CLI E2E | `boxlite-cli-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz`, `install.sh` |

The existing installer and deployment workflow verify/download these assets when they consume them.
Asset waiting is limited to three hours; dev deployment to three hours; E2E to one hour.
Approve dev/E2E Environment requests within those limits.

All child workflows run from `main`, with these fixed inputs:

| Workflow | Inputs |
| --- | --- |
| Dev `mdeploy-all.yml` | `stage=dev`, `ref=<release tag>`, `components=api+runner`, `apply=true`, `confirm=true` |
| `e2e-cloud.yml` | `stage=dev`, `tag=<release tag>`; retain all other defaults |
| Prod `mdeploy-all.yml` | `stage=prod`, `ref=<release tag>`, `components=api+runner`, `apply=true`, `confirm=true` |

The pipeline waits for the exact run IDs returned by GitHub dispatch.
A failed, cancelled, or timed-out dev/E2E run prevents the prod request.
Slack reports each stage and links to its specific runs; failed pipelines have no prod approval button.

### 3. Approve the prod request

After successful dev acceptance, Slack's **Review prod deployment** button opens the already-created prod run.
Check the release tag and approve its `prod` Environment in GitHub.
Each release deployment run has one protected job covering artifact checks, import and apply.
The run actor is the Actions bot; GitHub records the human reviewer separately.
Clicking the Slack link opens GitHub; deployment proceeds only after approval.

A successful `mbuild-release` means dev acceptance passed and the prod request was created.
The release is live only when that prod `mdeploy-all` run succeeds.
It imports the selected GHCR digests directly into prod's AR/ECR registry, verifies them, scans, and deploys.
Dev uses its own independent GHCR import.

### Manual runs and publication recovery

`mbuild-release` accepts:

| Input | Default | Meaning |
| --- | --- | --- |
| `command` | `publish` | Publish the declared release images |
| `tag` | Required | Stable tag whose commit is on `main` |
| `build-only` | `false` | `false`: full pipeline; `true`: image build/upload only |

For publication recovery, choose `build-only=true` to fill missing GHCR images without starting deployment, E2E, or Slack reporting:

```bash
TAG=v0.10.3
gh workflow run mbuild-release.yml \
  --repo boxlite-ai/boxlite \
  --ref main \
  -f command=publish \
  -f tag="$TAG" \
  -f build-only=true
```

Omit `build-only` or set it to `false` to request the full pipeline.
The publication-only path does not wait for release assets and needs no Slack secret.
For an intentional manual deployment, use the [deployment runbook](deployment.md#deploy-through-github-actions).

### Validation and recovery boundaries

Keep release tags and assets immutable.
The pipeline compares the tag's commit with the publisher's resolved commit before every dispatch.
Changes after the prod request is created remain an operator responsibility.

Full pipelines share one dev validation concurrency group.
Before requesting prod, the pipeline checks for overlapping dev applies, including failed/cancelled attempts and manual reruns.
It inspects at most 500 `mdeploy-all` runs and 50 attempts per run.
Missing timing, unknown overlapping applies, or truncated history prevents the prod request.
This check covers `mdeploy-all`; avoid other deployment paths during acceptance.

GitHub's native concurrency queues can replace older pending runs with newer requests.
This applies to queued release pipelines and prod deployments awaiting approval.
A Slack link identifies an exact prod run; it does not reserve a permanent queue position.
Inspect that run's current state before approving or recovering it.

Parent timeouts/cancellation leave dispatched children under GitHub's control.
Inspect their exact run links before retrying; an interrupted apply may still be running.
An uncertain dispatch response is never retried automatically because GitHub may already have created the run.
If only Slack delivery failed, use the GitHub report summary and rerun only the report job.
Rerunning the whole pipeline can create another deployment request.

### Common failures

| Failure | Response |
| --- | --- |
| Missing GitHub Release | Publish the Release matching the tag |
| Missing required assets | Inspect the runtime/C/Node/wheels/Runner builds; the Runner build follows the C SDK build |
| Invalid or missing webhook | Configure repository secret `SLACK_WEBHOOK_URL`; full mode refuses deployment without it |
| Missing GHCR image | Recover with `build-only=true`, then inspect downstream runs before restarting |
| Invalid tag or tag moved | Use an immutable stable release tag whose commit is on `main` |
| Overlapping dev apply | Finish deployment activity and repeat dev acceptance for the intended release |
| Missing prod reviewers | Configure required reviewers on the `prod` Environment before retrying |

See [deployment mechanics](deployment.md#deploy-through-github-actions) for digest conflicts,
registry authentication, and manual rollout diagnostics.
