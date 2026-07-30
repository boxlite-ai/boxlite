# BoxLite Infra (SST on AWS)

> **Based on [Daytona](https://github.com/daytonaio/daytona)** by Daytona
> Platforms Inc., licensed under AGPL-3.0. This infrastructure configuration
> is a modified deployment of the BoxLite control plane, rebranded as BoxLite.
> See the project root `LICENSE` file and individual source file headers for
> full license terms.

One-command deploy of the BoxLite control plane: ECS Fargate services, an
EC2 runner with nested KVM, RDS Postgres, ElastiCache Redis, S3, CloudFront.

- **Region:** `AWS_REGION` (defaults to `ap-southeast-1`)
- **IaC:** SST v4 (Pulumi under the hood)
- **Cost at rest:** ~$570/month always-on — Runner + load balancers dominate (tear down with one command)

## Prerequisites

- A **Cloudflare-managed domain** (SST creates ACM certs + DNS records automatically)
- An **Auth0 tenant** (or any OIDC provider — see `.env.example` for setup steps)
- A protected GitHub **`dev` Environment** with required reviewers
- An AWS GitHub OIDC provider and the deployment role described below
- **AWS CLI** and **GitHub CLI** for one-time CI bootstrap only

## Quick start

```bash
cd apps/infra
npm install
cp .env.example .env        # stage config: STACK_DOMAIN, OIDC_ISSUER_BASE_URL, OIDC_AUDIENCE

# Cloudflare provider credentials live in SSM (per stage) — see "Secrets & credentials":
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /boxlite/dev/cloudflare-api-token  --value "<token>"
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /boxlite/dev/cloudflare-account-id --value "<account-id>"

# Required application secret. There is no placeholder fallback because a wrong
# client ID makes every interactive login fail.
npm run sst -- secret set OIDC_CLIENT_ID "<spa-client-id>" --stage dev

# Bootstrap the short-lived GitHub OIDC role. The account's GitHub OIDC provider
# already exists when the E2E CI setup has been run.
aws cloudformation deploy --region ap-southeast-1 \
  --stack-name boxlite-dev-github-deploy \
  --template-file ci/github-deploy-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM

# In the protected GitHub `dev` Environment, configure:
#   variable AWS_DEPLOY_ROLE_ARN = the stack's RoleArn output
#   variable AWS_REGION          = ap-southeast-1
#   secret   DEPLOY_ENV          = the contents of this .env file
gh secret set DEPLOY_ENV --env dev < .env

# The workflow is manual and accepts deployments only from main.
gh workflow run deploy-dev-api.yml --ref main
```

`OIDC_CLIENT_ID` is required. Other app secrets (SSH keys, Auth0 Management API,
Svix, PostHog) are optional and set per-stage in the SST secret store — see
[Secrets & credentials](#secrets--credentials).

First deploy: 10–15 minutes. Output prints service URLs + CloudFront domain.

If a build fails on a transient registry or package-mirror error, rerun the
workflow — SST resumes from the failed step.

## Native AMD64 CI deployment

`.github/workflows/deploy-dev-api.yml` runs the deployment on GitHub's native
`ubuntu-24.04` AMD64 runner. Docker, Buildx, image compilation, and the daemon all
run in CI; a developer Mac needs neither Docker Desktop nor the Docker CLI. The
workflow checks both the kernel and Docker engine architecture before SST runs.

The job is manual, serialized, restricted to `main`, and bound to the protected
GitHub `dev` Environment. GitHub OIDC supplies short-lived AWS credentials; no
AWS access keys are stored in GitHub. `DEPLOY_ENV` materializes the stage's
gitignored `.env` only for the job and is deleted even if deployment fails.

The current workflow deliberately targets only `Api`; selecting only the API
also skips the Runner release-asset preflight:

```bash
npm run deploy -- --stage dev --target Api
```

The role template grants only the AWS control-plane actions used by this SST
stack. IAM mutation is limited to `boxlite-*` roles, policies, and instance
profiles. Every role created by SST must carry the stage's runtime permissions
boundary, which excludes IAM mutation and limits workloads to the data-plane APIs
they need. Its trust policy accepts only OIDC tokens for `boxlite-ai/boxlite`
using the `dev` Environment. Redeploy the bootstrap stack whenever this policy or
boundary changes. `IAM_PERMISSIONS_BOUNDARY_STAGE` must match both the SST stage
and the template's `GitHubEnvironment`; deployment fails before creating roles if
they differ. Keep required reviewers enabled on that Environment.

## Secrets & credentials

Three homes, one access gate — **AWS IAM**. Nothing secret lives in git or a
single laptop's `.env`:

| What                                                                                                                              | Where                                                                        | Set with                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **App secrets** — SSH host/private keys, Auth0 Management API id + secret, `SVIX_AUTH_TOKEN`, `POSTHOG_API_KEY`, `OIDC_CLIENT_ID` | SST secret store (encrypted in SST state, per stage)                         | `npm run sst -- secret set <NAME> "<value>" --stage <stage>`                     |
| **Cloudflare provider creds** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DEFAULT_ACCOUNT_ID`                                           | AWS SSM (`SecureString`, per stage)                                          | `aws ssm put-parameter --type SecureString --name /boxlite/<stage>/cloudflare-…` |
| **Stage config** — `STACK_DOMAIN`, `OIDC_ISSUER_BASE_URL`, `OIDC_AUDIENCE`, toggles                                               | GitHub Environment secret `DEPLOY_ENV`; local `.env` is the bootstrap source | `gh secret set DEPLOY_ENV --env dev < .env`                                      |

`VERSION` is optional; it controls the release reported by `/api/config` and
defaults to the canonical workspace version in `Cargo.toml`.

The Cloudflare creds can't be `sst.Secret`: the provider initializes in `app()`
before `run()` (where secrets exist), so it reads them from the environment.
`scripts/sst-with-cloudflare.mjs` — wired into `npm run dev`/`deploy`/`remove`,
`npm run secrets`, and `npm run sst` — fetches them from SSM and exports them
before invoking sst.
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
npm run sst -- secret set SVIX_AUTH_TOKEN "<value>" --stage dev  # set one
npm run sst -- secret load .env.secrets --stage dev              # bulk-load an ignored secret dotenv
npm run secrets -- --stage dev                                   # list what's set
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

## After first deploy

Nothing needs to be fed back into `.env`. The runner EC2 self-registers with the
API on boot — v2 runners report their address via healthcheck — so boxes
work as soon as the runner reaches `READY` (~30–60s), visible in the dashboard
Runner table or `GET /admin/runners`.

### Adding a runner

The default runner is auto-seeded by the API at boot. To run more, set the total
count and redeploy:

```bash
echo "RUNNERS=3" >> .env     # default runner (#1) + runner-2 + runner-3
npm run deploy -- --stage dev
```

Each extra runner gets its own EC2 + minted token. Because the API only
auto-seeds the single default, the extras are registered with the control plane
by a post-deploy step (`RegisterExtraRunners` in `sst.config.ts`, which runs
`scripts/register-runners.mjs` against the admin API once the API is healthy).
It's idempotent — re-running `sst deploy` won't duplicate rows. Scaling **down**
is the deliberate decommission ceremony under [Runner lifecycle](#runner-lifecycle),
applied per runner.

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

| Hostname                 | Fronted by           | Purpose                                                           |
| ------------------------ | -------------------- | ----------------------------------------------------------------- |
| `<STACK_DOMAIN>`         | CloudFront Router    | Dashboard SPA + static assets (cache-friendly, edge-served)       |
| `api.<STACK_DOMAIN>`     | Api ALB (direct)     | REST API, WebSocket `/attach`, build-log streaming, file transfer |
| `proxy.<STACK_DOMAIN>`   | Proxy NLB (TLS)      | Port-preview wildcard `<port>-<boxId>.proxy.<domain>`             |
| `*.proxy.<STACK_DOMAIN>` | Proxy NLB (TLS)      | Wildcard alias of the above (per-box preview hosts)               |

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

Run the `Deploy dev API` workflow again to redeploy the API. See
[Public hostnames](#public-hostnames) below for the rationale behind the
dashboard-vs-API split.

## Common commands

```bash
gh workflow run deploy-dev-api.yml --ref main # native AMD64 API deployment
npm run sst -- diff --stage dev     # preview changes
npm run sst -- unlock --stage dev   # recover from "concurrent update detected"
npm run sst -- shell --stage dev    # open shell with SST-linked env vars
npm run remove -- --stage dev       # requires the Proxy/Runner unprotect procedures
```

> The workflow routes deployment through `scripts/sst-with-cloudflare.mjs` so
> Cloudflare credentials load from SSM. Bare `npx sst …` skips that integration.

## Runner lifecycle

The Runner EC2 instance (`tag:Name=boxlite-runner-default`) holds load-bearing state:
`/var/lib/boxlite` on its root disk, plus the in-memory libkrun VMs that back
running boxes. **It must not be replaced by routine deploys.** Two Pulumi
resource options on `sst.config.ts`'s Runner enforce that:

- `ignoreChanges: ["ami", "userDataBase64"]` — Ubuntu publishes new AMIs
  monthly and Cargo.toml version bumps rewrite the embedded `RUNNER_VERSION`.
  Without this option, either change would replace the EC2. With it, drift is
  detected but not acted on.
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

An API-only `--target Api` deployment, or a broader deployment with an explicit
`--exclude Runner`, is the operator escape hatch for a control-plane-only
rollout. Either form skips the Runner release-asset preflight and leaves the EC2
resource, binary, and identity tag untouched. Detached requests that use legacy
Runner capabilities remain available; requests needing the new Runner version
fail explicitly until a later full rollout applies the metadata and upgrades
the binary.

This bounded compatibility window is intentional: silently discarding a
requested command or foreground lifecycle would be data loss, while sending it
to an older Runner would be a protocol error. To deliver a new runner build
without recreating the EC2:

```bash
# Supply an admin API token from the operator's secret manager. Do not commit it
# or put it in the SST deployment environment.
CONTROL_PLANE_API_URL=https://api.dev.boxlite.ai/api \
CONTROL_PLANE_API_KEY="$OPERATOR_API_KEY" \
CONTROL_PLANE_RUNNER_ID=00000000-0000-4000-8000-000000000001 \
CONTROL_PLANE_RUNNER_NAME=default \
STAGE=dev scripts/deploy/runner-update-binary.sh \
  --allow-disruptive-restart 0.9.8

# Update additional runners one at a time. Each Runner has its own control-plane
# UUID even when the AWS Name tag follows the same naming convention.
CONTROL_PLANE_API_URL=https://api.boxlite.ai/api \
CONTROL_PLANE_API_KEY="$OPERATOR_API_KEY" \
CONTROL_PLANE_RUNNER_ID=00000000-0000-4000-8000-000000000002 \
CONTROL_PLANE_RUNNER_NAME=runner-2 \
STAGE=production RUNNER_NAME=boxlite-runner-2 \
  scripts/deploy/runner-update-binary.sh --allow-disruptive-restart 0.9.8
```

The AWS `Name` and control-plane Runner names are intentionally different, so
both must be supplied. Before touching AWS, the script resolves
`CONTROL_PLANE_RUNNER_ID` through the admin API and requires its exact name to
equal `CONTROL_PLANE_RUNNER_NAME`. It then selects exactly one running EC2 using
the SST app, explicit stage, AWS `RUNNER_NAME`, and the
`boxlite:control-plane-runner-name` mapping tag. Only after those checks does it
start a persistent `restart` drain. That transaction makes the Runner
unschedulable; new box assignments, warm-pool claims, and pending starts are
fenced while the script polls the control plane until the active-box count
reaches zero.

Only then does AWS SSM Run Command download the release tarball, require its
SHA-256 sidecar, and confirm the candidate's exact version before stopping the
systemd unit. It backs up the live binary, swaps it, and requires both the local
`--version` output and Runner HTTP health response to report the requested
version. It then waits for the control plane to see the restarted Runner as
drained with zero active boxes and to report the requested `appVersion`; only
then does the updater clear the restart drain. On success, the control plane
restores the scheduling state that existed before the drain. On any drain, SSM,
rollback, readiness, or version-observation failure, the Runner remains drained
for operator inspection; do not manually re-enable it until the failed command
is understood. Files under
`/var/lib/boxlite` remain on disk, but that does not make an active-VM restart
non-disruptive, so the explicit `--allow-disruptive-restart` acknowledgement
remains required.

### Deliberate decommission (three-step ceremony)

When you actually need to replace the Runner (failed disk, security incident,
major version upgrade with on-disk format change), it is a multi-edit
operation by design:

1. Verify no `running` boxes are pinned to this Runner (DB query against
   `box.runnerId`).
2. Edit `sst.config.ts`: change `protect: true` to `protect: false` on the
   Runner resource. Run `npm run deploy -- --stage <stage>`. This only updates
   the resource metadata; the EC2 is not yet touched.
3. Destroy the EC2:

   ```bash
   npx pulumi destroy --target 'urn:pulumi:<stage>::boxlite::aws:ec2/instance:Instance::Runner'
   ```

4. Edit `sst.config.ts`: change `protect: false` back to `protect: true`. Run
   `npm run deploy -- --stage <stage>` again — a new Runner is created with
   fresh state.

This is deliberate by construction: three code edits across two deploys. The
control plane now provides two drain modes around this ceremony: ordinary
decommission drains remain eligible for the decommission worker, while the
admin updater uses a restart drain that keeps the Runner protected and
unschedulable until its in-place binary update succeeds. Neither mode removes
the explicit Pulumi protection steps required to replace the EC2 resource.

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
balancers dominate** — the NAT is ~$16, not a headline cost. Stack removal
requires the Proxy and Runner unprotect procedures above; S3 buckets and RDS
snapshots are retained in production (`--stage production`) per SST's default.
