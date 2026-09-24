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

## What a stopped deploy leaves

A deploy locks the stage, rewrites the deployment checkpoint as it goes, and
drops the lock on its way out. One that is killed never reaches the last step: a
cancelled workflow, an expired runner or a closed laptop leaves the lock behind
and leaves the operations it was in the middle of recorded as pending. The next
deploy then refuses twice over — the stage looks busy, and Pulumi will not plan
over operations whose outcome nobody observed.

```bash
npm run mstage state unlock -- --stage dev   # the lock nobody released
npm run mstage state edit -- --stage dev     # the operations nobody finished
```

`unlock` prints what held the lock — the command, the run id and when it was
taken — before removing it, because the one thing it cannot tell is whether that
deploy is still running somewhere. It then reads the lock again and removes it
only if it is still the one that was named, so a deploy that starts in between
does not lose the lock it is holding. `edit` opens the checkpoint in `$EDITOR`
(`code -w` and the rest work; the default is vim, as it is in SST), says how many
pending operations are in it first, and refuses to open while a lock is held.
Deleting the entries from `checkpoint.latest.pending_operations` is the edit
that unsticks a stage.

What comes back is checked before it is stored, and three things can refuse it.
A file that no longer parses, or that lost the `{"version":3,"checkpoint":{…}}`
wrapper, would describe a stage with no resources rather than the stage as it is.
A lock taken while the editor was open means a deploy started meanwhile. And the
stored bytes are compared against the ones the editor was given, because a
deploy can take the lock and drop it again inside one editor session. On any of
the three the copy is kept and named: that edit is the operator's work and the
only place it exists. The comparison is not atomic and is not sold as one — it
closes the window that is minutes long, not the one that is milliseconds long.

Both act on the engine's own objects, and which those are is the backend's
business rather than the command's. On an AWS home they are SST's —
`app/<app>/<stage>.json` and `lock/<app>/<stage>.json`, beside the store's
`secret/<app>/<stage>.json` — and these do what `sst unlock` and `sst state edit`
do. On a GCP home the engine is Pulumi itself, which keeps its checkpoint at
`.pulumi/stacks/<app>/<stage>.json` and its locks as a _directory_ of files, one
per operation holding the stage; `unlock` refuses rather than guessing when it
finds more than one, and removes every one of them when it acts.

They are here rather than run through either CLI because both have to load a
stack config to do it, and which stack a repository deploys is that repository's
business; the objects are ones mstage already reads.

Clearing a pending operation is not the same as knowing what became of the
resource it names. The operation was interrupted, so the cloud may hold something
the checkpoint does not, or the reverse. The edit makes a stage deployable again;
a refresh is what makes it accurate, and it belongs before the next deploy.

## Credentials

Sign in however this machine signs in — `aws login`, `aws sso login`, whatever —
and mstage picks up the result. It resolves through the AWS SDK's default
credential chain and nothing else: no `--profile`, no `MSTAGE_AWS_PROFILE`, no
profile field in any config, and no translation of the SDK's errors. A
failure surfaces exactly as the SDK reported it.

mstage does not second-guess which tenant the chain reaches. `aws whoami`
prints the tenant and principal it found — an account and an ARN on AWS, a
project on GCP — and that is the way to check before spending anything; `aws
region` calls nothing at all, resolving the region locally from the table below.

`mstage login` applies the same rule to GitHub and Auth0 — it reads the session
`gh auth login` and `auth0 login` left behind, and repeats those CLIs' own
message when there isn't one. All four providers are documented in `--help`
whether or not this repository declares them, because mstage is shared and does
not define the set; naming one no stage declares is refused,
and a missing session for a declared, required provider is what fails the
command.

It signs nobody in unless asked. `-f` / `--force` runs a full sign-in first —
`aws login`, `gcloud auth login` and `gcloud auth application-default login`,
`gh auth login`, `auth0 login` — for whichever provider was named, or for every
one this repository declares when none was, and then reports the session that
now exists. `--logout` ends a session instead of checking it; asking for both at
once is refused. Those commands prompt or open a browser, so they inherit the
terminal: where there is a terminal and a required provider is not ready, mstage
offers to run the sign-in and re-checks the result rather than trusting the exit
status. Where there is none — CI — it reports and exits.

`--stage` narrows what is required to the cloud that stage lives in. Without it
every declared provider is required, because `mstage login` on its own asks
whether this checkout can work at all. With it, a cloud that is not that stage's
`home` is still checked and reported but no longer fails the command: a
repository with stages in both clouds declares both, and reading that
repository-wide is what let an expired AWS session refuse a GCP deploy on a
machine that needed no AWS credential to perform it. Only the clouds narrow —
GitHub and Auth0 are nobody's home, and stay required wherever they are
declared.

GCP takes two sign-ins, run in order. gcloud keeps two credentials and this
repository authenticates from both: the CLI's own session, which every plain
`gcloud` subcommand uses — `iam/bootstrap` and mbuild's Artifact Registry calls
spawn those — and Application Default Credentials, which the Google SDKs and the
Pulumi provider resolve. `gcloud auth login` writes the first,
`gcloud auth application-default login` the second, and `mstage login` proves
both can mint a token, naming whichever one is stale. Either alone leaves the
other at whatever it was, which reported a ready session and then failed the
first `gcloud projects describe` a bootstrap ran.

`auth login --update-adc` looks like the one command that covers both, and is
the wrong fix: it writes ADC through a path that omits `quota_project_id`, so
the SDKs and the Pulumi provider would send no `x-goog-user-project`, and a
token mint succeeds either way — nothing here would notice. `auth/sessions.ts`
cites where gcloud decides that. The cost is two browser round-trips for one
`mstage login`, accepted over a credential that is present, mints, and then
bills or refuses somewhere else.

`--logout` runs two commands there for the same reason: `gcloud auth revoke`
revokes the account and leaves the ADC file behind, `gcloud auth
application-default revoke` deletes that file and leaves the account. Both run
even if the first fails, because a sign-out that ends one of two credentials is
the state this pair exists to avoid.

Where a person cannot answer a prompt, `signInWithClientCredentials` signs in as
an application instead. The Auth0 CLI supports both modes and behaves the same
afterwards, so `auth0 api …` works either way:

```js
import { signInWithClientCredentials } from 'mstage/auth'

signInWithClientCredentials('auth0', { domain, clientId, clientSecret })
```

Where those credentials come from is the caller's problem, not mstage's. On this
platform they live in the stage's secret store, which cannot be read before AWS
credentials exist — so that read has to follow a successful `login aws`, and the
machine login follows the read. The resulting session replaces whatever session
the CLI held for that tenant, which on a personal machine costs the operator
their interactive one.

`-f` must sit to the right of the `--`: npm owns `-f` as its own `--force`, and
takes it silently otherwise. mstage detects that and says so.

`resolveIdentity` passes the credential _provider_ through rather than a resolved
key triple, so short-lived sources keep refreshing. Child processes are the
exception — they get the resolved triple with every other AWS variable cleared.
On this platform that is load-bearing: `aws login` writes `login_session`, which
the AWS CLI and the JS SDK understand but the Go SDK behind SST and Pulumi does
not, so a Go tool started from such a shell finds nothing. Resolving in JS and
passing the result down is what lets `sst deploy` run at all.

| Value          | Precedence                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| `stage`        | `--stage` › `MSTAGE_STAGE` › error                                                     |
| `app`          | `--app` › `MSTAGE_APP` › `mstage.env.json`                                             |
| `region`       | `--region` › the stage's declared region › `AWS_REGION` › `AWS_DEFAULT_REGION` › error |
| `role`         | `--role-arn` › `MSTAGE_AWS_ROLE_ARN` › the stage's declared role                       |
| `session name` | `--role-session-name` › `MSTAGE_AWS_ROLE_SESSION_NAME` › `mstage`                      |

An unresolvable region is an error rather than a silent `us-east-1`
(`aws.go:88`, `aws.go:108`). The one exception is `mstage login`, which has no
stage and where the region only picks an STS endpoint. The session name is only
used when a role is being assumed, and only names that session in CloudTrail.

## Tests

```bash
cd apps/infra && npm install
npm run test:mstage
npm run test:mdeploy
npm run typecheck --prefix mstage
```

These are not part of the repository-root `npm test`, because `apps/infra` is
not a root workspace and its dependencies are installed separately. Running them
in CI needs a step that installs `apps/infra` first; there is none yet, so
nothing runs these except a person.
