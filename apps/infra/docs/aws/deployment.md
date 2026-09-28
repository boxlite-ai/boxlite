## TL;DR

Choose the intended AWS deployment path before bootstrap; legacy and current app names have different prerequisites.

# Deploy BoxLite on AWS

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Prerequisites

| Provide | Requirement |
| --- | --- |
| Account | IAM, SSM and bootstrap permissions |
| Region and capacity | ECS/RDS/Redis services and nested-KVM EC2 capacity |
| Local tools | Node.js 22+, Git, gh and AWS CLI |
| Build tools | Docker/buildx when publishing locally |
| DNS and identity | Cloudflare zone/token and an OIDC issuer, SPA client and API audience |

Run `make _ensure-infra-deps` from the repository root, then work from `apps/infra`.
Declare `home: "aws"`, region, optional role, registry, protection and resource sizing in
`.mstage.config.json`; account identity comes from resolved credentials. See [configuration](../configuration.md).

## Bootstrap and choose the deployment path

Bootstrap prepares the legacy `boxlite` app; current mdeploy uses `boxlite-app`.
Read [the compatibility check](../../bootstrap/aws/README.md#aws-mdeploy-compatibility)
before treating bootstrap as preparation for a current mdeploy stage.

For the retained legacy path, copy `.env.example` to `.env` and fill reviewed non-secret settings:

```bash
npm run mstage login -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run bootstrap -- --stage dev
npm run mstage config put -- --stage dev
```

Bootstrap reconciles IAM boundaries, the GitHub OIDC role, ECR and the runner artifact bucket;
it sets GitHub account/region and Cloudflare credential inputs and imports reviewed stage settings.
It does not deploy the application or prove health. Supply application secrets, including
`OIDC_CLIENT_ID`, through the store for the selected app; do not assume the two app names share state.
Use `--repo owner/name` for an explicit GitHub target and numeric user IDs for `--reviewers`.
Verify the live GitHub Environment protections after bootstrap.

For an independently prepared mdeploy stage, follow [configuration and digest handling](../configuration.md),
then the shared [CI](../deployment.md#deploy-through-github-actions) or
[local preview/apply](../deployment.md#deploy-an-existing-stack) commands. Its engine is SST.

## Retained legacy AWS deployment

AWS bootstrap currently prepares the legacy `boxlite` app. mdeploy's AWS app is `boxlite-app`;
its state, runtime-boundary and artifact prerequisites are different. Read the
[AWS compatibility check](../../bootstrap/aws/README.md#aws-mdeploy-compatibility) before using mdeploy
on an existing AWS stage or assuming a fresh bootstrap prepared it.

`deploy-infra.yml`, `deploy-release.yml`, `build-apps-api-image.yml`, and `npm run deploy`
remain in the repository. They use the legacy SST tree and its own artifact selectors.
Use them only when intentionally operating that path; do not mix their selectors with mdeploy's.

| Legacy operation | Behavior |
| --- | --- |
| `deploy-infra.yml` | Build deployment from a main commit or allowed same-repository PR head |
| `deploy-release.yml` | Deploy existing release artifacts |
| `build-apps-api-image.yml` | Build/promote the legacy API image |
| `npm run deploy -- --stage dev` | Legacy guarded full-stack deploy |
| `--exclude Runner` / `--exclude Api` | Legacy component scopes; excluded leg keeps its prior revision |

The legacy wrapper refuses targeted applies, checks its
[capability manifest](../../deployment/capabilities.json), enforces the
[runner policy pack](../../policies/runner/), and runs its own post-deploy checks.
Its runner updates enter [`scripts/runner-update-binary.mjs`](../../scripts/runner-update-binary.mjs).
Its API fallback can build locally when no published ref is selected; mdeploy expects published images.
See [artifact selection](../../artifacts/source.ts), [scope rules](../../deployment/scope.ts),
[wrapper](../../deployment/sst.ts), and the [workflow reference](../../../../.github/workflows/README.md).
Preview before switching entrypoints; shared logical names are not proof of a no-op transition.

## Verify and recover

Run the shared [service checks](../deployment.md#verify-the-result) and inspect
[SSM runner outcomes](runners.md). Use [networking](networking.md) for ALB/NLB and security groups,
and [ClickHouse](clickhouse.md) for telemetry. The legacy wrapper's automatic smoke checks do not
establish that current mdeploy runs the same checks.

Bootstrap maintains SSM/GitHub Cloudflare credential copies for the legacy path; rotating one
destination does not rotate the others. Follow [common token scope](../deployment.md#cloudflare-api-token).
See [recovery and teardown](../deployment.md#recovery-and-teardown) before modifying state or removing resources.

Sources: [bootstrap policy ownership](../../bootstrap/aws/README.md), [SST entrypoint](../../mdeploy/sst.config.ts).
