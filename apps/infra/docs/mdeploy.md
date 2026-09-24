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
Use [mbuild](../mbuild/README.md) and the [runner runbook](mdeploy.md) to prepare it first.

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
See [runner verification and recovery](mdeploy.md) before calling a rollout complete.

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

## Commands

```
npm run mstage login                                   who am I, on this stage's cloud
npm run mstage env list     -- --stage dev             names only
npm run mstage env list     -- --stage dev --values    values, asked for explicitly
npm run mstage env digest   -- --stage dev             expect: / got:
npm run mstage env set      -- --stage dev --digest KEY=VALUE
npm run mstage state unlock -- --stage dev             what a killed deploy left
npm run mstage config put   -- --stage dev             this stage's block, into its GitHub environment
npm run mstage config get   -- --stage dev             it back, from the variable or the file
npm run mstage state edit   -- --stage dev             the checkpoint, in $EDITOR

npm run mbuild publish -- --tag <sha> --stage dev      build and push every artifact
npm run mbuild promote -- --tag <sha> --from dev --to prod
npm run mbuild verify  -- --tag <sha> --stage dev      does this stage hold this commit

npm run runner:build   -- --stage dev                  build this commit's runner and stage it
npm run runner:build   -- --stage dev --check          is it staged already, without building
npm run runner:promote -- --tag <sha> --from dev --to prod

npm run mdeploy -- --stage dev --diff                  read this before the first apply
npm run mdeploy -- --stage dev
npm run mdeploy -- --stage dev --remove --confirm
```

## What is verified, and what is not

| | |
|---|---|
| mstage — sign-ins, the store, digests, object versions, state repair | 361 tests |
| mbuild — addresses, the publish sequence, the scan gate, the workflow | 64 tests |
| mdeploy — both configs, the environment, the wiring, both bundles | 211 tests |
| the incumbent stack and its release guards, plus `bootstrap/gcp.ts` | 533 tests |
| mstage, mbuild **and mdeploy** typecheck | `tsc` clean, without `sst install` |
| every GCP provider, applied | `dev` and `prod`, in `us-east5` |

`mdeploy` being inside the typecheck is the one place this diverges from the
repository the pattern came from, where it was left outside. `globals.d.ts`
declares what both engines inject, so a contract that a provider stopped
satisfying is a compile error rather than a runtime one. What it does not check
is a resource argument's spelling — that needs the providers' own types, and the
file says so.

## What is left

- **A person's own grants.** `bootstrap/gcp.ts` creates everything an identity
  needs beyond the project — the enabled APIs, the state bucket, the workload
  identity pool, the deployer and publisher service accounts, the Artifact
  Registry repository — and wires `GCP_WORKLOAD_IDENTITY_PROVIDER`,
  `GCP_DEPLOYER` and `GCP_IMAGE_PUBLISHER` into GitHub the same way the AWS
  half wires its own role ARN. `DEPLOYER_ROLES` is what CI federates into; a
  *local* deploy runs as the person's application default credentials and holds
  none of it, so the first local apply fails on whichever role that person
  lacks — `roles/servicenetworking.networksAdmin`, for the Private Service
  Access peering, is the one it reaches first. Impersonating the deployer
  instead of granting the person is the shape this should take. Still manual
  either way: the project and its billing account, which no bootstrap can
  create.
- **Building the images on a workstation.** `mbuild publish` builds locally, and
  on Apple Silicon the api image cannot be built at all: colima's VM is aarch64
  with no buildx, and under QEMU `cpu-features`' gyp build segfaults compiling
  its own sources. `DOCKER_DEFAULT_PLATFORM=linux/amd64` is enough for a
  tsc-only image and not for this one. Until mbuild can hand the build to
  something amd64, a workstation publishes through Cloud Build into the same
  repository, at the addresses `addressesFor` resolves.
- **Retiring the incumbent.** `deploy-infra.yml`, `deploy-release.yml` and
  `build-apps-api-image.yml` still run. Two publishers writing immutable tags
  into one repository is a race that reads as a broken build, so retiring them
  is the step after the first green `mdeploy` dispatch.
- **The application on GCP.** Deploying the stack is not the same as running on
  it: the API's object-storage client reaches for STS, and the runner's volume
  mount is Mountpoint for S3. The deploy is portable ahead of the thing it
  deploys.
