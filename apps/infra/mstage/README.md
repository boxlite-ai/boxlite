## TL;DR

mstage resolves stage identity, manages encrypted configuration, and repairs deployment state without loading the resource graph.

# mstage reference

[Infrastructure index](../README.md) · [Configuration guide](../docs/configuration.md) · [Deployment](../docs/deployment.md)

## Invocation

Run from `apps/infra`; put tool options after npm's `--` separator.

```bash
npm run mstage <module> <command> -- [--stage <stage>] [options]
npm run mstage env -- --help
npm run mstage login -- --stage dev
npm run mstage login gcp -- --stage dev --force
npm run mstage aws whoami -- --stage dev
npm run mstage aws exec -- --stage dev -- gcloud storage ls
```

The historical `aws` module name covers identity and command execution on either cloud.
`whoami` reports the resolved tenant/principal; `region` resolves configuration without a cloud call.
`exec` passes the selected identity into a child command after a second `--`.
`--force` signs in; `--logout` signs out. They cannot be combined.

## Configuration contract

[`mstage.env.json`](../mstage.env.json) declares application identity, artifacts and export groups.
The ignored `.mstage.config.json` declares stages. The [configuration guide](../docs/configuration.md)
explains the fields, storage boundaries, protected operations, and CI transport.

```bash
npm run mstage config put -- --stage dev
npm run --silent mstage config get -- --stage dev
```

`put` reads a piped declaration or the local file and writes one stage to its GitHub Environment.
`get` reads the supplied environment variable before the file and emits a stage-keyed JSON object.
Neither command needs cloud credentials; GitHub writes require an authenticated `gh` session.

| Module | Responsibility |
| --- | --- |
| `login` | Check or establish declared provider sessions |
| `aws` | Resolve stage identity/region or execute under that identity |
| `config` | Carry a stage declaration to/from its CI environment |
| `env` | Read/write the encrypted stage environment |
| `state` | Recover a stopped deployment's lock/checkpoint |

mstage does not build artifacts or declare resources. Those belong to
[mbuild](../mbuild/README.md) and [mdeploy](../docs/mdeploy.md).

## The stage environment

| Home | Bootstrap record | Encrypted values | Encryption key |
| --- | --- | --- | --- |
| AWS | SSM `/sst/bootstrap` | S3 `secret/<app>/<stage>.json` | SSM `/sst/passphrase/<app>/<stage>` |
| GCP | Secret Manager `mstage-bootstrap` | GCS `secret/<app>/<stage>.json` | Secret Manager `mstage-passphrase-<app>-<stage>` |

Both backends use AES-256-GCM. Bootstrap must establish the bucket and key first.
A shared storage format does not migrate cloud resources or rewrite cloud-specific values.
The store is one object: serialize writers to avoid lost updates. SST `_fallback` values are not merged.

```bash
npm run mstage env list -- --stage dev
npm run mstage env list -- --stage dev --select-group deploy
npm run mstage env list -- --stage dev --values
npm run mstage env list -- --stage dev --select-group deploy --json
npm run mstage env versions -- --stage dev
npm run mstage env list -- --stage dev --version '<version-id>'
npm run mstage env set -- PORT=8080 TIMEOUT=30 --stage dev
npm run mstage env set -- PRIVATE_KEY --stage dev < /secure/path/key.pem
npm run mstage env set -- --stage dev --select-group deploy < /secure/path/stage.json
npm run mstage env set -- --stage dev --digest
npm run mstage env digest -- --stage dev
npm run mstage env del -- OLD_KEY --stage dev
```

`list` prints names by default. `--values` and `--json` expose values; avoid them in shared logs.
A lone key reads stdin including trailing newlines. With no positional arguments, `set` reads a
JSON object; strings stay strings and structured values become JSON text. `null` is refused.
`--json` instead marks positional `KEY=VALUE` values as JSON documents. Ordinary assignments
expand supported escapes; JSON input is parsed once without a second escape pass.

`--select-group` filters writes to a declared group's keys and reports dropped keys.
Missing required group members fail on read. `set` and `del` need `--confirm` on protected stages.
Use a fresh export: older exports that split comma-containing strings into arrays do not preserve
those strings when imported with the current JSON semantics.

## Secret references

The optional `env.selectGroup.secret` group marks values as secret addresses. A key must also
belong to a consumer group. The BoxLite app manifest currently declares no such reference group.
Consumers must explicitly deliver references through their platform's secret mechanism.

Supported address shapes are `{"address":"arn:aws:ssm:REGION:ACCOUNT:parameter/NAME"}`,
`{"address":"arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME"}`, or
`{"address":"projects/PROJECT/secrets/NAME"}`. The stage's home determines the accepted cloud.
GCP addresses omit a version. Write with `--json`; plaintext where an address belongs is refused.

Creating the secret and granting runtime read access remain the owner's responsibility.
On AWS, check execution-role policy, permissions boundary and any customer-managed KMS key;
on GCP, check the runtime service account's access. mdeploy refuses references in groups it
would consume directly as values. See [`src/environment/secret-address.ts`](src/environment/secret-address.ts).

## Fingerprints and group reads

`env set --digest` certifies the configured group, either alone or alongside positional assignments.
With `--digest` and no assignments, stdin is not imported: load a batch first, inspect it, then
recompute the fingerprint. `env digest` exits nonzero for a missing or mismatched digest.
`env del --digest` refuses deletion of any member of the certified group; it does not recompute it.

Programs import `selectGroup` from `mstage/select-group` and call
`await selectGroup({ group: 'api', stage: 'dev' })`. It returns the declared values without modifying
`process.env`. An optional `versionId` pins a stored version and fails if that version is unavailable.
The caller chooses where to deliver the result. Sources: [group selection](src/environment/select-group.ts)
and [CLI handlers](src/cli/handlers/env.ts).

## State recovery

A stopped deployment can leave both a lock and pending operations. Confirm that no deployment is
still running before recovery; removing its lock would permit concurrent state writers.

```bash
npm run mstage state unlock -- --stage dev
npm run mdeploy -- --stage dev --refresh
npm run mdeploy -- --stage dev --diff
```

Prefer refresh to reconcile cloud state before the next apply. If checkpoint repair is necessary,
`npm run mstage state edit -- --stage dev` opens `$EDITOR` (default `vim`). Inspect the actual
resource outcome before changing pending operations; deleting a record does not undo a cloud action.
Protected-stage recovery requires `--confirm`.

| Home | Checkpoint | Lock |
| --- | --- | --- |
| AWS | `app/<app>/<stage>.json` | `lock/<app>/<stage>.json` |
| GCP | `.pulumi/stacks/<app>/<stage>.json` | Pulumi lock objects for that stack |

`unlock` reports the holder and rechecks before deleting. `edit` refuses a held lock, malformed
checkpoint, or detected concurrent change, and preserves a rejected local edit for inspection.
These read-back checks are not an atomic transaction. Source: [`src/state/store.ts`](src/state/store.ts).

## Credentials

Check the intended stage first:

```bash
npm run mstage login -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run mstage aws region -- --stage dev
```

| Provider | Credential path |
| --- | --- |
| GCP | Both gcloud CLI credentials and Application Default Credentials (ADC) |
| AWS | SDK default credential chain, optionally followed by stage role assumption |
| GitHub | Existing `gh` CLI session |
| Auth0 | Existing `auth0` CLI session for the active tenant |

`login --stage` evaluates that stage's requirements. Without a stage it merges all declared
requirements. In an interactive terminal it can offer sign-in; CI reports missing sessions and exits.
`--force` explicitly signs in first. On GCP it runs `gcloud auth login` and
`gcloud auth application-default login`; logout revokes both credential stores.

AWS callers can select a profile through the normal SDK environment, not a separate mstage profile
flag. Child processes receive resolved credentials so tools that cannot read the original login
session can still operate. An identity check establishes who the credentials represent, not whether
they have permission for every subsequent operation.

| Value | Precedence |
| --- | --- |
| Stage | `--stage`, then `MSTAGE_STAGE`, otherwise error |
| App | `--app`, then `MSTAGE_APP`, then `mstage.env.json` |
| Region | `--region`, stage declaration, `AWS_REGION`, `AWS_DEFAULT_REGION`, otherwise error |
| AWS role | `--role-arn`, `MSTAGE_AWS_ROLE_ARN`, stage declaration |
| Role session name | `--role-session-name`, `MSTAGE_AWS_ROLE_SESSION_NAME`, then `mstage` |

For unattended Auth0 tools, `signInWithClientCredentials` from `mstage/auth` accepts
`('auth0', { domain, clientId, clientSecret })`. It replaces the CLI session for that tenant;
credential retrieval and access policy belong to the caller.

## Development and validation

Run `make test:apps:infra` from the repository root. It installs missing infra dependencies,
typechecks tooling, and runs the infrastructure suites including mstage, mbuild and mdeploy.
The separate `make test:apps:infra-config` installs the SST platform before its broader typecheck.

Public package entrypoints are declared in [`package.json`](package.json). Start with
[`src/cli/run.ts`](src/cli/run.ts), [`src/config/load.ts`](src/config/load.ts),
[`src/home.ts`](src/home.ts), and [`src/auth/sessions.ts`](src/auth/sessions.ts).
