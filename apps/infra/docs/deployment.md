## TL;DR

Prepare the selected cloud first, then use the shared preview, apply, verification and recovery workflow.

# Shared deployment workflow

[Infrastructure index](../README.md)

## Architecture

Choose the [GCP architecture](gcp/architecture.md) or [AWS architecture](aws/architecture.md).
These shared commands assume the corresponding cloud prerequisites have been prepared.

## Prerequisites

Follow the [GCP prerequisites](gcp/deployment.md#prerequisites) or
[AWS prerequisites](aws/deployment.md#prerequisites) before cloud-writing commands.
Stage names do not select a cloud; the ignored declaration's `home` field does.

## Bootstrap a stage

Use the separate [GCP bootstrap procedure](gcp/deployment.md#bootstrap-a-stage) or
[AWS bootstrap and compatibility check](aws/deployment.md#bootstrap-and-choose-the-deployment-path).
`npm run bootstrap` prepares prerequisites; it does not prove application readiness.
Required application values include `OIDC_CLIENT_ID`; set and verify them using [configuration](configuration.md).

## Deploy through GitHub Actions

For a stage with verified mdeploy prerequisites, the entrypoint is [mdeploy-all.yml](../../../.github/workflows/mdeploy-all.yml).
It defaults to a preview. Example: preview an open PR's merge result in `dev`:

```bash
gh workflow run mdeploy-all.yml --ref main   -f stage=dev -f ref='#123' -f components=api+runner -f apply=false
```

Replace `#123` with the intended PR, or use a full commit SHA. Review the resolved SHA, stage identity,
artifact identities and complete resource diff. Then dispatch that reviewed SHA with `apply=true`.
A fresh PR ref can resolve to a different merge commit; pin the reviewed SHA when applying.

| Ref | Allowed stages | Artifact path |
| --- | --- | --- |
| Full SHA or open PR `#number` | `dev` | Ensure commit images and runner build exist |
| Published `vX.Y.Z` release | `dev`, `prod` | Version-qualified images and published runner release |

Release dispatches run from `main`. Production accepts releases only. For a protected production apply:

```bash
gh workflow run mdeploy-all.yml --ref main   -f stage=prod -f ref=vX.Y.Z -f components=api+runner -f apply=true -f confirm=true
```

Run a preview of that release first. `components=api` or `runner` narrows artifact preparation,
not the entire infrastructure graph. Runs queue per stage; do not cancel a healthy apply to start another.
Image releases are published/promoted through [mbuild-release](../../../.github/workflows/mbuild-release.yml).

## Retained legacy AWS deployment

The [AWS deployment guide](aws/deployment.md#retained-legacy-aws-deployment) owns the retained SST path
and its compatibility boundary. Its [runner update launcher](../scripts/runner-update-binary.mjs)
is separate from current mdeploy orchestration.

## Deploy an existing stack

Local deployment uses the same stage configuration and artifact identities. Publish or promote
images first with [mbuild](../mbuild/README.md), and prepare the selected [runner artifact](runners.md).
The following example assumes release images `vX.Y.Z-<sha>` and runner release `X.Y.Z` already exist:

```bash
export BOXLITE_IMAGE_TAG='vX.Y.Z-<full-commit-sha>'
export VERSION='X.Y.Z'
npm run mstage login -- --stage dev
npm run mstage env digest -- --stage dev
npm run mbuild verify -- --tag <full-commit-sha> --version vX.Y.Z --stage dev
npm run mdeploy -- --stage dev --diff
npm run mdeploy -- --stage dev
```

Substitute real values and inspect the preview before the last command. Add `--confirm` for a
protected stage. For a commit runner build, use the selectors in the [runner runbook](runners.md).
`mdeploy --local-env` bypasses store loading and is an explicit diagnostic option, not the default.

## Secrets & credentials

[Configuration](configuration.md) owns the file/store/CI boundaries, and
[security](security.md) explains runtime identity and protection. Inspect names with
`npm run mstage env list -- --stage dev`; value exports belong in a secure destination.

### Cloudflare API token

Provide an account-owned token with **Zone:Read** and **DNS:Edit**, restricted to the zone used by
`STACK_DOMAIN` and `PROXY_DOMAIN`. Set `CLOUDFLARE_DEFAULT_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID`
to the intended account/zone. Both are required by the current deployment group, alongside the token.
The token is created in Cloudflare's dashboard; a provider login does not generate it.

Follow the selected cloud’s [deployment guide](#bootstrap-a-stage) for credential storage and rotation destinations.

## Verify the result

| Check | Evidence to inspect |
| --- | --- |
| Intended deployment | Resolved stage, cloud/project/account, commit and artifact identities |
| Infrastructure | Successful apply with no unexpected replacement or deletion |
| API and dashboard | Public HTTPS, `/api/health`, dashboard load and OIDC login |
| Proxy | Healthy load-balancer backends and an actual box preview/tunnel |
| Runners | Fleet registration, target health identity, box create/exec/stop |
| Persistent volumes | Create/mount/write/read using a test volume if enabled |
| Telemetry | A new test event reaches the configured destination and is queryable |

Use the [runner](runners.md#verify-and-recover), [network](networking.md), and
[ClickHouse](clickhouse.md) guides to locate the failing boundary.
The legacy wrapper's automatic checks do not imply that mdeploy performs the same checks.

## Recovery and teardown

| Symptom | Next check |
| --- | --- |
| Stage/config not found | Ignored declaration and CI environment variable; [configuration](configuration.md) |
| Missing required key or digest mismatch | Correct the stage store, review values, then certify the intended group |
| Missing image or runner artifact | Verify the exact commit/release in the correct stage; do not treat permission failure as absence |
| Credential failure | Check identity using the selected cloud’s deployment guide |
| Service cannot reach a runner | [Private routes, firewall source ranges and DNS](networking.md) |
| Apply succeeded but runner is old | [Cloud rollout reports and live health](runners.md#verify-and-recover) |
| Locked or interrupted deployment | Confirm no writer is running, then follow [state recovery](../mstage/README.md#state-recovery) |
| Login, invitation or email failure | [Identity and mail](identity-and-mail.md) |

Do not clear a live deployment's lock or restart a healthy service merely because an apply is slow.
An apply can partially succeed before failing; inspect cloud and state before retrying or rolling back.

Refresh reconciles the checkpoint; it does not apply a new desired resource graph:

```bash
npm run mdeploy -- --stage dev --refresh
npm run mdeploy -- --stage dev --diff
```

For intentional removal of an unprotected disposable stage, the command is
`npm run mdeploy -- --stage <stage> --remove --confirm`. Protected stages are refused.
Independent resource protection and retained data can also prevent or outlive removal; inventory them
before calling teardown complete. Bootstrap identities, registries and artifact/state buckets have
separate ownership and are not implicitly erased by removing application resources.

## Scaling and cost

Use [runner operations](runners.md#scale-out) to add capacity. Resource sizes, database availability,
backups and ClickHouse mode come from the stage's `deploy` block.
Use the separate [GCP cost catalog](gcp/costs.md) or [AWS inventory](aws/costs.md).
Estimate from the selected region, configuration and traffic rather than a fixed monthly total.

## Reference

[Architecture](architecture.md) · [mdeploy](../mdeploy/README.md) · [mstage](../mstage/README.md) ·
[mbuild](../mbuild/README.md) · [ClickHouse](clickhouse.md) · [Status page](status-page.md)
