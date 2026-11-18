## TL;DR

AWS uses native Pulumi for new deployments and a guarded adoption process for existing SST stages.

## Details

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

### Prerequisites

| Provide | Requirement |
| --- | --- |
| Account | Administrative bootstrap access and separate runtime/deploy roles |
| Region | ECS, RDS, Redis, nested-KVM EC2 capacity and EBS gp3 |
| Tools | Node.js 22+, Git, gh, AWS CLI and Pulumi CLI |
| Publishing | Docker/buildx or existing release artifacts |
| DNS and identity | Cloudflare zone/token and configured OIDC credentials |

Declare `home: "aws"`, region, registry, protection and sizing in `.mstage.config.json`.
Account identity comes from resolved credentials; see [configuration](../configuration.md).

### Bootstrap and preview

Run `make _ensure-infra-deps` from the repository root.
From `apps/infra`, these operator commands prepare prerequisites and preview the declared stage:

```bash
npm run mstage login -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run bootstrap -- --stage dev
npm run mstage config put -- --stage dev
npm run mdeploy -- --stage dev --diff
```

Bootstrap prepares the declared app's IAM boundary, distinct deployment role, ECR repository, artifact bucket and state envelope.
Fill the native mstage groups and AWS secret ARNs before preview; bootstrap does not deploy application resources.

Existing SST resources require [migration](migration.md) before native mutation.
Historical workflows must be fenced through IAM as well as the checked-in ownership guards.

### Deployment scope

| Selection | AWS behavior |
| --- | --- |
| `api` | Existing ECS API task/service and its runtime/secret grants |
| `runner` | Existing fleet's SSM readiness/update commands and artifact/checkpoint grants |
| `api+runner` | Full infrastructure graph |

Scoped deployments require existing workloads and an unchanged fleet identity and attachment inventory.
They first refresh and preview the complete graph, rejecting shared changes before applying selected targets.

Use shared [CI](../deployment.md#deploy-through-github-actions) or [local commands](../deployment.md#deploy-an-existing-stack).
Native workflows assume the stage's `AWS_PULUMI_DEPLOY_ROLE_ARN`.

### Retained legacy AWS deployment

`deploy-infra.yml`, `deploy-release.yml` and `npm run deploy` operate the retained SST tree.
`npm run bootstrap -- --stage <stage> --legacy-sst` selects its prerequisite conventions.

Checked-in legacy deploy/refresh/remove commands share the S3 ownership lease with native entrypoints.
The SST configuration rejects adoption/native ownership; historical revisions require the IAM fence.

Legacy and native app names do not share state or configuration automatically.
After a native update attempt, recovery uses forward repair rather than switching back to the legacy deployer.

### Verify

Run the shared [service checks](../deployment.md#verify-the-result), then inspect [Runner outcomes](runners.md).
Verify a private registry pull, checkpoint capture/import/delete, and EBS expansion before enabling those capabilities in production.

Checkpoint capture requires explicit application enablement.
Disk expansion defaults to enabled; set `RUNNER_DISK_EXPANSION_ENABLED=false` to disable it.
AWS customer-owned domains remain deferred; platform wildcard domains are available.

CloudWatch extracts disk failure and critical-pressure metrics from API JSON logs into an app/stage namespace.
The inherited unreachable-event producer needs separate follow-up; see [security](security.md).

Sources: [native entrypoint](../../mdeploy/pulumi/aws-program.ts), [bootstrap](../../bootstrap/aws/README.md), [migration guards](../../mdeploy/src/aws-adoption.ts).
