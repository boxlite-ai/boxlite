## TL;DR

Create each AWS stage with a full native Pulumi deployment, then release the API and Runner independently.

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
Fill the native mstage groups with the workload configuration before preview.

Parameter Store references must use `/boxlite/workloads/<app>/<stage>/<name>` in the stage account and region.
Secrets Manager names use `boxlite/workloads/<app>/<stage>/<name>` in the same account and region.

ECS tasks can resolve stage parameters or Secrets Manager references. Runner hosts and managed ClickHouse credentials require a full Secrets Manager ARN without JSON-key or version selectors.

Bootstrap records the regional state bucket in the SSM parameter `/boxlite/pulumi/bootstrap`. The first deployment uses the default `api+runner` selection to create the network, services and Runner fleet.

### Deployment scope

| Selection | AWS behavior |
| --- | --- |
| `api` | Existing ECS API task/service and its runtime/secret grants |
| `runner` | Existing fleet's SSM readiness/update commands and artifact/checkpoint grants |
| `api+runner` | Full infrastructure graph |

Scoped deployments require existing workloads and an unchanged fleet identity and attachment inventory.
An API-only release keeps the deployed proxy, collector, registry proxy and Runner versions. A Runner-only release keeps all four deployed container images.

Scoped previews and updates refresh the selected targets. Run a full `api+runner --diff` to inspect shared infrastructure.

Use shared [CI](../deployment.md#deploy-through-github-actions) or [local commands](../deployment.md#deploy-an-existing-stack).
Native workflows assume the stage's `AWS_PULUMI_DEPLOY_ROLE_ARN`.

### Retained-data teardown

Before removing a stage, drain its Boxes, stop new work, and verify recoverable database backups, Runner data-volume snapshots and required checkpoint objects. Record the physical resource IDs and who will own retained resources after teardown.

Export the current Pulumi stack using the stage backend. Inspect `protect` and `retainOnDelete` for each resource, including EC2 instances, their volume attachments, EBS data volumes and checkpoint buckets.

Change protection for the approved resources in stage configuration and review a full preview. To unprotect an individual resource, approve its exact URN and run `pulumi state unprotect <URN>` on the selected stack.
Check EC2 attachment and delete-on-termination settings and detach volumes that must survive before terminating their instances.

Run `npm run mdeploy -- --stage <stage> --remove --confirm` after preparing the stack. The command checks for protected resources before starting destruction. Pulumi leaves resources with `retainOnDelete` in the cloud, where they continue to incur charges until their owner deletes them.

### Verify

Run the shared [service checks](../deployment.md#verify-the-result), then inspect [Runner outcomes](runners.md).
For a host replacement, inspect the reservation with `npm run runner:update -- --stage <stage> --host <instance-id> --rollout-status`.
Verify a private registry pull, checkpoint capture/import/delete, and EBS expansion before enabling those capabilities in production.

Checkpoint capture requires explicit application enablement.
Disk expansion defaults to enabled; set `RUNNER_DISK_EXPANSION_ENABLED=false` to disable it.
AWS customer-owned domains remain deferred; platform wildcard domains are available.

CloudWatch extracts disk failure and critical-pressure metrics from API JSON logs into an app/stage namespace.
The Runner reachability filter consumes API health-check events. See [security](security.md).

Sources: [native entrypoint](../../mdeploy/pulumi/aws-program.ts), [bootstrap](../../bootstrap/aws/README.md).
