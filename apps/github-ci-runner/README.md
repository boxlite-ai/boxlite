# BoxLite CI Listener

A standalone Node.js host for the shared TypeScript CI Listener. It discovers
GitHub jobs, creates ephemeral BoxLite worker Boxes, and supplies GitHub-generated
JIT runner configuration. The official GitHub runner executes the job and reports
logs and results directly to GitHub.

The shared controller lives in [`../libs/ci-listener`](../libs/ci-listener/README.md).
The hosted API imports the same controller and supplies native PostgreSQL/BoxService
adapters; its deployed acceptance is still pending. The Node image is a local development artifact until the
real deployment checks below have been recorded.

## Hosted connect

Install the platform GitHub App on the repositories you want to run, then use the
existing remote BoxLite context to bind their owning GitHub account:

```sh
boxlite --context YOUR_CONTEXT ci connect GITHUB_ACCOUNT --allow-private-repositories
```

Authorized public repositories are always eligible; omit the private-repository
flag to exclude private repositories. Complete GitHub's device authorization as
that personal account owner or an organization owner.
Connect also checks your current BoxLite organization owner/admin authority and
prevents another platform tenant from claiming the same installation. Configure
eligible workflow jobs with `runs-on: boxlite`.

The API imports the shared controller, stores its state in PostgreSQL, and creates
worker Boxes through internal BoxService capabilities under the stored binding's
original organization and actor. You do not configure a Listener Box, its ENV, a
worker execution API Key or its SQLite state directory for hosted use. Platform
operators configure the App and webhook credentials described in the
[API README](../api/README.md#hosted-configuration-and-deployment).

`connected` means the binding was saved. Listener `ready` means the catalog was
initialized; it does not certify available capacity. The native hosted runtime
requires deployment acceptance for the configured Apps in addition to local integration checks.

## Authentication

Choose one GitHub mode. Both use a standard BoxLite API Key for worker operations.

| Mode                  | Required GitHub configuration                               | Scope                                                                                         |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dedicated GitHub App  | `CI_GITHUB_APP_CLIENT_ID`, `CI_GITHUB_APP_PRIVATE_KEY_FILE` | All installations visible to that App, including multiple personal accounts and organizations |
| Personal access token | `GITHUB_TOKEN`, `GITHUB_CONFIG_URL`                         | One repository                                                                                |

Use a dedicated App whose installations you intend to service with your BoxLite
account. Personal installations produce one repository runner pool per eligible
repository. Organizations share the configured runner group, which BoxLite creates
and synchronizes automatically. The configured name is dedicated to BoxLite;
default and inherited groups cannot be adopted. With public repositories enabled,
the group includes installed private and public repositories. Otherwise it includes
only installed private repositories. Installation repository access still limits
both modes. No manual runner-group configuration is needed.

The App needs Metadata: Read, Actions: Read, and repository Administration: Write.
Organization runner groups additionally require organization Self-hosted runners:
Write. Enable the webhook and subscribe to Workflow job events. The webhook is
optional for the standalone host; compensation scanning also works without it.

| Credential               | Owner and use                                                      | Lifetime / replacement                                                                                 |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| BoxLite API Key          | Listener calls `/me` and the Box create/read/stop/delete/file APIs | Existing BoxLite expiry policy; replace the key and restart with the same state and original principal |
| App private key          | Listener signs short-lived App JWTs                                | Read from the private file for each signing operation; rotate in GitHub and replace the file           |
| App JWT                  | App installation discovery and token issuance                      | Newly signed as needed, with a five-minute expiry                                                      |
| Installation token       | Separate metadata, Actions-read and runner-management purposes     | Bounded local use window, retired after borrowing; the next operation mints a replacement              |
| Webhook secret           | HMAC-SHA256 verification of the original HTTP body                 | Must match the App setting; restart after replacing the file                                           |
| Runner JIT configuration | Sent only to its original worker Box                               | One delivery attempt; never written into Listener state                                                |

CI worker Boxes receive the JIT configuration, while App keys, webhook secrets
and the BoxLite API Key stay in the Listener. The Listener fetches job metadata;
GitHub delivers the actual job steps to the official runner.

## Configuration

Common required variables:

| Variable           | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `BOXLITE_REST_URL` | HTTPS API origin, optionally ending in `/v1`; HTTP is accepted only on loopback |
| `BOXLITE_API_KEY`  | Standard key for the BoxLite organization where CI Boxes run                    |

GitHub App mode:

```sh
CI_GITHUB_APP_CLIENT_ID=YOUR_APP_CLIENT_ID
CI_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem
CI_GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/github-webhook
```

The PEM is the private key downloaded from the GitHub App settings. The webhook
secret is a separate value that you choose and set in those settings. Both files
must be regular files with private permissions, such as `0600`, and readable by
the Listener user. They are supplied at runtime and are not part of the image.

For a token deployment, configure these instead:

```sh
GITHUB_TOKEN=YOUR_REPOSITORY_ADMIN_TOKEN
GITHUB_CONFIG_URL=https://github.com/OWNER/REPOSITORY
```

App and token configuration cannot be combined. No installation ID or auth-mode
flag is required. PAT mode uses compensation scanning and does not expose the
App webhook handler.

| Optional variable               | Default                                 | Meaning                                                                   |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `CI_GITHUB_WEBHOOK_SECRET_FILE` | unset                                   | Enable the signed App webhook endpoint and shared delivery recovery       |
| `CI_STATE_DIR`                  | `/var/lib/boxlite-ci`                   | Private SQLite state directory; preserve it across restarts/replacement   |
| `CI_LISTEN_ADDR`                | `0.0.0.0:8080`                          | Health/webhook HTTP listener                                              |
| `CI_ALLOW_PUBLIC_REPOSITORIES`  | `false`                                 | Include public repositories whose workflows you intend to run             |
| `CI_WORKER_GROUP_NAME`          | `boxlite-ci-runner`                     | Selected organization runner group                                        |
| `CI_WORKER_IMAGE`               | `ghcr.io/actions/actions-runner:latest` | Image containing the official GitHub runner                               |
| `CI_WORKER_MAX`                 | `1`                                     | Total concurrency across all installations and repositories, from 1 to 16 |
| `CI_WORKER_CPUS`                | `2`                                     | CPUs per CI Box, from 1 to 16                                             |
| `CI_WORKER_MEMORY_GB`           | `2`                                     | Memory per CI Box; one GB converts to 1024 MiB and must yield whole MiB   |

Required Box permissions cover create/read, file transfer, stop and deletion.
Authorization is checked by the existing BoxLite API. The host pins the original
`/me` actor, principal type and organization routing prefix in its state. A key
for a different principal cannot take over its existing resources.
Opaque principal subjects are preserved verbatim, including provider prefixes;
the client does not impose UUID or character-format assumptions on them.

To inspect configured names without printing their values:

```sh
node -e 'console.log(Object.keys(process.env).filter(k => /^(CI_|GITHUB_|BOXLITE_)/.test(k)).sort().join("\n"))'
```

### Multiple Apps in one Listener Box

A single self-owned App remains the default and can cover both personal and
organization installations. To run separate Apps in the same Listener, set only
`CI_GITHUB_APPS_FILE` instead of the single-App fields or PAT fields. Its absolute
path points to a private JSON file, with at most eight distinct App client IDs:

```json
[
  {
    "client_id": "PERSONAL_CLIENT_ID",
    "private_key_file": "/run/secrets/personal.pem",
    "webhook_secret_file": "/run/secrets/personal-webhook",
    "account_type": "User"
  },
  {
    "client_id": "ORG_CLIENT_ID",
    "private_key_file": "/run/secrets/organization.pem",
    "webhook_secret_file": "/run/secrets/organization-webhook",
    "account_type": "Organization"
  }
]
```

All files require private permissions. `account_type` is optional for self-owned
Apps; omitting it permits personal and organization installations visible to that
App. Restricting it controls new admission, while cleanup retains the original
App. The first entry is the permanent storage anchor; keep its client ID stable.
Removing registered App identities is not supported by this initial configuration
flow; keep original credentials for execution and cleanup.

The first App receives `/v1/ci/github/webhook`; additional Apps receive
`/v1/ci/github/webhook/CLIENT_ID`. Each path verifies its own secret and records
the trusted App identity outside the webhook body. App delivery-recovery
checkpoints are separate. The scheduling lease registers the App list in execution state; the webhook inbox
cannot write configuration records. All Apps share the same SQLite database, Listener,
BoxLite principal and total `CI_WORKER_MAX`; configuring another App adds no
second worker budget. Hosted use shares this App implementation and uses
PostgreSQL plus the native BoxService adapter.

## Build and run

Use Node 24 for local development and the repository Make targets:

```sh
make build:apps:github-ci-runner
make test:apps:github-ci-runner
make github-ci-runner-image
```

The image target builds `boxlite-ci-listener:dev` locally for Linux x86-64. It does
not push an image. The final image contains Node and the bundled host; CI jobs run
in separate worker images.

Start the image with the required environment and private secret files. Give its
`node` user access to the state directory and secret mounts. Keep state private
and persistent. Deleting it is not a way to clear an uncertain resource outcome.

For webhook delivery, enable inbound networking on the Listener Box and prepare
a public tunnel for its service port using the standard BoxLite networking API:

```sh
boxlite network tunnel LISTENER_BOX 8080
```

Set the GitHub App webhook URL to the returned URI plus
`/v1/ci/github/webhook`, and set the matching secret. Public requests must pass
HMAC verification and current binding checks before a receipt/job is stored.

The binding check uses the App's complete installation/account index, rather
than requiring a cached repository member before accepting a hint. This lets a
new repository's `workflow_job` arrive before its inventory event. Repository
scope and current GitHub permissions are still required before execution.
Unknown installations receive a failure response with inventory work only;
their job receipt and notice are not stored. When the webhook secret file is
configured, the shared App recovery controller records failed delivery metadata
and requests replays after rechecking the live App installation and execution lease.
It saves its intent before POST, preserves cooldowns across restart and keeps the
normal HMAC and binding checks. A POST 202 is not confirmation of inbox acceptance.
A local receipt or later successful delivery record confirms transport only;
the official runner remains responsible for CI results. PAT mode does not use
App replay, and bounded job scanning remains the fallback beyond delivery history.

Directory refresh runs in the shared library. A slow or failed installation
catalog does not withhold another initialized account's scopes. Health may show
discovery as `pending` while healthy accounts continue, because all current
catalog work has not completed. See the shared library's
[architecture and sequence diagrams](../libs/ci-listener/README.md#architecture-and-authentication).

`GET /healthz` reports process liveness and whether installation discovery has
completed. It is not a CI success or deployment acceptance result.

Configure workflows with the default label:

```yaml
jobs:
  build:
    runs-on: boxlite
    steps:
      - uses: actions/checkout@v4
      - run: echo 'Running in a BoxLite CI Box'
```

Request a specific Box size by replacing `runs-on` with a resource label:

```yaml
jobs:
  build:
    runs-on: boxlite-2vcpu-4gbmem-10gbdisk
    steps:
      - uses: actions/checkout@v4
      - run: echo '2 vCPU, 4 GiB RAM, 10 GiB disk'
```

The label changes the actual Box resources in both hosted and standalone modes.
Use exactly one default or custom resource label. Organization limits and Commerce
quota still apply; invalid or conflicting requests cannot create workers.
See the shared [resource-label contract](../libs/ci-listener/README.md#resource-labels)
for quantities, bounds and restart behavior. `CI_WORKER_GROUP_NAME` selects a
GitHub runner group independently of the workflow label.

## Dispatch and recovery

1. A signed `workflow_job.queued` event stores a receipt and exact job identity,
   then wakes the shared controller; it does not assign the job itself.
2. The controller verifies the installation/repository, reads the current job,
   checks labels and durable account/tenant capacity, and records allocation intent.
3. The REST adapter creates a Box and durably records the returned original ID
   before boot/JIT work. It does not adopt a same-name Box after an unknown create.
4. GitHub creates JIT configuration with a purpose-limited runner credential.
   The Listener uploads the private content file first, then its ready marker.
5. The official runner contacts GitHub, receives a matching job, executes it and
   reports logs/results directly. A trigger supplies capacity rather than an
   exclusive assignment to that particular job.
6. The controller observes actual Box exit, deletes the stopped original Box,
   and confirms its absence before returning physical Box capacity; runner
   cleanup and the allocation record remain until runner absence is confirmed.

A completed notification alone does not stop a running worker. A successful
runner DELETE is not evidence that its Box was idle. Unknown Box creation and
uncertain delivery to a still-present Box remain reserved. A single 404 is not an absence proof: the REST adapter
requires its original-ID ledger, unchanged principal and complete Box inventory.
The host ledger must also match an ID already confirmed by the shared allocation;
a conflicting record cannot redirect stop/delete/JIT operations to another Box.
An HTTP 408 from a Box mutation can follow server-side creation and is therefore
an uncertain outcome, not permission to retry the create or return its quota.

Admission or repository-read failure before dispatch records a definitive rejection
for the original create operation, allowing the controller to release its slot.
Rejection and dispatch compete atomically for the same REST ledger entry under the
execution lease and allocation version. Once dispatch wins, a late rejection cannot
release capacity, even if the POST response or returned-ID persistence fails.
Persisted rejection can be recovered locally while upstream reads remain unavailable;
all actual Box operations still verify the original live principal.
An older requested allocation without a ledger remains uncertain; missing state alone
never proves that its create was rejected.

The default directory refresh and successful compensation interval is five minutes.
Two independent scan lanes claim durable repository tasks, with one effective scan
lease per GitHub App installation (or pinned PAT repository). Different installations
can be scanned concurrently. Scan timing survives restart; failed reads back off
without occupying the execution scheduler, and large inventories need multiple tasks.
Normal webhook jobs use their exact IDs without waiting for a repository-wide
scan. Directory failure retains pending work rather than treating it as an empty
installation. Binding generations are published atomically for ingress checks.

### Stopped or deleted workers

The same recovery loop runs before new jobs and on periodic ticks. Stopped/error
workers are deleted using the recorded original Box ID. A confirmed deletion
returns physical account/tenant capacity, even if GitHub runner cleanup is busy
and must retry. The retained allocation prevents duplicate admission of its
triggering job. Lookup failures retain capacity; they are not absence evidence.
This behavior and cleanup debt survive a Listener restart with its existing state.

Box stderr contains JSON events `ci-worker-exited`, `ci-worker-box-absent`,
`ci-worker-recovery-deferred` and `ci-worker-released`, including original IDs,
`trigger.repository`, `trigger.run`, `trigger.job`, phases and cleanup effect.
Exit 0 is informational; an error, unknown stop or unexpected disappearance warns.
Error messages and credentials are excluded. These facts do not cancel a GitHub
workflow or declare it failed; GitHub controls its final status and timeout.
See the [shared recovery contract](../libs/ci-listener/README.md#worker-recovery-and-logs).

## Source layout

```text
src/
  main.ts                 process startup and shutdown
  config.ts               ENV and private-file validation
  capacity.ts             fixed CI_WORKER_MAX capacity policy
  http.ts                 bounded raw HTTP, signature verification, health
  self-host.ts            App/PAT assembly and local binding authorization
  boxlite-http.ts         fixed-origin API transport and principal checks
  boxlite-workers.ts      original-ID ledger and worker REST operations
../libs/ci-listener/src/
  listener.ts             shared scheduling lifecycle
  ci-gh-app.ts            one App identity, auth and connect verification
  app-scopes.ts           immutable original App for execution and cleanup
  capacity.ts             CapacityProvider.resolve contract and policy checks
  catalog.ts              installation/repository/group directory
  credentials.ts          purpose-specific credential ownership
  execution/              allocation journal, quotas and JIT/Box lifecycle
  state/                  PostgreSQL and SQLite adapters
```

Local checks cover simulated upstream failures, real SQLite authorization
transactions, real inbound HTTP verification, and image build/load. Standalone App
webhook execution and multi-job artifact transfer have
[live playground evidence](https://github.com/DefeatMan/boxlite-ci-playground/actions/runs/41820205537/attempts/1).
The final image still needs deployment acceptance; live organization-group and
hosted dev acceptance for automatic group provisioning remains pending. Verify
first creation, mixed public/private repositories, policy updates, and empty
membership after deploying the updated Listener.
