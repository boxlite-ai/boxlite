## TL;DR

Publish a stable release to build its artifacts, validate dev and request prod approval in GitHub. Optional Slack messages link reviewers to each deployment.

## Release runbook

The examples use `v0.10.3`; replace it with your stable `vX.Y.Z` release tag.
Pre-release suffixes are unsupported.

### Before you start

- Merge the version bump into `main` and pass its required checks.
- Configure required reviewers on the `prod` GitHub Environment.
- Ensure the dev/prod stage declarations, cloud credentials, and cloud E2E credentials are configured.
- Have permission to start workflows and approve the deployment Environments.

Publication needs package write permission. The rollout jobs use the existing stage Environment and cloud identity. Cloud E2E receives only its named dev test keys.

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
Publish GHCR images → check release assets → approve and deploy dev → dev E2E
  → report the E2E result to #release
  → on success, review and approve prod → deploy prod
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
The asset check waits up to three hours. The shared E2E job has a 45-minute execution limit.

### Approvals and results in the release run

Open the original `mbuild-release` run for both Environment approvals, deployment logs and E2E results.
The release calls `mdeploy-all` for dev and prod with the published tag, its exact commit, `api+runner`, apply and confirmation enabled.
Dev calls `e2e-cloud` with the release tag and dev test keys. A failing or skipped acceptance test prevents promotion.

The E2E report appears in the GitHub summary and, when configured, in Slack before prod approval.
A configured reviewer on the prod Environment must approve the protected rollout.
The release run stays open until the production deployment finishes. Each stage imports the verified image digests from GHCR.

### Slack notifications

| Event | Destination |
| --- | --- |
| Release dev approval, deployment result and E2E report | #release via `SLACK_WEBHOOK_URL` |
| Prod approval and deployment result | #release via `SLACK_WEBHOOK_URL` |
| Standalone dev approval and dev/stage deployment results | Dev Slack via `SLACK_DEV_DEPLOYMENT_WEBHOOK_URL` |

Each deployment result names its environment, ref and outcome and includes a button opening the run.
A preview skips deployment notifications. An unset webhook skips its channel.
A malformed release webhook fails the asset check. GitHub retains the E2E summary if Slack delivery fails.

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

Keep release tags and assets immutable. The reusable rollout verifies the published SHA, and E2E checks the tag before testing.
The dev rollout holds the same stage concurrency group as standalone deployments through the acceptance test.
The prod approval uses the prod group, so another dev deployment can proceed while reviewers consider prod.

Dev deployment and acceptance must belong to the same run attempt. A retry that would reuse acceptance from an earlier attempt fails closed.
Inspect any interrupted cloud apply before restarting the full release. GitHub concurrency may replace older pending requests.

### Common failures

| Failure | Response |
| --- | --- |
| Missing GitHub Release | Publish the Release matching the tag |
| Missing required assets | Inspect the runtime/C/Node/wheels/Runner builds; the Runner build follows the C SDK build |
| Invalid release webhook | Correct or clear `SLACK_WEBHOOK_URL` before rerunning asset preflight |
| Missing GHCR image | Recover with `build-only=true`, then inspect the release run before restarting |
| Invalid tag or tag moved | Use an immutable stable release tag whose commit is on `main` |
| Stale acceptance attempt | Inspect earlier applies, then rerun deployment and acceptance together |
| Missing prod reviewers | Configure required reviewers on the `prod` Environment before retrying |

See [deployment mechanics](deployment.md#deploy-through-github-actions) for digest conflicts,
registry authentication, and manual rollout diagnostics.
