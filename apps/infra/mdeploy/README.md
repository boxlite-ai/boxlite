## TL;DR

mdeploy selects the stage's cloud engine, validates its inputs, and applies one shared BoxLite resource model.

# mdeploy reference

[Infrastructure index](../README.md) · [Deployment walkthrough](../docs/deployment.md) · [Architecture](../docs/architecture.md)

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
AWS bootstrap and mdeploy currently use different app names; read the
[AWS compatibility boundary](../bootstrap/aws/README.md#aws-mdeploy-compatibility) before a transition.

## Inputs

| Input | Owner |
| --- | --- |
| App identity, build artifacts, environment groups | Committed `mstage.env.json` |
| Cloud, region/project, registry and resource sizing | Ignored `.mstage.config.json` |
| Domains, fleet count, secrets and feature settings | Encrypted stage environment |
| Container identity | Invocation's `BOXLITE_IMAGE_TAG` |
| Runner release | Workspace `Cargo.toml`, or invocation's `VERSION` |
| Runner commit build | `RUNNER_ARTIFACT_SOURCE=build` and `RUNNER_ARTIFACT_REF=<full-sha>` |

See [configuration](../docs/configuration.md) for writing and verifying each input.
`BOXLITE_IMAGE_TAG` accepts a full lowercase SHA or `vX.Y.Z-<sha>` for release images.
The environment describes the desired deployment; setting a tag does not build an artifact.
Use [mbuild](../mbuild/README.md) and the [runner runbook](../docs/runners.md) to prepare it first.

## Runner convergence

Runner hosts retain local box state and are protected against replacement. Boot-image/startup
changes are ignored for existing hosts; binary and unit-environment updates have a separate path.

Updates verify artifact checksums and readiness. Already-converged hosts need no restart;
release downgrade requires the explicit operator command. Follow [GCP runner convergence](../docs/gcp/runners.md)
or [AWS runner convergence](../docs/aws/runners.md) for the update mechanism and its completion boundary.

## Cloud implementations

Each stage declares `home`; that field selects credentials, store backend, engine and provider bundle.
There is no repository-wide cloud default. Read the separate [GCP](../docs/gcp/architecture.md) or
[AWS](../docs/aws/architecture.md) architecture and operations guides for resource mappings and network paths.

## CI orchestration

[mdeploy-all.yml](../../../.github/workflows/mdeploy-all.yml) resolves the requested ref, ensures
its artifacts exist, checks the stage digest, then previews or applies. Its `components` input
selects artifact preparation; it is not a promise that the resource graph targets only those services.

A commit or open PR merge commit is accepted for `dev`. `prod` requires a published release;
release dispatches run from `main`. The reusable image workflow and runner build job bind the stage's
GitHub Environment. Check actual environment reviewers and branch protections separately: source
configuration is not evidence of the live GitHub settings.

Use the [deployment walkthrough](../docs/deployment.md#deploy-through-github-actions) for commands and the
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

- [`src/run.ts`](src/run.ts): input parsing, login and protected-stage guards.
- [`src/deploy.ts`](src/deploy.ts): the cloud-specific engine/backend bundle.
- [`src/config.ts`](src/config.ts): deployment sizing schema.
- [`src/stack-env.ts`](src/stack-env.ts): values supplied to both cloud engines.
- [`stack/index.ts`](stack/index.ts): resource composition.
- [`sst.config.ts`](sst.config.ts) / [`pulumi/program.ts`](pulumi/program.ts): engine entrypoints.

Run `make test:apps:infra` from the repository root for tooling checks. A passing local test or
preview is not live rollout proof; follow the [deployment verification](../docs/deployment.md#verify-the-result).
