# mstage

A modular replacement for the parts of SST this platform actually depends on:
bootstrap discovery, the S3 state and secret store, and the AWS sign-in that all
of them need first.

It exists because reading one secret currently costs an entire SST project
init — discovering `sst.config.ts`, unpacking the embedded platform, installing
`@pulumi/aws`, evaluating the config through esbuild and node — before the four
AWS calls that do the work. `apps/api/Dockerfile` warms that machinery at image
build time purely to make `sst secret list` runnable inside a container.

## Invocation

Run from `apps/infra`, which owns this tool. Nothing is wired into the
repository root.

```
npm run mstage <module> <command> -- [--stage <stage>] [options] [-- <inner command>]
```

Everything to the right of the first `--` reaches mstage untouched. Everything to
its left belongs to npm, which claims any `--flag` for itself: `--stage dev`
written there becomes `npm_config_stage=true` plus a stray `dev` positional,
silently shifting the command. mstage detects that and refuses rather than acting
on an invocation nobody typed.

| Module   | Commands                                 | Needs `--stage` |
| -------- | ---------------------------------------- | --------------- |
| `login`  | `aws`, `gcp`, `github`, `auth0`, or none | optional        |
| `config` | `put`, `get`                             | yes             |
| `aws`    | `whoami`, `region`, `exec`               | yes             |
| `env`    | `list`, `set`, `digest`, `del`           | yes             |
| `state`  | `unlock`, `edit`                         | yes             |

`npm run mstage <module> -- --help` lists what that module accepts, generated from
the same table the dispatcher runs on, so it cannot describe a command that is
not there.

```bash
npm run mstage login
npm run mstage login github
npm run mstage login -- -f            # sign in again first, then report
npm run mstage config put -- --stage dev
npm run mstage config get -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run mstage aws exec -- --stage dev -- gcloud storage ls
npm run mstage env list -- --stage dev
npm run mstage env set -- PORT=8080 TIMEOUT=30 --stage dev
npm run mstage env set -- SHAPE='{"a":"b", "c":"d"}' --stage dev --json
npm run mstage env set -- SMTP_PASSWORD --stage dev < password.txt
npm run mstage env set -- --stage dev --select-group deploy < stage.json
npm run mstage env digest -- --stage dev
npm run mstage env del -- OLD_KEY --stage dev
npm run mstage env del -- A B C --stage dev
npm run mstage state unlock -- --stage dev
npm run mstage state edit -- --stage dev
```

## What is here, and what is not

Everything in mstage is shared: sign-in, stage configuration, the identity a
stage resolves to, and that stage's environment in the state bucket of whichever
cloud `home` names. mstage obtains access, checks it, and reads and writes what a
stage is configured with.

Spending that access is not here, and neither is any account of how it gets
spent. Deployment differs per repository — machine shapes, images, rollout
gates — so each repository has its own tool that asks mstage for a session, an
identity and a stage environment, and then does its own work. In this repository
that is `apps/infra/mdeploy`, which documents itself.

`state` is the edge of that line rather than a crossing of it. mstage does not
deploy, take the lock or write a checkpoint; it repairs the two objects a deploy
that stopped halfway left in the same bucket, which no deploy can do for itself
because it is exactly those objects that stop the next one from starting.

What mstage offers such a tool, besides the modules above, is its own parser: a
caller passes the options it owns (`mdeploy` has `--local-env`) and mstage parses
them for that call without listing them in `mstage --help`. Two tools then read
one command line the same way, and neither advertises the other's switches.

## The two config files

mstage reads two, split by whether a value names somebody's account.

| File                  | Committed | Holds                                        | Found by                           |
| --------------------- | --------- | -------------------------------------------- | ---------------------------------- |
| `mstage.env.json`     | yes       | the app, and what the store may hand out     | walking up, or `MSTAGE_ENV_CONFIG` |
| `.mstage.config.json` | no        | the stages, and what reaching each one costs | walking up, or `MSTAGE_CONFIG`     |

Both live in `apps/infra`, beside the `sst.config.ts` they describe. mbuild
reads the same two — `artifacts` out of the base file, and `registry` and
`scan` out of the very same stage block — so a stage is declared once and both
tools agree about it by construction rather than by a test.

`.mstage.config.json` is gitignored because a stage names a cloud, a project
and a region: one account's coordinates, which differ per checkout and are
nobody else's to inherit. `.mstage.config.example.json` is the committed copy —
it is what a new checkout copies, and what the tests read, so it cannot rot
without something failing.

```json
// mstage.env.json — committed
{
  "app": "boxlite-backoffice",
  "root": "../..",
  "artifacts": {
    "api": { "dockerfile": "apps/api/Dockerfile", "context": "." }
  },
  "env": {
    "selectGroup": {
      "deploy": {
        "required": ["BACKOFFICE_DOMAIN", "BACKOFFICE_STAGE_CONFIG_DIGEST"],
        "optional": ["BACKOFFICE_MAIL_RELAY_HOST"]
      },
      "api": ["BACKOFFICE_OIDC_CLIENT_SECRET"]
    },
    "digest": { "key": "BACKOFFICE_STAGE_CONFIG_DIGEST", "group": "deploy" }
  }
}
```

```json
// .mstage.config.json — not committed
{
  "stages": {
    "dev": {
      "home": "gcp",
      "region": "asia-southeast1",
      "project": "your-first-project",
      "login": {
        "gcp": { "required": true },
        "github": { "required": true },
        "auth0": { "required": false }
      },
      "registry": {
        "kind": "artifact-registry",
        "repository": "boxlite-app-dev-backoffice",
        "immutableTags": true,
        "scanOnPush": true
      },
      "scan": { "blockOn": ["CRITICAL", "HIGH"], "timeoutSeconds": 300 },
      "deploy": {}
    }
  }
}
```

### A stage decides

Everything a stage needs is in its own block, and nothing is inherited from
above it. `home` says which cloud it lives in — declared, never defaulted,
because a repository with stages in two clouds has no one answer. `login` says
what has to be signed in to reach it, and a stage in one cloud names no
credential for the other: read repository-wide, an expired AWS session refused
a GCP deploy on a machine that needed no AWS credential to perform it.
`registry` and `scan` are mbuild's half of the same decision — where the images
go, and what that stage refuses to receive, so prod can be stricter than dev.
`deploy` is mdeploy's half: what shape the stage is deployed into. mstage
checks that it is an object and carries it; every key inside it is mdeploy's to
name and to refuse, and an empty block is the ordinary state of a stage mdeploy
has not been pointed at yet.

The two halves are checked against each other where they are read: a stage
whose `home` is `gcp` must declare a `project`, because Google's clients cannot
be built without one, and must publish to `artifact-registry`, because an ECR
address is one nothing in that project can pull.

`mstage login` without `--stage` merges every stage's `login`, with required
winning over optional: the question there is whether this checkout can work at
all. With `--stage`, only that stage's block answers.

A stage that is not declared is a typo, not a new environment. Stage names
follow SST's own constraint (`[a-zA-Z0-9-]+`) because mstage reads and writes
the same S3 keys. `region`, `project`, `zone`, `roleArn`, `protect`, `login`
and `deploy` are each optional; `home` is not.

`zone` names the zone inside the region a stage's machines are created in, or
is left out for the region's first. It is declarable because that default is
not always available: machine families are stocked per zone, and a region's
first zone answering `stockout` for the family a runner needs is ordinary.
Nothing on AWS reads it, where a subnet carries the zone.

No stage declares an AWS account. The account is whichever one the resolved
credentials belong to, and a caller that has to name it in an ARN reads it back
from `whoami`. Declaring it as well would be a second copy of something already
known, kept in step by hand.

### Carrying a stage to a runner

`.mstage.config.json` is not committed, so a runner has no copy of it. `mstage
config` is the two ends of getting one stage through the GitHub environment of
the same name:

```
npm run mstage config put -- --stage=dev              # from .mstage.config.json
npm run mstage config put -- --stage=dev < other.json # or from a document piped in
npm run mstage config get -- --stage=dev              # prints {"dev": {…}}
```

`put` sends that stage's block to `BOXLITE_MSTAGE_<APP>_CONFIG` on the GitHub
environment named for the stage, where `<APP>` is `mstage.env.json`'s `app`
upper-cased. It goes through `gh`, which is already how mstage signs in to
GitHub, so there is no second notion of a token here and the repository is
`gh`'s to work out from the checkout. The value travels on `gh`'s stdin rather
than in an argument, because argv is visible in the process table.

`get` prints the same block, reading the variable first and
`.mstage.config.json` second. That order is what lets one command work in both
places: on a runner the variable is the only copy, and on a workstation the
file is. An empty variable counts as absent, because that is what an unset
GitHub variable expands to in a shell. Output is one line of JSON on stdout and
nothing else, so `$(npm run --silent mstage config get -- --stage=dev)` is the
whole value.

The block keeps its own stage name — `{"dev": {…}}`, not `{…}` — so a variable
read out of the wrong environment is a named refusal rather than a stage that
silently has the wrong region in it.

Neither command resolves a cloud. Reading a declaration needs no credential,
and demanding one would defeat the case this exists for.

### What mstage.env.json holds

`env.selectGroup` declares the named subsets of the store that may leave it,
and `env.digest` names the key that fingerprints one of them. `env.digest.key`
must be a member of the group it describes, so the fingerprint travels with
what it fingerprints, and it cannot be optional — a fingerprint nobody had to
write is one the check would pass on every stage.

A group is either an array of key names, where the store must hold every one,
or `{ "required": [...], "optional": [...] }`. The two say different things: a
missing required key is the silently short environment mstage refuses on
purpose, while a missing optional one is a feature this stage never configured
and the consumer already has an answer for. Without the distinction, saying
nothing costs a row of empty strings per stage. Every command reads it the same
way — `env list --select-group`, `env set --digest` and `env digest` all compute
over the same set, so a check cannot demand more than a write can supply.

One group name means more than the others. `env.selectGroup.secret` marks the
keys whose value is the _address_ of a secret rather than the secret; see
"Secrets by reference" below. It names no consumer of its own, so a marked key
that no other group names is refused — a mark on a key nobody receives is a
mark on nothing.

How a stage deploys is deliberately absent — that belongs to `mdeploy`.

## The stage environment

`mstage env` reads and writes the store SST calls secrets, which on this platform
holds a stage's whole configuration. Four calls, and no project init:

```
aws   SSM  /sst/bootstrap                 → the state bucket's name
      S3   secret/<app>/<stage>.json      → the encrypted map
      SSM  /sst/passphrase/<app>/<stage>  → the key
      AES-256-GCM                         → the map

gcp   SM   mstage-bootstrap                → the state bucket's name
      GCS  secret/<app>/<stage>.json       → the encrypted map
      SM   mstage-passphrase-<app>-<stage> → the key
      AES-256-GCM                          → the map
```

The object key and the cipher are the same on both, deliberately: a store sealed
by one backend opens with the other, which is what makes moving a stage between
clouds a copy rather than a re-entry. Only where the three inputs live differs.

The AWS paths are SST v3.19.3's own (`pkg/project/provider/aws.go:541` and `:545`),
because these objects are shared with it: a deploy still writes what this reads,
and on a stage SST has already written, `sst secret set` and `mstage env set` are
interchangeable. On one it has not, `mstage env set` refuses: the passphrase is
generated by SST on first use, with `Overwrite=false` and a description reading
"DO NOT DELETE STATE WILL BECOME UNRECOVERABLE", and inventing that key as a side
effect of setting a value is not a decision mstage should make.

The bucket name never appears in output — not on success, not in an error. Its
twelve random characters are chosen at bootstrap and recorded only in
`/sst/bootstrap`, so they are the one thing keeping these objects unaddressable;
a log is read by more people than the account is. Messages name the stage, or
the object's key, both of which the caller already supplied.

`env list` prints names only. `sst secret list` prints every value with sst's
stdio inherited, which was already more than "lists what is set" and became far
more once the store started holding whole stage configurations: one command drops
every token and private key into scrollback. Values need asking for:

```bash
npm run mstage env list -- --stage dev                        # names only
npm run mstage env list -- --stage dev --values               # and their values
npm run mstage env list -- --stage dev --select-group deploy   # one declared group
npm run mstage env list -- --stage dev --select-group deploy --json  # the same, as JSON
npm run mstage env list -- --stage dev --json                 # the whole store, as JSON
```

An empty store is a failure rather than an empty answer, which is what SST
reports too: a caller that cannot tell the two apart would deploy with no
configuration at all.

A group is `env.selectGroup.<name>` in `mstage.env.json`, so adding a key to an export
is a reviewable edit to a file rather than a longer command line — which is the
only reason exporting is safe at all. A group naming a key the store does not
hold is an error, not a short answer: a deploy handed a silently incomplete
environment fails later, somewhere that does not mention the missing key. Every
value prints as the one string it is — `KEY=A,B,C,D` is seven characters and not
a list — so a value that merely contains a comma, a JSON document among them,
comes out whole.

A group may name no keys at all. A repository that gives each of its services a
group needs to say that one of them reads nothing yet, and the alternatives are
worse: a placeholder key, or leaving the service undeclared where nothing
holding the config against the services can see it. `env.digest` is unaffected,
because the group it fingerprints must carry the digest key and so cannot be
empty.

`env set` takes assignments, as many as fit on the line, and lands them in one
write — the store is a single object, so writing per key would cost a round trip
each and widen the window in which a concurrent writer loses somebody's change.
`\n`, `\r`, `\t`, `\\` and `\"` are expanded, the same sequences SST's own file
loader accepts (`cmd/sst/secret.go:199-207`), because a shell has no other way to
put a newline in an argument.

`--json` says the values on the line are JSON documents:

```bash
npm run mstage env set -- SHAPE='{"a":"b", "c":"d"}' --stage dev --json
```

Each one is parsed, refused if it does not parse, and stored as JSON writes it
rather than as the shell typed it — so one value is one stored string, and
re-typing the same object with different spacing is not a change and does not
move a group's digest. A document carries its own escapes, so the expansion
above does not run on it: `{"key":"a\nb"}` already means a newline, and expanding
it first would leave a raw newline inside a JSON string, which is not JSON at
all.

Asked for rather than detected from the value. A value beginning with `{` is
usually a document, but `KEY={VALUE}` is two words and a pair of braces, and
guessing would turn it into a refusal; the caller who means a document can say so
in a word. Without the flag every value is a line of text, exactly as before.
`--json` describes a value, so a line that carries none — a piped document, or
`--digest` on its own — is refused rather than accepted with a flag that did
nothing.

Two other forms exist for values a command line cannot carry. A lone `KEY` with
no `=` reads its value from stdin, whole and with its trailing newline kept,
which is what `sst secret set` stores for the same input. No arguments at all
reads a JSON object of them — the shape `env list --json` prints, so a store
exported from one stage loads into another unedited. JSON is the only accepted
document format because it carries a newline with no escape convention to learn;
for the same reason its values are used exactly as parsed, with no second pass of
expansion.

A store holds strings, so a string value is stored as it was parsed and anything
else JSON can hold is stored as the JSON text of that value — the same thing
`--json` does for one value on a command line, so a document says the same thing
whichever way it arrives and a nested object needs no escaping to survive being
written into a file:

```json
{ "KA": { "A": "one", "C": "two" }, "MANY": ["x", "y"], "PORT": 8080 }
```

stores `{"A":"one","C":"two"}`, `["x","y"]` and `8080`. A list is stored as the
list it is rather than joined on a separator its own elements may contain.
`null` is the one refusal: a key whose stored value is the text `null` is
nobody's intention, and a key that should not be there at all is `env del`.

> [!IMPORTANT]
> A store exported before this change does not load back into one. The old
> `env list --json` printed any value holding a comma as an array, and the
> piped form joined it back on the comma — lossless while both halves of that
> convention existed, and neither exists now. An array in an old file therefore
> loads as the JSON text of that array: a value stored as `x,y,z` comes back as
> `["x","y","z"]`. The write names every list it stores, so this is not silent —
> but it is still a rewrite, and only you know which of those lists were
> values. `BACKOFFICE_PLATFORM_CONFIG` is the shape
> that stings — a JSON document the old export split on the commas inside it,
> in a group `env.digest` certifies. No single command can both rewrite and
> certify — `--digest` never reads a piped document — but two can, and the
> second would put the fingerprint behind the rewrite. Export the stage again
> rather than loading a file written before this.

```bash
npm run mstage env set -- PORT=8080 TIMEOUT=30 --stage dev
npm run mstage env set -- PRIVATE_KEY --stage dev < key.pem
npm run mstage env set -- --stage dev < stage.json
npm run mstage env set -- --stage dev --select-group deploy < stage.json
```

`--select-group` narrows a document to the keys one group names, so a whole store can be
piped in and only the reviewed part of it lands. What it drops it names, because
a key that vanishes silently looks like a key that was written, and a document
with nothing in the group is refused rather than reported as a write that did not
happen.

No value is ever echoed back. What is reported is names, and whether each was
added, replaced, or already held that value.

### Secrets by reference

A stage's store holds its configuration, and everything in it is delivered to
whatever consumes it as a value. For a secret that is more than it needs to be:
the value ends up in a task definition or a service revision, where anyone who
may describe one can read it and where every revision ever registered keeps its
own copy.

`env.selectGroup.secret` is the other way. Its keys hold the address of a secret
kept in the cloud's own secret store, and what resolves the address is the
platform the workload runs on — an ECS `secrets` entry, a Cloud Run
`secretKeyRef` — as the container starts. The secret itself never travels: not
through this store, not through the deploy, not into a task definition.

An address is a one-field JSON document, so it is written with the JSON form of
`env set`:

```bash
# an AWS stage: a Parameter Store SecureString, named by ARN
npm run mstage env set -- --stage dev --json \
  BACKOFFICE_OIDC_CLIENT_SECRET='{"address":"arn:aws:ssm:ap-southeast-1:123456789012:parameter/boxlite-backoffice/dev/oidc-client-secret"}'

# a GCP stage: a Secret Manager secret, named as a resource
npm run mstage env set -- --stage dev --json \
  BACKOFFICE_OIDC_CLIENT_SECRET='{"address":"projects/boxlite-dev/secrets/oidc-client-secret"}'
```

Which form is accepted follows `home`, so an address for the other cloud is
refused rather than stored to fail at the next deploy. On AWS both a Parameter
Store parameter ARN and a Secrets Manager secret ARN are addresses, because both
are what that reference channel resolves and this platform's older secrets live
in Secrets Manager. A full ARN and not a bare parameter name: ECS accepts a bare
name only for a parameter in the task's own region and account, and an ARN is the
form a reviewer can read the region and the account out of. On GCP the address
carries no version, because Cloud Run takes the version as its own field and an
address that named one would be declaring it twice.

`--json` is how the address is written above, but it is not what makes the key an
address: `env.selectGroup.secret` is. The flag decides how a value is read; the
group decides what it has to be, so an address typed without the flag is checked
just the same — it is simply stored as typed rather than as JSON writes it.

The value itself is refused where an address belongs, at the write and again at
the deploy — the store is also writable by `sst secret set`, so being sure once
is not being sure. No refusal quotes the value: the mistake it exists to catch is
the secret written in place of its address, and a message that echoed it would
put it in the terminal the whole arrangement is keeping it out of.

One thing to confirm before the first key moves, on AWS. The ECS agent resolves
these with the task's execution role, whose inline policy SST writes with
`ssm:GetParameters` and `secretsmanager:GetSecretValue` — but `mdeploy` attaches
the account's `boxlite-role-boundary` to that role, and a boundary caps what a
policy allows. That document is not in this repository, so what it permits
cannot be read from here. The database password already reaches a container
through the same channel as a Secrets Manager ARN on a stage that runs, so that
half is exercised; a Parameter Store ARN is not, and a parameter under a
customer-managed KMS key would need `kms:Decrypt` besides. A boundary that
refuses the read fails every task at start.

Nothing about the reference is mstage's to arrange beyond that. Creating the
parameter or the secret, and granting the workload permission to read it, belong
to whoever owns the cloud; a deploy tool reads the group and hands each address
to the platform — in this repository `mdeploy` does, through
`env.selectGroup.secret` and nothing else. Adopting it for a key already in the
store is three steps in order: put the secret in Parameter Store or Secret
Manager, add the key to `env.selectGroup.secret` in `mstage.env.json` —
leaving it in the service group that delivers it, which is what still says who
reads it — then `env set` its address. The middle step alone leaves the next
deploy refusing, by name, a key that still holds a value.

### The fingerprint

`env.digest` in `mstage.env.json` names a key and one `env.selectGroup`:

```json
"env": { "digest": { "key": "BACKOFFICE_STAGE_CONFIG_DIGEST", "group": "deploy" } }
```

`env set --digest` writes that key alongside the assignments, in the same write,
over the group as it will be rather than as it was — a digest of the previous
configuration would certify the wrong thing. The digest key is a member of the
group it describes, so a consumer that reads the group has it without a second
lookup, and it is the one group member allowed to be absent when the digest is
being derived: a store that has never held one can still be given its first.
`--digest` on its own recomputes over the store as it stands, which is how a
group edited by other means gets certified again.

`env digest` checks it: it prints what it expects and what is stored, and exits
non-zero when they differ. That is the whole point — the gate refuses when the
configuration moved after something was built against it. A group member that is
missing entirely refuses too, through the same exit code; missing and mismatched
are the same answer.

`env del` removes keys — as many as fit on the line, in one write, for the
reason `set` writes once: the store is a single object, so removing them one at a
time would cost a round trip each and widen the window in which a concurrent
writer loses somebody's change. A key that was not there is reported and is not
an error, and when none of the names was there nothing is written: the store ends
up in the state that was asked for either way, and a caller cleaning up after a
rename should not have to know which half already ran. A name repeated on the
line is refused rather than reported twice for one removal.

`env del --digest` keeps `env.digest.key` true, which for a removal means
refusing one that would falsify it. Naming any member of the certified group —
the digest key included, since it is one — refuses the whole command before
anything is removed. The flag writes nothing: a removal it allows touches no
member of that group, so the stored fingerprint still describes it, and a
removal it refuses could not be mended by recomputing while the group still
names what went. `set --digest` is the half that writes. Removing a group member
is still allowed without the flag, which is how a group shrinks: the next deploy
then refuses by name until `mstage.env.json` catches up.

A name being written must match SST's own rule for one it can set,
`[A-Z][a-zA-Z0-9_]*` (`cmd/sst/secret.go:363`), because a name SST cannot set is
one SST cannot read back. `del` does not apply that rule: a store mstage can open
holds whatever is in it, and refusing to remove a key over how it is spelled
would leave it there. Both commands need `--confirm` on a stage marked
`protect: true`.

### One layer, not two

SST keeps a second section per app, `secret/<app>/_fallback.json`, applied
beneath whichever stage was asked for. mstage does not read or write it. Neither
`boxlite-backoffice` nor the platform's `boxlite` store has ever had one, and a
layer that is always empty still costs every reader a merge and every writer a
decision about which layer it meant — plus, while it existed here, an
inconsistency between the two paths that computed the digest. A value shared by
two stages is written to both.

Anything written there by `sst secret set --fallback` is therefore invisible to
`env list`, and a group that names such a key fails as
`the store is missing <key>` rather than exporting a short environment.

One property is worth knowing before relying on any of this:

- **A write replaces the whole object.** The store is one encrypted document, so
  every `set` and `del` is a read-modify-write, exactly as `sst secret set` is.
  Two writers racing lose one of the two changes silently — including a deletion,
  which comes back. SST has that property too and mstage does not add locking on
  top of a store it shares, so batch changes from one place.

### Reading a group from code

A group is what a program asks for too, through the one function that answers
for it:

```js
import { selectGroup } from 'mstage/select-group'

Object.assign(
  process.env,
  await selectGroup({
    group: 'api',
    stage: process.env.BACKOFFICE_STAGE,
    region: process.env.AWS_REGION,
    versionId: process.env.BACKOFFICE_STAGE_SECRETS_VERSION,
  }),
)
```

`selectGroup` returns the group's keys and values and does nothing else with them —
whether they belong in `process.env`, in a child process, or in a file is the
caller's decision, and a library has no business making it. `apps/api/src/main.ts`
assigns them into its own environment at startup; `mdeploy` hands them to `sst`
as a child environment instead. Both name a group; neither carries a list of
keys, which is the point: `env.selectGroup` is the only place that says what may leave
the store, so nothing has to be kept in step with it.

`versionId` reads the object as an earlier moment saw it. A deploy records the
version it shipped (`currentVersion`) and passes it here, so a task that starts
again hours later reads the configuration the deploy was built against rather
than whatever the store holds by then; a version that has since been deleted is
an error rather than a quiet fall back to current.

The group must be complete: a key it names that the store does not hold is an
error, so a process never starts on a silently short environment. Which config
file answers is found by walking up from the working directory, or named
outright with `MSTAGE_CONFIG` — which is how a container that ships only `dist`
points at it (`apps/api/Dockerfile`).

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
message when there isn't one. All three providers are documented in `--help`
whether or not this repository declares them, because mstage is shared and does
not define the set; naming one no stage declares is refused,
and a missing session for a declared, required provider is what fails the
command.

It signs nobody in unless asked. `-f` / `--force` runs a full sign-in first —
`aws login`, `gcloud auth login --update-adc`, `gh auth login`, `auth0 login` —
for whichever provider was named, or for every one this repository declares when
none was, and then reports the session that now exists. `--logout` ends a session
instead of checking it; asking for both at once is refused. Those commands prompt
or open a browser, so they inherit the terminal: where there is a terminal and a
required provider is not ready, mstage offers to run the sign-in and re-checks
the result rather than trusting the exit status. Where there is none — CI — it
reports and exits.

`--stage` narrows what is required to the cloud that stage lives in. Without it
every declared provider is required, because `mstage login` on its own asks
whether this checkout can work at all. With it, a cloud that is not that stage's
`home` is still checked and reported but no longer fails the command: a
repository with stages in both clouds declares both, and reading that
repository-wide is what let an expired AWS session refuse a GCP deploy on a
machine that needed no AWS credential to perform it. Only the clouds narrow —
GitHub and Auth0 are nobody's home, and stay required wherever they are
declared.

GCP's `--update-adc` is load-bearing rather than decorative. gcloud keeps two
credentials and this repository authenticates from both: the CLI's own session,
which every plain `gcloud` subcommand uses — `iam/bootstrap` and mbuild's
Artifact Registry calls spawn those — and Application Default Credentials, which
the Google SDKs and the Pulumi provider resolve. One flag writes both, and
`mstage login` proves both can mint a token, naming whichever one is stale.
Signing in with `gcloud auth application-default login` alone leaves the CLI's
session at whatever it was, which reported a ready session and then failed the
first `gcloud projects describe` a bootstrap ran.

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
