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

## First account registration

Turnstile protection is opt-in: an absent or blank `TURNSTILE_SITEKEY` keeps automatic local
registration and requires no widget settings. To enable it, create a Cloudflare Managed widget
for the actual Dashboard hostname. The API must reach `challenges.cloudflare.com`; the site does
not need Cloudflare CDN proxying. Auth0 continues to authenticate Google, GitHub and email users.

| API setting | Required/default | Delivery |
| --- | --- | --- |
| `TURNSTILE_SITEKEY` | Optional; nonempty enables protection | Ordinary API configuration; public through `/config` when enabled |
| `TURNSTILE_SECRET_KEY` | Required when enabled | Server-side secret |
| `TURNSTILE_EXPECTED_HOSTNAMES` | Required when enabled; comma-separated hostnames without scheme, port or path | Ordinary API configuration; private to the API |
| `TURNSTILE_TIMEOUT_MS` | Positive integer milliseconds; `5000` | Optional API configuration |

The API validates enabled widget settings at startup. `/config` exposes only `turnstile.sitekey`
and the fixed `turnstile.action=signup`; hostname allowlists, timeout and secret remain server-side.
When disabled, `/config` omits `turnstile` and the Dashboard uses the ordinary authenticated flow.
Changes take effect after the API restarts, without rebuilding the Dashboard to change the sitekey.

mdeploy declares the widget settings as optional in `env.selectGroup.api` and marks
`TURNSTILE_SECRET_KEY` in `env.selectGroup.secret`. Seed the credential in the target cloud's
secret store, then write its JSON reference with `mstage env set --json` using the
[secret-reference procedure](../mstage/README.md#secret-references). Accepted examples are
`{"address":"arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME"}` and
`{"address":"projects/PROJECT/secrets/NAME/versions/VERSION"}`. ECS resolves the reference through
its secret channel; Cloud Run uses `secretKeyRef`. The credential must not be a plaintext API
environment value. Confirm runtime access to the referenced secret before rolling out the API.

With no sitekey, mdeploy omits all widget settings and does not inject an unused secret reference.
For the legacy SST path, enabling protection requires the stage-scoped `TURNSTILE_SECRET_KEY` via `sst secret set`, using
stdin for the value. Its ordinary settings belong in the bootstrap `.env`/stage configuration;
the secret does not. Use `.env.example` for the names and defaults.

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

## Runner disk alarms

`deploy.alarms` in every stage declaration requires `runnersDiskExpansionFailing` and
`runnersDiskPressureCritical`. These alarms are not defaulted: a deploy that silently lacked
notice of a failing disk expansion or critical disk pressure would be harder to recover from
than one that stops before creating resources.

```json
{
  "runnersDiskExpansionFailing": { "threshold": 3, "periods": 1 },
  "runnersDiskPressureCritical": { "threshold": 1, "periods": 2 }
}
```

If deployment reports that a stage must set either alarm, add both to `deploy.alarms` in
`.mstage.config.json`, run `npm run mstage config put -- --stage STAGE_NAME`, and verify the
GitHub Environment copy with `npm run --silent mstage config get -- --stage STAGE_NAME`.

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

`CHECKPOINTS_ENABLED` is an optional `api` key. After deploying a compatible runner,
store `CHECKPOINTS_ENABLED=true` and redeploy the API to enable managed checkpoints.
The API group forwards this value on AWS and GCP; an omitted key or `false` keeps
admission disabled. Changing the stage store alone does not update an existing API revision.

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

## Platform subdomain minimum length

Set `PLATFORM_SUBDOMAIN_MIN_LENGTH` in the stage store, then redeploy the API
with mdeploy using the updated manifest. Run from `apps/infra`:

```bash
npm run mstage env set -- PLATFORM_SUBDOMAIN_MIN_LENGTH=1 --stage dev
```

Use `--confirm` when writing a protected stage. Updating the store alone does
not update a running API. The optional API group delivers this value on both
AWS and GCP; unset or blank values keep the API default of `5`.

The value must be an integer from `1` to `63`; invalid values stop API startup.
For example, `1` permits a new single-character name such as `x` beneath the
configured platform domain, subject to the existing format, reserved-name,
availability and organization quota checks. The minimum applies only to new
claims; existing names remain usable if it increases. The dashboard reads the
minimum from the API, so no frontend setting is needed.

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
