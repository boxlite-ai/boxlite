# BoxLite Infra (SST on AWS)

> **Based on [Daytona](https://github.com/daytonaio/daytona)** by Daytona
> Platforms Inc., licensed under AGPL-3.0. This infrastructure configuration
> is a modified deployment of the BoxLite control plane, rebranded as BoxLite.
> See the project root `LICENSE` file and individual source file headers for
> full license terms.

Guarded deployment of an existing BoxLite control-plane stack: ECS Fargate
services, an EC2 Runner with nested KVM, RDS Postgres, ElastiCache Redis, S3,
and CloudFront.

- **Region:** `AWS_REGION` (defaults to `ap-southeast-1`)
- **IaC:** SST v4 (Pulumi under the hood)
- **Cost at rest:** ~$570/month always-on — Runner + load balancers dominate

## Prerequisites

`npm run bootstrap` (below) provisions everything marked **auto** — you only
need to be logged in to each service; it does not need long-lived credentials
for any of them.

| Prerequisite | How |
| --- | --- |
| **AWS credentials** | `aws login` — browser sign-in, AWS CLI 2.32.0+. No IAM user, no access keys, and no IAM Identity Center setup. Signing in as the account root works. |
| **AWS GitHub OIDC provider** | **auto** — created if the account doesn't already have one |
| **Deployment role + permissions boundary** | **auto** — `ci/github-deploy-role.yaml` deployed via CloudFormation |
| **GitHub Environment** (named exactly as the stage) with required reviewers | **auto** — `gh auth login` first. Protection rules need a public repo, or GitHub Pro/Team/Enterprise on a private one; without them the Environment is still created, unprotected. |
| **An Auth0 tenant** (or any OIDC provider) | Tenant signup is manual — Auth0 has no API for it. Everything inside it (SPA app, custom API, post-login Action, logout discovery) is **auto** via `auth0 login` + `npm run bootstrap -- --provision-auth0`. |
| **A Cloudflare-managed domain** | Manual. You must own the domain and delegate nameservers, and Cloudflare's `wrangler` OAuth catalog has no DNS-edit scope — so a hand-made API token with `Zone:Read` + `DNS:Edit` is required. See [Secrets & credentials](#secrets--credentials). |
| **An existing SST stack whose Runner inventory matches `RUNNERS`** | Manual — first-Runner provisioning is not implemented here. See [Deploying to your own AWS account](#deploying-to-your-own-aws-account). |
| **AWS CLI + GitHub CLI** (and `auth0` CLI for `--provision-auth0`) | Installed by you; the bootstrap checks for them and fails with the exact fix. |

## Deploy an existing stack

This workflow cannot create the first Runner or recover a missing one. Complete
a separately reviewed Runner provisioning operation before using it for a new
stage; that operation is not implemented in this repository yet.

```bash
cd apps/infra
npm install
cp .env.example .env        # stage config: STACK_DOMAIN, OIDC_ISSUER_BASE_URL, OIDC_AUDIENCE
$EDITOR .env

aws login                   # browser sign-in; no IAM user or access keys needed
gh auth login               # if not already authenticated
npm run bootstrap -- --stage dev

# Optional: also provision the Auth0 tenant's app/API/Action in one pass.
# Not idempotent — Auth0 has no upsert, so rerunning creates duplicates.
auth0 login
npm run bootstrap -- --stage dev --provision-auth0
```

`npm run bootstrap` (`scripts/bootstrap-environment.mjs`) is the one-time
environment preparation step — safe to re-run, including to pick up a change to
`ci/github-deploy-role.yaml` on an account that already has a stack. It signs in
as **you**, not as the scoped role it provisions (that role deliberately can't
touch CloudFormation or its own IAM policy — see
[Native AMD64 CI deployment](#native-amd64-ci-deployment)). In order it:

1. checks the AWS CLI is ≥2.32.0 and that credentials resolve, pointing at
   `aws login` if not;
2. registers the GitHub OIDC provider if the account lacks one;
3. creates/updates the GitHub Environment named after the stage, requiring the
   authenticated user as reviewer (`--reviewers 123,456` to override);
4. optionally provisions Auth0 (`--provision-auth0`);
5. seeds the Cloudflare credentials into SSM and `OIDC_CLIENT_ID` into the SST
   secret store — prompting, or reading `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `OIDC_CLIENT_ID` from the environment for a
   non-interactive run;
6. deploys the `ci/github-deploy-role.yaml` stack and writes its role ARN plus
   `AWS_REGION` and `DEPLOY_ENV` into that Environment.

Steps 1-3 and 6 are idempotent. Step 4 is **not** — Auth0 offers no upsert, so
rerunning with `--provision-auth0` creates duplicate applications. In step 5 the
two Cloudflare SSM parameters are skipped when already seeded (pass `--force` to
replace them), while `OIDC_CLIENT_ID` is prompted for and rewritten every run
unless it is supplied through the environment. See the header comment
in `scripts/bootstrap-environment.mjs` for the full flag list — there's no
`--help` flag, only the doc comment.

Then trigger the deployment:

```bash
# The workflow is manual and accepts runs only from main. It updates an existing
# stack; initial Runner provisioning is intentionally a separate operation.
gh workflow run deploy-infra.yml --ref main -f stage=dev -f apply=false
gh workflow run deploy-infra.yml --ref main -f stage=dev -f apply=true
```

`OIDC_CLIENT_ID` is required. Other app secrets (SSH keys, Auth0 Management API,
Svix, PostHog) are optional and set per-stage in the SST secret store — see
[Secrets & credentials](#secrets--credentials).

A full reconciliation typically takes 10–15 minutes. Output prints service URLs
and the CloudFront domain.

If a build fails on a transient registry or package-mirror error, rerun the
workflow — SST resumes from the failed step.

### Deploying to your own AWS account

`npm run bootstrap` plus the steps above prepare the AWS/GitHub account
layer — IAM role, runtime permissions boundary, SSM credentials, GitHub
Environment wiring — for any AWS account, any stage name, and any fork (it
resolves the GitHub repo from `gh repo view`, or `--repo owner/name`). The
deploy workflow itself is stage-agnostic too — `stage` is a `workflow_dispatch`
input threaded through the GitHub Environment, the IAM boundary check, and
every `sst` command — but its `options` list is a deliberate allowlist, not
free text, so a required-reviewers Environment can't be targeted by an
unbootstrapped or misspelled stage name. Deploying a stage other than `dev`
means bootstrapping it first (`npm run bootstrap -- --stage <name>`), then
adding `<name>` to the `stage` input's `options` in
`.github/workflows/deploy-infra.yml` before it's selectable.

Preparing the account layer is necessary but not sufficient for a genuinely
from-zero deployment: as stated above, this workflow only reconciles an
**existing** stack whose Runner inventory already matches `RUNNERS`.
First-Runner provisioning — the stateful EC2/KVM host,
[protected against replacement](#runner-lifecycle) by design — is a
separately designed and reviewed operation not implemented in this repository
yet. Until it lands, standing up a stack in a brand-new account still needs
that piece done by hand before the guarded workflow above has anything to
reconcile.

## Native AMD64 CI deployment

`.github/workflows/deploy-infra.yml` runs the deployment on GitHub's native
`ubuntu-24.04` AMD64 runner. Docker, Buildx, image compilation, and the daemon all
run in CI; a developer Mac needs neither Docker Desktop nor the Docker CLI. The
workflow checks both the kernel and Docker engine architecture before SST runs.

The job is manual, serialized, restricted to `main`, and bound to the selected
stage's protected GitHub Environment (`dev` today — see [Deploying to your own
AWS account](#deploying-to-your-own-aws-account) for adding another). GitHub OIDC supplies short-lived AWS credentials; no
AWS access keys are stored in GitHub. `DEPLOY_ENV` materializes the stage's
gitignored `.env` only for the job and is deleted even if deployment fails.

The workflow first runs deployment safety tests that require every Runner to
retain `protect: true` and the AMI/user-data ignore rules. It then runs a full
`sst diff --json` and passes the structured plan through
`scripts/deployment-preview.mjs`. The gate rejects creating, replacing, or
deleting a Runner instance and any in-place Runner change other than provider
association or tags. Workflow dispatch defaults to a preview-only run; set
`apply=true` only after reviewing it. An apply run repeats the same guarded
preview before the full-stack deploy:

```bash
npm run deploy -- --stage dev
```

Both commands deliberately avoid `--target` and `--exclude`. Pulumi treats both
as partial updates, which cannot safely migrate a provider while omitted
resources still reference the old provider. Full reconciliation also avoids
silently accumulating stack drift. The deployment wrapper rejects partial
deploy selectors; targeted `diff` remains available for read-only inspection.
The Runner EC2 identity and binary remain stable through the lifecycle controls
under [Runner lifecycle](#runner-lifecycle), and the matching release-asset
preflight always runs before deployment.

The role template grants only the AWS control-plane actions used by this SST
stack. IAM mutation is limited to `boxlite-*` roles, policies, and instance
profiles. Every role created by SST must carry the stage's runtime permissions
boundary, which excludes IAM mutation and limits workloads to the data-plane APIs
they need. Its trust policy accepts only OIDC tokens for the bootstrapped repo
using that stage's Environment (`boxlite-ai/boxlite`'s `dev` Environment,
by default). Rerun `npm run bootstrap -- --stage dev` (from
[Deploy an existing stack](#deploy-an-existing-stack)) whenever this policy or
boundary changes — it's idempotent, so rerunning it when nothing changed is a
no-op. `IAM_PERMISSIONS_BOUNDARY_STAGE` must match both the SST stage
and the template's `GitHubEnvironment`; deployment fails before creating roles if
they differ. Keep required reviewers enabled on that Environment.

After the safety tests and before any AWS resource is touched, a
`Verify deploy role IAM boundary permissions` step
(`scripts/verify-deploy-role-boundary.mjs`) reads the assumed role's own IAM
policies — using only the read-only actions already granted to it — and fails
immediately with a pointer back to `npm run bootstrap` if they don't grant
`iam:PutRolePermissionsBoundary` for the current stage's boundary. Without it,
the same gap surfaces as a wall of duplicate `AccessDenied` errors from every
role SST manages, and only at the final `Deploy the full stack` step.

## Secrets & credentials

Three homes, one access gate — **AWS IAM**. Nothing secret lives in git or a
single laptop's `.env`:

| What                                                                                                                              | Where                                                                        | Set with                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **App secrets** — SSH host/private keys, Auth0 Management API id + secret, `SVIX_AUTH_TOKEN`, `POSTHOG_API_KEY`, `OIDC_CLIENT_ID` | SST secret store (encrypted in SST state, per stage)                         | `OIDC_CLIENT_ID`: `npm run bootstrap`. The rest: non-echoing prompt + SST stdin procedure below |
| **Cloudflare provider creds** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DEFAULT_ACCOUNT_ID`                                           | AWS SSM (`SecureString`, per stage); optionally GitHub Environment secrets, which the workflow exports and which take precedence | `npm run bootstrap` (see [Deploy an existing stack](#deploy-an-existing-stack)) |
| **Stage config** — `STACK_DOMAIN`, `OIDC_ISSUER_BASE_URL`, `OIDC_AUDIENCE`, toggles                                               | GitHub Environment secret `DEPLOY_ENV`; local `.env` is the bootstrap source | `npm run bootstrap`, which runs `gh secret set DEPLOY_ENV --env <stage> < .env` |

Grant each API token only the permissions and resources required for its
documented use; the Cloudflare token needs `Zone:Read` and `DNS:Edit` for the
managed zone. Rotate tokens regularly and immediately after suspected
disclosure, updating the value in SSM or the SST secret store. Never put token
values in command arguments, echo them, enable shell tracing around
secret-handling commands, or copy secret-bearing logs or workflow output into
issues.

`VERSION` is optional; it controls the release reported by `/api/config` and
defaults to the canonical workspace version in `Cargo.toml`.

The Cloudflare creds can't be `sst.Secret`: the provider initializes in `app()`
before `run()` (where secrets exist), so it reads them from the environment.
`scripts/sst-with-cloudflare.mjs` — wired into `npm run deploy`/`remove`,
`npm run secrets`, and `npm run sst` — fetches them from SSM and exports them
before invoking sst. `sst dev` is disabled for this stateful stack because a
long-running process cannot refresh the Runner state baseline before every
update.
**Run sst through these npm scripts**, not bare `npx sst`, so the creds load.
SST 4.6.11 exposes no supported deploy option to disable or redact this event
stream, so the wrapper removes Pulumi's transient
`.sst/pulumi/**/eventlog.json` before and after every wrapped SST command. These event
streams can contain provider credentials; SST state and non-secret diagnostics
are left in place. If an existing event log is ever found to contain a provider
token, rotate that token immediately, then run any wrapped SST command to remove
the stale event log.

### App secrets

```bash
printf 'SVIX auth token: ' >&2
IFS= read -rs secret_value; printf '\n' >&2
printf '%s' "$secret_value" | npm run sst -- secret set SVIX_AUTH_TOKEN --stage dev
unset secret_value
npm run sst -- secret load .env.secrets --stage dev # bulk-load an ignored secret dotenv
npm run secrets -- --stage dev                      # list what's set
```

Secret names match the env keys the services expect, but values in the ordinary
deployment `.env` are not consumed as SST application secrets. `OIDC_CLIENT_ID`
has no fallback and must exist before deploy. Unset optional secrets resolve to
empty (feature off). A changed value takes effect on the next `npm run deploy`.

### Onboarding / offboarding

Access is **AWS IAM only**: anyone who can deploy (read SST state + SSM, run
`sst deploy`) can read every secret. Onboard by granting that AWS access;
offboard by revoking it. There's no secret file or vault to hand over. Secret
values and the SSM params are **per-stage** — seed each stage you run.

## After deployment

Nothing needs to be fed back into `.env`. Existing Runner EC2 instances
self-report their addresses through healthchecks and remain visible in the
dashboard Runner table or `GET /admin/runners`.

### Runner inventory

The default runner is auto-seeded by the API at boot. `RUNNERS` records the
expected total (1-100), including the default Runner:

```bash
# Existing inventory: default (#1) + runner-2 + runner-3.
echo "RUNNERS=3" >> .env
```

Routine control-plane deployment requires this inventory to match the current
SST checkpoint exactly. It will not create a first Runner, scale out, or replace
a missing Runner. A separately designed and reviewed provisioning operation is
required so unknown preview-time secrets and network IDs cannot bypass the
control-plane safety gate; none is implemented in this repository yet.

Each extra runner gets its own EC2 + minted token. Because the API only
auto-seeds the single default, the extras are registered with the control plane
by a post-deploy step (`RegisterExtraRunners` in `sst.config.ts`, which runs
`scripts/register-runners.mjs` against the admin API once the API is healthy).
It's idempotent — re-running `sst deploy` won't duplicate rows. Scaling down is
also excluded from routine deployment; see
[Runner decommission and recovery](#runner-decommission-and-recovery).

### Custom system images

Add supported images through `BOXLITE_SYSTEM_IMAGES` as documented in
`.env.example`, for example
`sandbaseai-hermes=sam2026go/hermes-agent:boxlite-noexpose-20260726`. Runners
cache exact image refs, so publish updated bytes under a new immutable tag or
digest; do not repush a mutable tag and expect an existing cache to refresh.

> **Note:** `CLOUDFRONT_DOMAIN` is no longer needed — SST Router resolves
> it automatically via your `STACK_DOMAIN`. The dashboard's API base URL
> is likewise derived: `DASHBOARD_BASE_API_URL` defaults to
> `https://api.<STACK_DOMAIN>` and is substituted into the bundled JS at
> container start (see `apps/api/src/main.ts`).

The dashboard derives one canonical `/api` URL from that injected value and
uses it for both runtime requests and every generated SDK/CLI example. Remote
URLs must use HTTPS; an HTTP fallback is accepted only on a loopback host.

## Public hostnames

Four public DNS names, three different fronting layers:

| Hostname                 | Fronted by        | Purpose                                                           |
| ------------------------ | ----------------- | ----------------------------------------------------------------- |
| `<STACK_DOMAIN>`         | CloudFront Router | Dashboard SPA + static assets (cache-friendly, edge-served)       |
| `api.<STACK_DOMAIN>`     | Api ALB (direct)  | REST API, WebSocket `/attach`, build-log streaming, file transfer |
| `proxy.<STACK_DOMAIN>`   | Proxy NLB (TLS)   | Port-preview wildcard `<port>-<boxId>.proxy.<domain>`             |
| `*.proxy.<STACK_DOMAIN>` | Proxy NLB (TLS)   | Wildcard alias of the above (per-box preview hosts)               |

**Why `/api/*` bypasses CloudFront.** CloudFront imposes a non-configurable
10-minute idle cap on WebSocket connections — even with WS Ping frames and
ALB-level keepalive tuning, a session through CF dies at 10 minutes. Origin
read timeout is configurable up to 60 seconds without an AWS Support case
(we set 60 s in `sst.config.ts`'s Router transform), so SSE streams with
multi-minute no-byte gaps also fail under CF. Only the dashboard SPA
(immutable hashed assets) benefits from CDN caching, so only that path is
CF-fronted. The dashboard's bundled JS picks up
`DASHBOARD_BASE_API_URL=https://api.<STACK_DOMAIN>` at container start (see
`apps/api/src/main.ts::replaceInDirectory`) so all its `/api/*` fetches go
direct to the Api ALB.

**SDK and CLI base URL.** Use `https://api.<STACK_DOMAIN>/api` for SDK and CLI
profiles, especially for long-lived operations (`exec`, `attach`, SSE, and
uploads). The CloudFront-routed `https://<STACK_DOMAIN>/api` path is only for
short request/response calls; WebSocket execution attach is not a supported
CloudFront path.

## Proxy deployment safety

The Proxy NLB, TLS listener, and target group are protected Pulumi resources.
An immutable topology change therefore fails instead of silently replacing a
target group during a partial deploy. Proxy and API task updates use ECS rolling
deployments and wait for steady state. Proxy targets must pass `GET /health`.

After every successful `npm run deploy`, `scripts/sst-with-cloudflare.mjs`
queries AWS and verifies that the NLB listener forwards to the target group
attached to the Proxy ECS service and that the group has at least the desired
number of healthy targets. It then probes `/health` through both the base Proxy
hostname and a deliberately invalid `deployment-probe.<PROXY_DOMAIN>` wildcard
hostname, which verifies the wildcard DNS record and TLS certificate without a
live box. The API `/api/config` probe also checks the exact OIDC issuer, release
version, and Proxy template host. A failed check makes the deploy command exit nonzero; it reports the
mismatch but does not mutate or roll back AWS resources.
Deploys and removals require `--stage <stage>` (or `SST_STAGE`) so SST, the
verifier, and destructive operations cannot target different stages.

A deliberate NLB or target-group migration must be performed as a separate
operation. First set all three Proxy transform `opts.protect` values to `false`
and deploy that metadata-only change without changing topology. Then carry out
the separately reviewed migration or `sst remove`; restore protection afterward
if the stack remains. This prevents a topology replacement from being mixed
into the same deploy that disables protection.

## WebSocket session length

The Api ALB has `idle_timeout: 3600` (1 hour) via the SST
`transform.loadBalancer` hook in `sst.config.ts`. Proxy traffic uses the TLS
NLB described above. The API setting pairs with three layers per AWS's
"WebSocket through ALB" guidance:

- **App-layer WS Ping every 15s** sent by the runner
  (`apps/runner/pkg/api/controllers/{boxlite_exec_attach,proxy}.go`). The
  API proxies these frames transparently via `http-proxy-middleware`'s raw
  socket pipe, so they refresh both the runner↔Api ALB and the Api ALB↔client
  TCP segments. Required by AWS HTTP 408 troubleshooting: "Sending a TCP
  keep-alive does not prevent this timeout. Send at least 1 byte of data
  before each idle timeout period elapses."
- **ALB `idle_timeout=3600`** so a brief network pause inside an active
  session doesn't cause an RST.
- **Node `httpServer.keepAliveTimeout = 65 * 60 * 1000`** in
  `apps/api/src/main.ts` (must be ≥ ALB idle, per AWS HTTP 502
  troubleshooting: "keep-alive duration of the target is shorter than the
  idle timeout value of the load balancer").

If you raise or lower the ALB idle, keep the Node `keepAliveTimeout`
strictly greater than it.

## OIDC provider setup (Auth0 example)

The stack delegates all authentication to an external OIDC provider. The API
validates JWTs via JWKS and probes the issuer's `/.well-known/openid-configuration`
once at startup. Any standards-compliant IdP works (Auth0, Okta, Keycloak, Dex,
Cognito, etc.) — the only hard requirement is that the JWKS URL be reachable
from the API container.

For IdPs that don't advertise `end_session_endpoint` in their discovery doc
(Dex is the common case — see `dexidp/dex#1697`), the dashboard's logout flow
transparently falls back through BoxLite's own `/api/auth/end-session` route.
No operator action needed; the API auto-detects and the dashboard auto-uses it.

For Auth0 specifically:

1. **SPA Application** — create in Auth0. Set **Allowed Callback URLs** to
   include both:
   - `https://<STACK_DOMAIN>` — dashboard (web).
   - `http://127.0.0.1:5555/callback` — `boxlite auth login --method browser`
     (Rust CLI). RFC 8252 §8.3 requires the IPv4 loopback literal, not
     `localhost`; no alias needed. If you change the port via the CLI's
     `--callback-port` flag, add the matching URL here too.

   Set **Allowed Logout URLs** to `https://<STACK_DOMAIN>`.

2. **Custom API** — identifier becomes `OIDC_AUDIENCE` (e.g. `https://dev.boxlite.ai/api`)
3. **Post-Login Action** — Auth0 access_tokens don't include `email_verified` by default;
   without it BoxLite suspends the user's organization. Use
   `functions/auth0/setCustomClaims.onExecutePostLogin.js`, copied from upstream BoxLite
   with its AGPL-3.0 SPDX header preserved.
   Deploy → Actions → Flows → Login → drag onto flow → Apply.
4. **RP-Initiated Logout End Session Endpoint Discovery** — required so the SPA's
   logout fully terminates the Auth0 session (otherwise the browser silently
   re-authenticates via the still-alive Auth0 cookie and "Sign out" looks like a
   page refresh). Dashboard → Settings → Advanced → "Login and Logout" → enable
   the toggle. For tenants created on or after 14 November 2023 this is the
   default; older tenants need the manual flip. After enabling, restart the API
   service so its cached discovery probe re-fetches and stops emitting the
   BoxLite fallback. ([Auth0 docs](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0))
5. **Machine-to-Machine app** (optional, for account linking) — authorize for Auth0 Management API
   with permissions: `read:users`, `update:users`, `read:connections`,
   `create:guardian_enrollment_tickets`, `read:connections_options`. A root
   issuer safely derives Auth0's `/api/v2/` prefix and `/oauth/token` endpoint.
   If the provider issuer has a path, set `OIDC_MANAGEMENT_API_BASE_URL` and
   `OIDC_MANAGEMENT_API_TOKEN_URL` to the provider's exact endpoints; the API
   refuses to guess either value from the issuer path.
6. **`OIDC_ISSUER_BASE_URL` env var** — set to Auth0's canonical issuer
   **with the trailing slash** (e.g. `https://dev-xxxxx.us.auth0.com/`).
   Auth0's discovery doc reports `issuer` with a trailing slash, and
   spec-compliant OIDC clients (the Rust CLI's `openidconnect` crate,
   `coreos/go-oidc` strict mode, etc.) require byte-for-byte match between
   the URL they discover at and the `issuer` field in the returned doc.
   Without the slash, browser/device-code flows fail with
   `unexpected issuer URI`. apps/api passes this value through to
   `/api/config` verbatim — fix it at the source, not in the consumer.

## Service URLs

| Service              | Purpose                               | Exposure                                                                 |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **Dashboard SPA**    | Browser UI (static assets via CDN)    | `https://<STACK_DOMAIN>` (CloudFront)                                    |
| **Api**              | REST API + WebSocket `/attach`        | `https://api.<STACK_DOMAIN>` (public ALB)                                |
| **Proxy**            | `<port>-<id>.proxy.<domain>` previews | `https://*.proxy.<STACK_DOMAIN>` (public TLS NLB)                        |
| **Jaeger**           | Trace viewer (no auth)                | internal ALB (set `JAEGER_PUBLIC=true` to expose)                        |
| **OtelCollector**    | OTLP ingest + health                  | internal ALB (in-VPC emitters only)                                      |
| **PgAdmin**          | Postgres admin UI                     | internal ALB (set `PGADMIN_PUBLIC=true` to expose)                       |
| **MailDev**          | Mock SMTP + web UI (no auth)          | internal ALB only — no public option (`MAILDEV_PUBLIC=true` is rejected) |
| **ClickHouse Cloud** | Managed OTel storage                  | external service; configured by env                                      |
| **ClickStack**       | Logs/traces/metrics explorer          | external ClickHouse Cloud UI                                             |

Run the `Deploy stack` workflow (`deploy-infra.yml`) again to redeploy. See
[Public hostnames](#public-hostnames) below for the rationale behind the
dashboard-vs-API split.

## Common commands

```bash
# Preview the protected GitHub deployment environment without mutation.
gh workflow run deploy-infra.yml --ref main -f stage=dev -f apply=false

# After the preview passes review, evaluate again and apply the full stack.
gh workflow run deploy-infra.yml --ref main -f stage=dev -f apply=true

npm run sst -- diff --stage dev     # preview changes
npm run sst -- unlock --stage dev   # recover from "concurrent update detected"
npm run sst -- shell --stage dev    # open shell with SST-linked env vars
```

> The workflow routes deployment through `scripts/sst-with-cloudflare.mjs` so
> Cloudflare credentials load from SSM. Bare `npx sst …` skips that integration.
> The wrapper also requires the repository's mandatory Runner policy for every
> `diff` and `deploy`, and requires the SST subcommand to be the first argument.
> `sst dev` is disabled.
> Before each diff or deploy it exports the encrypted SST checkpoint, keeps
> only a non-secret hash of every non-default Runner input except the four
> deliberately mutable fields (AMI, user data, declared tags, and
> provider-expanded tags),
> and compares current state with desired Runner properties. The current SST
> CLI cannot save and later apply one exact preview plan, so apply performs a
> fresh state export and evaluation. The policy blocks every Runner create,
> unsafe property change, changed protection, or changed identity even if the
> human-readable preview stream is incomplete. A separate actor can still
> change backend state between that export and Pulumi acquiring its update lock;
> the protected Environment
> and serialized workflow reduce this residual window but cannot eliminate it.

## Runner lifecycle

The Runner EC2 instance (`tag:Name=boxlite-runner-default`) holds load-bearing state:
`/var/lib/boxlite` on its root disk, plus the in-memory libkrun VMs that back
running boxes. **It must not be replaced by routine deploys.** Two Pulumi
resource options on `sst.config.ts`'s Runner enforce that:

- `ignoreChanges: ["ami", "userDataBase64"]` — Ubuntu publishes new AMIs
  monthly and Cargo.toml version bumps rewrite the embedded `RUNNER_VERSION`.
  Without this option, either change would replace the EC2. With it, neither
  change is acted on — a version bump instead reaches the running fleet through
  the rolling upgrade below.
- `protect: true` — refuses any deletion attempt, including a stray
  `pulumi destroy` or stack-wide teardown.

### Upgrading the runner binary

The Runner binary version is pinned to `Cargo.toml`'s `version` field at the
repo root. Treat a release that changes the API-to-Runner protocol as a
capability-gated two-phase rollout:

1. Publish the matching Runner tarball and checksum, then deploy the API and
   infrastructure. The deploy preflight refuses to mutate SST when those
   assets are absent. Existing detached box creates remain routable to older
   Runners; requests that need the new foreground/command session capability
   fail explicitly until a compatible Runner is available.
2. Upgrade Runners one at a time with the command below. The API filters those
   requests to Runners at the required version, and each upgraded Runner only
   becomes schedulable after the control plane reports that exact version.

Routine infrastructure deploys reconcile the full stack. They may update the
Runner's provider association or tags in place, but the preview gate rejects
creation, replacement, deletion, or other instance changes. The mandatory
policy also requires the exact current inventory and identity, `protect: true`,
only the two intended `ignoreChanges` properties, and equality of all other
non-default inputs during preview and apply. The EC2 stays in place; a version
change is delivered during the full deployment by the sequential
`UpgradeRunnerBinary-*` SSM commands described below.

Detached requests that use legacy Runner capabilities remain available during
the compatibility window; requests needing the new Runner version fail
explicitly until the rolling binary upgrade reaches that Runner.

This bounded compatibility window is intentional: silently discarding a
requested command or foreground lifecycle would be data loss, while sending it
to an older Runner would be a protocol error.

A version bump then lands on the next deploy:

```bash
npm run deploy -- --stage dev
```

`sst.config.ts` declares one `UpgradeRunnerBinary-*` command per Runner, each
depending on the previous one. The intent is that the fleet upgrades **one host
at a time** — the dependency chain, rather than anything in the script, is what
should keep two Runners from restarting at once, and a failed host should stop
the roll with the hosts not yet visited still serving. Each command runs
[`scripts/runner-update-binary.mjs`](scripts/runner-update-binary.mjs) against a
single instance id taken straight from the Pulumi graph, so extra Runners
(`RUNNERS > 1`) are covered too. The sequencing has not yet been observed on a
real deploy — only the script's own sequential loop has.

Per host, over AWS SSM Run Command: the release tarball and its SHA-256 sidecar
are downloaded and verified before the systemd unit is stopped — so a failed,
missing-sidecar, or corrupt fetch never takes the Runner down — then the live
binary is backed up, `/usr/local/bin/boxlite-runner` swapped, and the unit
restarted. The host counts as done only once the Runner's HTTP health route
reports the new version; if it does not come up, the backup is restored and the
command fails. Asset URLs and the stable-version rule come from
[`runner-release-assets.mjs`](scripts/runner-release-assets.mjs), the same
resolver the deploy preflight uses, so an unreleasable target is rejected before
any host is touched. The binary itself exposes no `--version` flag, so its health
route is the only version oracle available here.

The step is a converge, not a reinstall. A host is left completely alone when it
is already serving the target version, when it is still bootstrapping (its
user-data installs that same version anyway), or when it is serving something
**newer** than `Cargo.toml` declares — that last case is refused rather than
silently reverted, since a Runner ahead of the repo is usually a deliberate
hand-install. Version ordering understands prereleases: `0.9.10` outranks
`0.9.9`, and `0.9.8-alpha` is treated as older than `0.9.8`, so promoting a
prerelease host to the matching release is an upgrade, not a refused downgrade.

To upgrade out of band — after an interrupted roll, or to pin a version without
deploying:

```bash
npm run runner:update              # version from Cargo.toml, every running Runner
npm run runner:update -- 0.9.5     # explicit version
INSTANCE_IDS=i-0abc… npm run runner:update   # one specific host
ALLOW_DOWNGRADE=1 npm run runner:update -- 0.9.5   # deliberate rollback
```

> The Runner is **not** drained first. Files under `/var/lib/boxlite` survive,
> but boxes running on the host being upgraded take the restart; the unit's
> `TimeoutStopSec=60` only buys a graceful VM shutdown. Cordoning through the
> admin API (`PATCH /runners/:id/scheduling`) would need a control-plane Runner
> id, an operator key, and the organization-infrastructure flag, none of which
> the deploy path has — so treat any Runner upgrade as disruptive and drain it
> yourself when that matters.

### Runner decommission and recovery

The routine workflow intentionally does not provision, decommission, or recover
Runner EC2 instances. Do not change `protect: true` or edit SST state as part of
a normal deployment. A separate reviewed runbook must cover control-plane
draining, pinned-box checks, the exact cloud and SST-state operations, and
post-operation verification before any Runner is removed or recreated. That
break-glass operation is not implemented in this repository yet.

## Architecture

```
                                static SPA + assets
  Browser ─────▶ CloudFront (Router) ─────▶ Api ALB ──▶ NestJS
                 <STACK_DOMAIN>            (cacheable)    │
                                                          │
                 /api/* — REST + WS /attach + SSE + files │
  Browser/SDK ─────────────────────▶ Api ALB direct ──────┘
                                     api.<STACK_DOMAIN>
                                     idle_timeout=1h  (for long WS sessions)

  Browser ───▶ Proxy NLB ───▶ Proxy ECS ───▶ box port (toolbox + user-app previews)
                proxy.<STACK_DOMAIN> + *.proxy.<STACK_DOMAIN>
                TLS:443 → TCP:4000

                          ┌───────┬────────┬────────┐
                          │  RDS  │ Redis  │   S3   │  Api → DB/Redis (linked);
                          │  PG   │        │ bucket │  S3 via vended STS creds
                          └───────┴────────┴────────┘
  private VPC
                          ┌────────────────────────────────┐
                          │  EC2 c8i.2xlarge Runner        │
                          │  (nested KVM; pulls box images  │
                          │   from ghcr.io)                │
                          └────────────────────────────────┘

Auth: OIDC provider (Auth0/Okta/Keycloak/Dex/…) ← Api validates JWT via JWKS;
      /api/auth/end-session provides RP-initiated-logout fallback for IdPs
      that don't advertise end_session_endpoint in discovery
```

## Troubleshooting

**"concurrent update detected"** — run `npm run sst -- unlock --stage dev` and retry.

**Service stuck at `rolloutState: FAILED` with 1 running task** — stale event
from an earlier failed deploy. If `runningCount == desiredCount` the service
is fine; ignore it.

**Api crashes with `Failed to fetch OpenID configuration`** — the API can't
reach `<OIDC_ISSUER_BASE_URL>/.well-known/openid-configuration`. Check network
egress from the API container to the IdP, and confirm `OIDC_ISSUER_BASE_URL`
points at a working host. apps/api strips a trailing slash _only_ when composing
its own internal discovery URL; the value is exposed to clients via `/api/config`
verbatim — see the next two entries.

**CLI fails with `unexpected issuer URI`** — the trailing slash on
`OIDC_ISSUER_BASE_URL` doesn't match what the IdP's discovery doc returns
under `issuer`. Auth0 always reports the issuer with a trailing slash; spec-
compliant OIDC clients (including the Rust CLI's `openidconnect` crate)
demand byte-for-byte match. Fix: set `OIDC_ISSUER_BASE_URL` to the form your
IdP returns (Auth0: `https://dev-xxxxx.us.auth0.com/` _with_ slash). See
the OIDC setup section above. The Rust CLI tolerates this with a one-shot
retry that toggles the trailing slash, so the user-visible failure here is
typically the web dashboard, not the CLI — but treat any `unexpected issuer
URI` as a config bug on the API side.

**CLI fails with `Callback URL mismatch. The provided redirect_uri is not in
the list of allowed callback URLs`** — Auth0 rejected the CLI's redirect URI.
Add `http://127.0.0.1:5555/callback` to the SPA Application's
**Allowed Callback URLs** in the Auth0 dashboard (see the OIDC setup section
above). The dashboard's web flow uses `https://<STACK_DOMAIN>` and has always
been registered; the CLI's loopback URL is a separate entry that's easy to
forget.

**Dashboard shows `Authentication Error: No end session endpoint` on logout** —
the API's IdP-discovery probe failed at startup, so the dashboard never
received the `end_session_endpoint` fallback. Check API logs for the
`OIDC discovery probe failed; treating as 'unknown' (fail-closed)` warning;
fix the underlying connectivity to the IdP and the next `/api/config` request
self-heals.

**"Organization is suspended: Please verify your email address"** — Auth0 access_token
missing `email_verified` claim. Deploy the Post-Login Action described above.

**Runner never reaches `READY`** — the runner pairs to its DB row by token
(`BOXLITE_RUNNER_TOKEN`, baked into the EC2's user-data, must equal the row's
`apiKey`), then self-reports its address via `POST /runners/healthcheck` using
`RUNNER_DOMAIN` (set from EC2 instance metadata at boot). Check the runner's
systemd logs (`aws ssm start-session` → `journalctl -u boxlite-runner`) for auth
or connectivity errors to the API.

**Box preview cannot connect** — verify that the NLB listener target group
matches the Proxy ECS service attachment and has a registered target. Do not
switch the listener to a replacement target group until its Proxy target passes
`/health`.

**Dashboard terminal cannot connect** — the terminal uses the direct API host,
not the Proxy NLB. Verify `https://api.<STACK_DOMAIN>/api/config`, the API ECS
service, and the dashboard's configured API base URL.

**Docker build fails with "broken pipe"** — transient ECR push failure. Retry deploy.

## Cost (ap-southeast-1, always-on)

| Resource                              | Monthly   |
| ------------------------------------- | --------- |
| EC2 c8i.2xlarge (Runner)              | ~$325     |
| Load balancers (5 ALB + 2 NLB)        | ~$115     |
| 7x Fargate 0.25 vCPU / 0.5 GB         | ~$65      |
| 2x NAT EC2 (`t4g.nano`) + public IPv4 | ~$16      |
| RDS `t4g.micro` Postgres              | ~$15      |
| ElastiCache Redis                     | ~$15      |
| CloudFront + S3 + CloudWatch Logs     | ~$20      |
| **Total**                             | **~$570** |

Figures are approximate (ap-southeast-1 on-demand). The **Runner and the load
balancers dominate** — the NAT is ~$16, not a headline cost. Whole-stack removal
requires a separate reviewed Proxy and Runner decommission runbook, which is not
implemented here. S3 buckets and RDS snapshots are retained in production
(`--stage production`) per SST's default.
