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
| `scan` | Blocking severities and timeout; `blockOn: "DISABLED"` explicitly disables the scan gate |
| `protect` | Requires confirmation for protected operations; mdeploy refuses removal |
| `promoteFrom` | Source stage whose artifacts bootstrap grants this stage access to |
| `roleArn` | Optional AWS role to assume after resolving ambient credentials |
| `deploy` | Database, cache, storage, ClickHouse, runner and alarm settings consumed by mdeploy |

Do not store passwords or API keys in this declaration: CI carries it as a variable, not a secret.
AWS account identity comes from resolved credentials. GCP project identity is declared explicitly.
`promoteFrom` does not copy configuration or promote artifacts during an ordinary deploy.

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
| `pulumi` | State passphrase input |
| `api` | API runtime secrets and optional API integrations |
| `proxy` | Proxy authentication and telemetry settings |
| `otel-collector` | Collector authentication |
| `runner` | Runner telemetry overrides |

An array group makes every key required. An object distinguishes `required` from `optional`.
Missing required values fail before deployment. Optional values enable features only when supplied.
The exact key list lives in the manifest; avoid maintaining a second list in a runbook.

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
