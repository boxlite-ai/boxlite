## TL;DR

Keep stage declarations in the ignored config file and application values in the encrypted stage store.

# Configuration and secrets

[Infrastructure index](../README.md) · [Deployment](deployment.md) · [mstage reference](../mstage/README.md)

## Configuration ownership

| Location | Owns | Committed? |
| --- | --- | --- |
| [`mstage.env.json`](../mstage.env.json) | App identity, build artifacts, required/optional environment groups, digest policy | Yes |
| `.mstage.config.json` | Stage cloud, region/project/zone, login requirements, registry, scan policy, resource sizing and protection | No |
| Encrypted stage store | Domains, feature settings, API keys and application secrets | No |
| GitHub Environment variable | One stage declaration for CI, named `BOXLITE_MSTAGE_BOXLITE_APP_CONFIG` | No |
| Bootstrap `.env` | Input to the retained AWS bootstrap/deployment path | No |

There is no separate `mbuild.config.json` or `mdeploy.config.json`. Both tools read the two mstage files.
The loader walks up from the working directory; `MSTAGE_ENV_CONFIG` and `MSTAGE_CONFIG` can name explicit paths.
Use the [checked-in example](../.mstage.config.example.json) as a starting point, not as a live inventory.

## Declare a stage

Copy `.mstage.config.example.json` to `.mstage.config.json` and edit the intended stage.
The example includes AWS `dev`/`prod` and GCP `dev2`; stage names do not select a cloud by themselves.
The manual GitHub workflow accepts `dev` and `prod`, so use one of those names for a stage deployed through it.

| Field | Meaning |
| --- | --- |
| `home` | Required: `gcp` or `aws` |
| `region` | Deployment and registry region |
| `project`, `zone` | GCP project and optional VM zone; choose a zone supporting the configured machine family |
| `login` | Required/optional provider sessions for this stage |
| `registry` | `artifact-registry` on GCP or `ecr` on AWS, repository and tag policy |
| `scan` | Blocking severities and timeout for the registry's post-push image scan; `blockOn: "DISABLED"` explicitly disables that gate. mbuild's pre-build `yarn npm audit --severity high` of production dependencies still runs, so a high advisory blocks the build on every stage |
| `protect` | Requires confirmation for protected operations; mdeploy refuses removal |
| `promoteFrom` | Source stage whose artifacts bootstrap grants this stage access to |
| `roleArn` | Optional AWS role to assume after resolving ambient credentials |
| `deploy` | Database, cache, storage, ClickHouse, runner and alarm settings consumed by mdeploy |

Do not store passwords or API keys in this declaration: CI carries it as a variable, not a secret.
AWS account identity comes from resolved credentials. GCP project identity is declared explicitly.
`promoteFrom` does not copy configuration or promote artifacts during an ordinary deploy.

## Runner sizing

`deploy.runners` in the stage declaration requires `size` (`small`, `medium` or `large`) and
`rootDiskGb`. GCP also accepts optional `dataDiskGb` for a new runner's separate data disk:

```json
{
  "size": "large",
  "rootDiskGb": 100,
  "dataDiskGb": 2048
}
```

Disk values are whole GiB from 20 through 4000. Omitting `dataDiskGb` keeps the 200 GiB default;
the IOPS and throughput presets still come from `size`. AWS keeps box state on the root disk and
rejects `dataDiskGb`; configure `rootDiskGb` there.

On GCP, sizing applies at creation. Existing hosts retain their recorded machine types and disk sizes,
so a fleet can keep smaller hosts while new runners use `large` and a 2 TiB data disk. Updating these
settings does not resize existing GCP hosts. `RUNNERS` in the encrypted stage store controls the fleet
count; see [scale out](runners.md#scale-out).

Keep the stage declaration and its GitHub Environment copy synchronized with `mstage config put`.
After out-of-band resizing, refresh deployment state before previewing or applying: Pulumi's
[`ignoreChanges`](https://www.pulumi.com/docs/iac/concepts/resources/options/ignorechanges/#how-ignorechanges-works)
uses recorded state, not an automatic live read.

## Set application values

Run commands from `apps/infra` after [bootstrap](deployment.md#bootstrap-a-stage).
Names are safe to inspect; `--values` and `--json` reveal stored values.

```bash
npm run mstage env list -- --stage dev
npm run mstage env list -- --stage dev --select-group deploy
npm run mstage env set -- STACK_DOMAIN=dev.example.com --stage dev --digest
npm run mstage env set -- SMTP_PASSWORD --stage dev < /secure/path/smtp-password.txt
npm run mstage env digest -- --stage dev
```

Use `--confirm` for a protected stage. For a batch, pipe a JSON object into
`mstage env set -- --stage dev`; `--select-group deploy` filters allowed keys. Inspect the
import, then run `env set -- --stage dev --digest` separately to certify it. Serialize edits: the store is a whole-object
read/modify/write operation, so concurrent writers can lose each other's changes.

Groups in `mstage.env.json` define what each consumer may receive:

| Group | Consumer |
| --- | --- |
| `deploy` | Resource graph, public hosts, runner fleet and optional integrations |
| `secret` | Optional marker for JSON secret references delivered to workloads |
| `pulumi` | State passphrase input |
| `api` | API runtime secrets and optional API integrations |
| `proxy` | Proxy authentication and telemetry settings |
| `otel-collector` | Collector authentication |
| `runner` | Runner telemetry overrides |

An array group makes every key required. An object distinguishes `required` from `optional`.
Missing required values fail before deployment. Optional values enable features only when supplied.
The exact key list lives in the manifest; avoid maintaining a second list in a runbook.

## Invitation link lifetime

Set `ORGANIZATION_INVITATION_TTL_SECONDS` in the stage store to change the default
lifetime for new organization invitations, then redeploy the API:

```bash
npm run mstage env set -- ORGANIZATION_INVITATION_TTL_SECONDS=86400 --stage dev
```

The API group delivers this setting on both AWS and GCP. It defaults to `604800`
(seven days); values must be positive whole seconds that produce a valid expiry date.
Invalid values stop API startup. Existing invitations retain their stored deadlines,
and explicit API `expiresAt` / `expires_at` values override the default. Emails show
the exact deadline in UTC. Opening the link joins after sign-in with the invited email.

## Cloud Apps

Cloud Apps use the platform PostgreSQL database and organization resources. Their application
databases use Neon. The API group declares `NEON_API_KEY`, `NEON_ORG_ID`, `NEON_REGION`,
`NEON_PG_VERSION`, `NEON_DATABASE` and `NEON_ROLE`, plus the `CLOUD_APP_*` settings in
`mstage.env.json`. `CLOUD_APP_SESSION_SECRET`, `CLOUD_APP_IDENTITY_PRIVATE_KEY`,
`CLOUD_APP_OAUTH_CLIENTS` and `NEON_API_KEY` are secret references: store their values in the
cloud secret manager and store `{"address":"projects/<project>/secrets/<name>/versions/<version>"}`
in the GCP stage store. OAuth clients are a provider-keyed JSON object in the referenced secret.
Every API and worker revision receives the same pinned secret versions.
The session secret and RSA identity key references are required by the API and secret groups;
preview and apply reject either missing key before creating a revision. Neon credentials remain
optional for Apps that do not use a database.

The deployment injects the stable API address as `CLOUD_APP_PUBLIC_URL`, the stage's user-domain
suffix as `CLOUD_APP_DOMAIN`, and the existing storage bucket as `CLOUD_APP_SOURCE_BUCKET`.
Source objects are stored under `cloud-apps/`; API/worker object permissions cover this prefix.
`CLOUD_APP_SOURCE_BACKEND` selects GCS on GCP and S3 on AWS.

`CloudAppWorker` uses the API image with `CLOUD_APP_PROCESS_ROLE=worker`. On GCP it has one
Cloud Run instance with CPU available between requests and an internal-only endpoint. On AWS
it is an ECS service with one task. The worker starts after the API, shares its database,
cache and secret configuration, and runs with `RUN_MIGRATIONS=false`; the API role applies
schema migrations. Deployment work, schedules and cleanup belong to the worker role.
CPU and memory use the same provider defaults as the API; there is no separate worker sizing.

Publish the API/proxy images with mbuild, inspect the dev mdeploy preview, then apply the
reviewed commit using the shared deployment workflow. The API image includes the CLI,
Supervisor and Agent artifacts; no standalone CP Box deployment is required.

The first App deployment needs a shared random `CLOUD_APP_SESSION_SECRET` and an RSA private
key in `CLOUD_APP_IDENTITY_PRIVATE_KEY` for RS256 end-user identity. Store both as pinned cloud
secret references. A database-backed App also needs the official Neon API key, organization ID
and region; an App OAuth login needs its provider client ID/secret in `CLOUD_APP_OAUTH_CLIENTS`.
These credentials are separate from the dashboard's OIDC client. Source-bucket identity and
permissions are supplied by mdeploy rather than an access key in the stage store.

For a development branch already pushed to the repository, preview its reviewed commit through
the existing federated CI workflow:

```sh
gh workflow run mdeploy-all.yml --ref codex/cloud-app-integration \
  -f stage=dev -f ref=<full-commit-sha> -f components=api -f apply=false
```

CI builds API/proxy artifacts from that commit and uses the dev Environment's cloud identity.
It cannot build an uncommitted local checkout. A local preview instead requires the gcloud CLI,
its signed-in session and application-default credentials, plus the recovered dev stage
declaration. `mstage env list --stage dev` prints configuration names without their values;
use that before deciding which keys need provisioning. An unavailable credential store does
not establish that a key is absent.

## Built-in images

The curated set is the built-in `base`, `python` and `node` plus each `name=ref` entry in
`BOXLITE_SYSTEM_IMAGES`. The dashboard lists all of it under Built-in, and every organization may
start a box from it without admission. Add an entry only for a public image the operator maintains,
hosted off docker.io. Tenants start any other public image by its ref.

To drop the last entry, remove the key and certify the store again. To keep other entries, `env set`
the list without it instead of `env del`.

```bash
npm run mstage env del -- BOXLITE_SYSTEM_IMAGES --stage dev
npm run mstage env set -- --stage dev --digest
npm run mstage env digest -- --stage dev
```

After the next API deploy the name no longer selects the image. It goes through tenant admission like
any other image, read as the Docker Hub ref `docker.io/library/<name>:latest`, and so does the removed
ref. A warm pool row that names either stops filling.

## Fingerprints and versions

`BOXLITE_STAGE_CONFIG_DIGEST` fingerprints the declared `deploy` group. Use `env set --digest`
after an intentional configuration change, then `env digest` to verify it. It detects configuration
mismatches; it does not prove that a live service has rolled out that configuration.

```bash
npm run mstage env versions -- --stage dev
npm run mstage env list -- --stage dev --version '<stored-version-id>'
```

Version availability depends on object retention. A missing requested version is an error; it does
not silently fall back to the latest object. `mstage` does not merge SST `_fallback` values.

## Secret references

mstage can store JSON references to SSM/Secrets Manager on AWS or Secret Manager on GCP.
A reference is an address, not a plaintext secret. Declare reference keys in `env.selectGroup.secret`
and also in a consumer group; the consumer must support resolving them. mdeploy rejects reference
addresses in groups it would spend directly as environment values. See [mstage](../mstage/README.md#secret-references).

## Carry configuration into CI

```bash
npm run mstage config put -- --stage dev
npm run --silent mstage config get -- --stage dev
```

`put` writes that stage's block to the matching GitHub Environment. `get` reads the environment
variable first, then the local file, and emits `{ "dev": { ... } }`. The setup action restores the
ignored file for a job; promotion restores both source and destination declarations.

The AWS bootstrap `.env` and legacy SST manifest belong to the legacy `boxlite` app.
The current manifest names `boxlite-app`; see [AWS compatibility](../bootstrap/aws/README.md#aws-mdeploy-compatibility). Updating an ignored
local file does not update the encrypted stage store or a GitHub Environment until its corresponding
write command runs. Verify each destination after changing it.

Sources: [config loader](../mstage/src/config/load.ts), [environment handlers](../mstage/src/cli/handlers/env.ts),
[deployment configuration](../mdeploy/src/config.ts), [CI setup](../../../.github/actions/setup-infra/action.yml).
