## TL;DR

mdeploy selects the stage's cloud engine, validates its inputs, and applies one shared BoxLite resource model.

# mdeploy reference

[Infrastructure index](../README.md) · [Deployment walkthrough](deployment.md) · [Architecture](architecture.md)

## Execution path

```text
mstage: stage declaration + identity + encrypted environment
  → mdeploy: intent and protection checks
    → GCP: Pulumi → GCP providers → GCS state
    → AWS: SST → AWS providers → SST state
```

The current command is `npm run mdeploy -- --stage <stage>` from `apps/infra`.
The retained `npm run deploy` command uses `deployment/sst.ts` and the legacy `stack/` tree;
its flags, state assumptions and post-deploy checks are not interchangeable with mdeploy's.
Preview any transition against the intended stage before applying it.

## Inputs

| Input | Owner |
| --- | --- |
| App identity, build artifacts, environment groups | Committed `mstage.env.json` |
| Cloud, region/project, registry and resource sizing | Ignored `.mstage.config.json` |
| Domains, fleet count, secrets and feature settings | Encrypted stage environment |
| Container identity | Invocation's `BOXLITE_IMAGE_TAG` |
| Runner release | Workspace `Cargo.toml`, or invocation's `VERSION` |
| Runner commit build | `RUNNER_ARTIFACT_SOURCE=build` and `RUNNER_ARTIFACT_REF=<full-sha>` |

See [configuration](configuration.md) for writing and verifying each input.
`BOXLITE_IMAGE_TAG` accepts a full lowercase SHA or `vX.Y.Z-<sha>` for release images.
The environment describes the desired deployment; setting a tag does not build an artifact.
Use [mbuild](../mbuild/README.md) and the [runner runbook](runners.md) to prepare it first.

## Runner convergence

Runner hosts retain local box state and are protected against replacement. Boot-image/startup
changes are ignored for existing hosts; binary and unit-environment updates have a separate path.

| Home | Update mechanism | Completion boundary |
| --- | --- | --- |
| GCP | One OS Config policy assignment, with a one-host disruption budget | Pulumi completion means the assignment exists; agents converge asynchronously |
| AWS | Per-host SSM commands chained by the resource graph | Commands poll for completion before the next host |

Updates verify the artifact checksum and readiness. Already-converged hosts need no restart;
release downgrade requires the explicit operator command. GCP's `runner:update` changes the
fleet policy, and the next deployment reasserts the checkout's target. It does not support `--host`.
See [runner verification and recovery](runners.md#verify-and-recover) before calling a rollout complete.

## Cloud implementations

Every stage declares its own `home`; there is no repository-wide cloud default.
The same field selects credentials, store backend, deployment engine and provider bundle.

| Component | GCP | AWS |
| --- | --- | --- |
| API and dashboard | Cloud Run, external and internal HTTPS load balancers | ECS Fargate, ALB and CloudFront |
| Box proxy | Two GKE Autopilot replicas behind a TLS proxy load balancer | ECS Fargate behind an NLB |
| Collector | Internal Cloud Run service | ECS Fargate behind an internal ALB |
| Runners | Private GCE N4 hosts with nested KVM and Hyperdisk | EC2 nested-KVM hosts with EBS |
| Database | Private Cloud SQL PostgreSQL | RDS PostgreSQL |
| Cache | Memorystore Redis | ElastiCache Redis |
| Objects and volumes | Cloud Storage; runner volumes use gcsfuse | S3; runtime volumes use the AWS backend |
| Self-hosted ClickHouse | GCE and retained Hyperdisk; PSC publication | EC2 and retained EBS |
| Outbound mail | Configured external SMTP relay | SES sender and SMTP credentials |
| Private-workload internet access | Cloud NAT; Cloud Run uses private-ranges-only VPC egress | EC2 NAT for services; runner public-IP egress |
| Image registry | Artifact Registry | ECR |
| State engine | Pulumi with GCS backend | SST with its AWS backend |

The [architecture graphs](architecture.md) show resource relationships; [networking](networking.md)
explains ingress, private service access and egress. [ClickHouse](clickhouse.md) covers backend modes.

## CI orchestration

[mdeploy-all.yml](../../../.github/workflows/mdeploy-all.yml) resolves the requested ref, ensures
its artifacts exist, checks the stage digest, then previews or applies. Its `components` input
selects artifact preparation; it is not a promise that the resource graph targets only those services.

A commit or open PR merge commit is accepted for `dev`. `prod` requires a published release;
release dispatches run from `main`. The reusable image workflow and runner build job bind the stage's
GitHub Environment. Check actual environment reviewers and branch protections separately: source
configuration is not evidence of the live GitHub settings.

Use the [deployment walkthrough](deployment.md) for commands and the
[workflow reference](../../../.github/workflows/README.md) for the wider CI graph.

## Commands and protection

```bash
npm run mdeploy -- --help
npm run mdeploy -- --stage dev --diff
npm run mdeploy -- --stage dev
npm run mdeploy -- --stage prod --confirm
npm run mdeploy -- --stage dev --refresh
```

| Intent | Effect |
| --- | --- |
| Default | Apply the resource graph; protected stages require `--confirm` |
| `--diff` | Preview resource changes |
| `--refresh` | Reconcile deployment state with the cloud; protected stages require `--confirm` |
| `--remove --confirm` | Remove an unprotected stage; always refused for a protected stage |
| `--local-env` | Read ambient environment instead of the encrypted stage store |

`--diff`, `--refresh`, and `--remove` are mutually exclusive. All intents check the selected
stage's login requirements. `--local-env` is an explicit diagnostic override, not the ordinary
configuration path; the caller must supply the required inputs.

## Implementation and validation

- [`src/run.ts`](../mdeploy/src/run.ts): input parsing, login and protected-stage guards.
- [`src/deploy.ts`](../mdeploy/src/deploy.ts): the cloud-specific engine/backend bundle.
- [`src/config.ts`](../mdeploy/src/config.ts): deployment sizing schema.
- [`src/stack-env.ts`](../mdeploy/src/stack-env.ts): values supplied to both cloud engines.
- [`stack/index.ts`](../mdeploy/stack/index.ts): resource composition.
- [`sst.config.ts`](../mdeploy/sst.config.ts) / [`pulumi/program.ts`](../mdeploy/pulumi/program.ts): engine entrypoints.

Run `make test:apps:infra` from the repository root for tooling checks. A passing local test or
preview is not live rollout proof; follow the [deployment verification](deployment.md).
