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

| Input                                               | Owner                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| App identity, build artifacts, environment groups   | Committed `mstage.env.json`                                         |
| Cloud, region/project, registry and resource sizing | Ignored `.mstage.config.json`                                       |
| Domains, fleet count, secrets and feature settings  | Encrypted stage environment                                         |
| Container identity                                  | Invocation's `BOXLITE_IMAGE_TAG`                                    |
| Runner release                                      | Workspace `Cargo.toml`, or invocation's `VERSION`                   |
| Runner commit build                                 | `RUNNER_ARTIFACT_SOURCE=build` and `RUNNER_ARTIFACT_REF=<full-sha>` |

See [configuration](../docs/configuration.md) for writing and verifying each input.
`BOXLITE_IMAGE_TAG` accepts a full lowercase SHA or `vX.Y.Z-<sha>` for release images.
The environment describes the desired deployment; setting a tag does not build an artifact.
Use [mbuild](../mbuild/README.md) and the [runner runbook](../docs/runners.md) to prepare it first.

## Hosted GitHub CI Listener

Personal and Organization Apps use separate credentials and webhook URLs. Add
`CI_GITHUB_ORG_APP_CLIENT_ID` and `CI_GITHUB_ORG_APP_SLUG` as ordinary settings
for the Organization App. Its `CI_GITHUB_ORG_APP_PRIVATE_KEY`,
`CI_GITHUB_ORG_WEBHOOK_SECRET` and optional `CI_GITHUB_ORG_APP_CLIENT_SECRET`
use secret refs in both the `api` and `secret` groups, as the Personal App does.
An Organization App requires the Personal App storage anchor and a distinct
client ID. The deployment validates this configuration before infrastructure
changes; configuring both Apps still creates one hosted Listener and one account quota.

The API imports the shared TypeScript Listener. Configure its App identity and slug
as ordinary mstage API settings. Configure `CI_GITHUB_APP_PRIVATE_KEY`,
`CI_GITHUB_WEBHOOK_SECRET` and `CI_SECRET_ENCRYPTION_KEY` as secret references.
The committed catalog already places the credentials in both the optional `api`
consumer group and the optional `secret` marker group; no additional enable flag is needed.
A partial CI configuration or plaintext credential channel stops deployment.
Dashboard browser connect additionally uses optional `CI_GITHUB_OAUTH_CLIENT_ID`
and a separate `CI_GITHUB_OAUTH_CLIENT_SECRET` reference. The identity OAuth App
requests only profile and organization-membership reads; the CI Apps keep their
runner permissions. Device Flow and the scheduler do not require identity OAuth.

For a GCP stage, store reference documents rather than secret values:

```bash
npm run mstage env set -- --stage dev CI_GITHUB_APP_CLIENT_ID=YOUR_CLIENT_ID CI_GITHUB_APP_SLUG=YOUR_APP_SLUG CI_GITHUB_OAUTH_CLIENT_ID=YOUR_IDENTITY_OAUTH_CLIENT_ID
npm run mstage env set -- --stage dev --json \
  'CI_GITHUB_APP_PRIVATE_KEY={"address":"projects/PROJECT/secrets/ci-app-private-key/versions/1"}' \
  'CI_GITHUB_WEBHOOK_SECRET={"address":"projects/PROJECT/secrets/ci-webhook/versions/1"}' \
  'CI_SECRET_ENCRYPTION_KEY={"address":"projects/PROJECT/secrets/ci-connect-encryption/versions/1"}' \
  'CI_GITHUB_OAUTH_CLIENT_SECRET={"address":"projects/PROJECT/secrets/ci-identity-oauth-client-secret/versions/1"}'
npm run mstage env list -- --stage dev --select-group api
```

Run these commands from `apps/infra`, replacing the placeholders with existing
secrets. The final command prints configured names. mdeploy grants the API identity
read access to the referenced secrets and emits Cloud Run `secretKeyRef` entries;
the PEM/HMAC/encryption values are not copied into revision configuration or passed
to runner hosts and JIT Boxes. The encryption secret holds base64 for exactly 32
bytes. Keep it stable across replicas while connect attempts are pending.

For browser connect, add the exact `${DASHBOARD_URL}/settings/ci/callback` URL
to the GitHub App; leave wildcard matching and OAuth-during-installation disabled.
Apply the additive CI web-connect migration. For GCP, the API image bundles both
API and Dashboard artifacts; one Cloud Run revision updates both surfaces.
The Dashboard's CI tab starts authorization; merely installing the App does not
establish BoxLite account ownership. Keep the current standalone Listener and its
webhook active until a coordinated hosted cutover can avoid duplicate providers.

Pin secret versions and deploy a new revision when rotating them. The API receives
the resolved values at instance startup; it does not fetch Secret Manager itself.
Cloud Run receives a service-level minimum of one instance and `cpuIdle: false`
only when hosted CI is configured, so scheduling continues outside requests.
This introduces idle instance costs. Other API deployments retain their defaults;
multiple replicas still use the PostgreSQL lease to select one scheduler.

See the [API configuration contract](../../api/README.md#hosted-configuration-and-deployment)
and [Cloud Run secret delivery](https://docs.cloud.google.com/run/docs/configuring/services/secrets).
Provider-input tests do not replace a deployed App/CI acceptance run.

## Runner convergence

Runner hosts retain local box state and are protected against replacement. Boot-image, startup and
attached-disk changes are ignored for existing hosts; binary and unit-environment updates have a separate path.

Updates verify artifact checksums and readiness. Already-converged hosts need no restart;
release downgrade requires the explicit operator command. Follow [GCP runner convergence](../docs/gcp/runners.md)
or [AWS runner convergence](../docs/aws/runners.md) for the update mechanism and its completion boundary.

### Runner process environment

`BOXLITE_RUNNER_ENV` is an optional JSON object in mstage's `runner` environment
group. From `apps/infra`, for example:

```sh
npm run mstage env set -- --stage dev --json 'BOXLITE_RUNNER_ENV={"BOXLITE_EXPERIMENTAL":"nested-virtualization"}'
```

Apply the stage with mdeploy after changing the value. New hosts receive the map
at boot; existing GCP hosts converge through OS Config and AWS hosts through the
existing update payload. Changes restart the Runner process, without rebooting
or replacing the instance. Running boxes are affected by that process restart.
An unchanged map, including reordered keys, causes no environment-driven restart.

Values must be single-line strings; JSON trailing commas are invalid. The map
adds process settings, not guest environment or secret references. Deployment-owned
identity, API, storage, kernel and telemetry keys, direct runner-group settings,
secret names/address keys, and `PATH` cannot be overridden here. The cloud secret
wrappers need the deployment's tool search path. Use the existing
configuration channels. Map values appear in deployment state and host configuration;
use the secret channel for credentials.

Removing a map entry removes its previously managed value; `{}` or removing the
wrapper clears all managed entries. Unrelated settings and file permissions are
preserved. A previously injected duplicate of a newly managed key is replaced
when adopted and does not return after removal. The map grants no capabilities
itself; a setting's effect depends on the deployed Runner's configuration support.

## Cloud implementations

Each stage declares `home`; that field selects credentials, store backend, engine and provider bundle.
There is no repository-wide cloud default. Read the separate [GCP](../docs/gcp/architecture.md) or
[AWS](../docs/aws/architecture.md) architecture and operations guides for resource mappings and network paths.

For the GCP `stage` environment, API, Collector and Registry Proxy declare the Service-level label `stage=stage`.
Backoffice uses this label to scope discovery within the shared dev project; labels do not provide IAM isolation.
These declarations leave revision labels and all other environments unchanged. Service discovery requires deployment and Cloud Asset indexing.

GCP workload service accounts keep the `<appShort>-<stage>-<artifact>-run` identity format and the 30-character limit.
For `stage`, two artifact segments use shorter names:

| Workload | Service account ID | Characters |
| --- | --- | --- |
| Collector | `bl-app-stage-otel-run` | 21 |
| Registry Proxy | `bl-app-stage-registry-run` | 25 |

Other roles and environments retain their existing IDs. Logical resource names, workload roles and IAM references remain attached to the same account resources.
Do not rename existing dev/prod accounts: changing an account ID replaces the identity.

For the pinned GCP provider, Cloud Run container `ports` is a single `{ name, containerPort }` object;
the Proxy and ClickStack backend `healthChecks` fields take the health-check resource's ID directly.
These fields are not arrays, despite their plural names. Kubernetes, firewall and forwarding-rule port lists retain their separate array contracts.
The provider-shape regressions inspect actual constructor inputs; a successful preview must also be checked for type warnings before apply.

## CI orchestration

[mdeploy-all.yml](../../../.github/workflows/mdeploy-all.yml) resolves the requested ref, ensures
its artifacts exist, checks the stage digest, then previews or applies. Its `components` input
selects artifact preparation; it is not a promise that the resource graph targets only those services.

A commit or open PR merge commit is accepted for `dev` and `stage`; both may use candidate workflow branches.
`prod` requires a published release; release dispatches run from `main`.
Stage release images publish into stage; prod selects release images from `source=dev` (default) or `source=stage`.
PR/commit builds cannot promote to prod; prepare and validate the version-qualified stable release images in the chosen source first.
The reusable image workflow and runner build job bind the stage's
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

| Intent               | Effect                                                                          |
| -------------------- | ------------------------------------------------------------------------------- |
| Default              | Apply the resource graph; protected stages require `--confirm`                  |
| `--diff`             | Preview resource changes                                                        |
| `--refresh`          | Reconcile deployment state with the cloud; protected stages require `--confirm` |
| `--remove --confirm` | Remove an unprotected stage; always refused for a protected stage               |
| `--local-env`        | Read ambient environment instead of the encrypted stage store                   |

`--diff`, `--refresh`, and `--remove` are mutually exclusive. All intents check the selected
stage's login requirements. `--local-env` is an explicit diagnostic override, not the ordinary
configuration path; the caller must supply the required inputs.

## Checkpoint archive bucket

GCP creates a dedicated `Checkpoints` resource named `<app>-<stage>-checkpoints`.
Archives use `gs://<bucket>/checkpoints/`; the stack passes this location to the
API as `CHECKPOINT_ARCHIVE_PREFIX` and the same bucket to runner object grants.
The API and runners receive `roles/storage.objectUser` on this bucket alone.
Uniform access and public access prevention are enabled; versioning and soft
delete retention are disabled for this archive bucket.

This bucket is separate from application storage, per-volume buckets and the
infrastructure engine's state/checkpoint bucket. AWS does not enable this archive
capability. Deploy the checkpoint database migration and compatible API/runners
with this storage configuration before enabling capture. The REST API and
capture/import orchestration use this archive path; see the
[API checkpoint contract](../../api/README.md#checkpoint-capture).

## Implementation and validation

- [`src/run.ts`](src/run.ts): input parsing, login and protected-stage guards.
- [`src/deploy.ts`](src/deploy.ts): the cloud-specific engine/backend bundle.
- [`src/config.ts`](src/config.ts): deployment sizing schema.
- [`src/stack-env.ts`](src/stack-env.ts): values supplied to both cloud engines.
- [`stack/index.ts`](stack/index.ts): resource composition.
- [`sst.config.ts`](sst.config.ts) / [`pulumi/program.ts`](pulumi/program.ts): engine entrypoints.

[`stack/clickhouse-retention.ts`](stack/clickhouse-retention.ts) owns the shared retention default
and hour validation for both clouds. The legacy deployment path imports it through
`mdeploy/clickhouse-retention`; mdeploy's own modules use relative imports within the package.
This keeps one retention rule without a dependency from mdeploy back into its enclosing infra project.
The lint configuration permits eager imports of this entrypoint, which has no dependencies,
while keeping mdeploy's CLI entrypoints lazy.
The legacy key-policy contract scans this exported configuration reader alongside the legacy source roots,
so moving the helper preserves its check against the shared store's allowlist.

Run `make test:apps:infra` from the repository root for tooling checks. A passing local test or
preview is not live rollout proof; follow the [deployment verification](../docs/deployment.md#verify-the-result).
