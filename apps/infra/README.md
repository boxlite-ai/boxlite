# BoxLite Infra (SST on AWS)

> **Based on [Daytona](https://github.com/daytonaio/daytona)** by Daytona
> Platforms Inc., licensed under AGPL-3.0. This infrastructure configuration
> is a modified deployment of the BoxLite control plane, rebranded as BoxLite.
> See the project root `LICENSE` file and individual source file headers for
> full license terms.

One-command deploy of the BoxLite control plane: ECS Fargate services, an
EC2 runner with nested KVM, RDS Postgres, ElastiCache Redis, S3, CloudFront.

- **Region:** `ap-southeast-1`
- **IaC:** SST v4 (Pulumi under the hood)
- **Cost at rest:** ~$570/month always-on — Runner + load balancers dominate (tear down with one command)

## Prerequisites

- A **Cloudflare-managed domain** (SST creates ACM certs + DNS records automatically)
- An **Auth0 tenant** (or any OIDC provider — see `.env.example` for setup steps)
- **Docker Desktop** running locally (SST builds container images)
- **AWS CLI** configured with a profile that has admin access

## Quick start

```bash
cd apps/infra
npm install
cp .env.example .env        # non-secret config: STACK_DOMAIN, OIDC_ISSUER_BASE_URL, OIDC_AUDIENCE

# Cloudflare provider credentials live in SSM (per stage) — see "Secrets & credentials":
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /boxlite/dev/cloudflare-api-token  --value "<token>"
aws ssm put-parameter --region ap-southeast-1 --type SecureString \
  --name /boxlite/dev/cloudflare-account-id --value "<account-id>"

npm run deploy -- --stage dev   # the wrapper loads the Cloudflare creds, then runs sst deploy
```

App secrets (SSH keys, Auth0 Management API, Svix, PostHog) are optional and set
per-stage in the SST secret store — see [Secrets & credentials](#secrets--credentials).

First deploy: 10–15 minutes. Output prints service URLs + CloudFront domain.

If the build fails with a transient `auth.docker.io` EOF or Debian mirror
`502 Bad Gateway`, just rerun `npm run deploy -- --stage dev` — SST resumes
from the failed step.

## Secrets & credentials

Three homes, one access gate — **AWS IAM**. Nothing secret lives in git or a
single laptop's `.env`:

| What | Where | Set with |
|---|---|---|
| **App secrets** — SSH host/private keys, Auth0 Management API id + secret, `SVIX_AUTH_TOKEN`, `POSTHOG_API_KEY`, `OIDC_CLIENT_ID`, Stripe API + webhook secrets | SST secret store (encrypted in SST state, per stage) | `sst secret set <NAME> "<value>" --stage <stage>` |
| **Cloudflare provider creds** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | AWS SSM (`SecureString`, per stage) | `aws ssm put-parameter --type SecureString --name /boxlite/<stage>/cloudflare-…` |
| **Non-secret config** — `STACK_DOMAIN`, `OIDC_ISSUER_BASE_URL`, `OIDC_AUDIENCE`, toggles | local `.env` (gitignored) | edit `.env` |

The Cloudflare creds can't be `sst.Secret`: the provider initializes in `app()`
before `run()` (where secrets exist), so it reads them from the environment.
`scripts/sst-with-cloudflare.mjs` — wired into `npm run dev`/`deploy`/`remove`
and `npm run sst` — fetches them from SSM and exports them before invoking sst.
**Run sst through these npm scripts**, not bare `npx sst`, so the creds load.

### App secrets

```bash
sst secret set SVIX_AUTH_TOKEN "<value>" --stage dev   # set one
sst secret load .env --stage dev                       # bulk-load a dotenv (names match 1:1)
npm run secrets -- --stage dev                          # list what's set
```

Billing with Stripe also requires stage-scoped `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. Use a Stripe test key for non-production stages and
register only the four events consumed by the API: `checkout.session.completed`,
`checkout.session.async_payment_failed`, `payment_intent.succeeded`, and
`payment_intent.payment_failed`. Set `BILLING_PAYMENT_PROVIDER=stripe` in the
deploy environment; the API fails closed when either secret is absent.

Secret names match the env keys the services expect. Unset optional secrets
resolve to empty (feature off); `OIDC_CLIENT_ID` defaults to `boxlite`. A changed
value takes effect on the next `npm run deploy`.

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

> **Note:** `CLOUDFRONT_DOMAIN` is no longer needed — SST Router resolves
> it automatically via your `STACK_DOMAIN`. The dashboard's API base URL
> is likewise derived: `DASHBOARD_BASE_API_URL` defaults to
> `https://api.<STACK_DOMAIN>` and is substituted into the bundled JS at
> container start (see `apps/api/src/main.ts`).

## Public hostnames

Five public DNS names, four different fronting layers:

| Hostname                       | Fronted by             | Purpose                                                           |
|--------------------------------|------------------------|-------------------------------------------------------------------|
| `<STACK_DOMAIN>`               | CloudFront Router      | Dashboard SPA + static assets (cache-friendly, edge-served)       |
| `api.<STACK_DOMAIN>`           | Api ALB (direct)       | REST API, WebSocket `/attach`, build-log streaming, file transfer |
| `proxy.<STACK_DOMAIN>`         | Proxy ALB (direct)     | Port-preview wildcard `<port>-<boxId>.proxy.<domain>`         |
| `*.proxy.<STACK_DOMAIN>`       | Proxy ALB (direct)     | Wildcard alias of the above (per-box preview hosts)           |
| `ssh.<STACK_DOMAIN>`           | SshGateway NLB (TCP)   | `ssh -p 2222 <token>@ssh.<STACK_DOMAIN>` to a box             |

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

**Why SSH has its own friendly subdomain.** The SshGateway NLB has an
auto-generated AWS DNS name (`SshGatewayLoadB-…elb.amazonaws.com`) that's
noisy to copy/paste. `ssh.<STACK_DOMAIN>` is a Cloudflare CNAME (DNS-only,
gray cloud — Cloudflare can't proxy raw TCP) pointing at the NLB. The CNAME
is created from `sst.config.ts` via `cloudflareDns.createAlias("SshGateway", …)`
so it tracks the NLB DNS name automatically across recreations.

**SDK base URL.** Long-lived SDK sessions (`exec`, `attach`) should target
`https://api.<STACK_DOMAIN>` directly, not `https://<STACK_DOMAIN>/api`. The
CloudFront-routed path works for short request/response calls but caps
WebSockets at 10 minutes.

## WebSocket session length

Api and Proxy ALBs have `idle_timeout: 3600` (1 hour) via the SST
`transform.loadBalancer` hook in `sst.config.ts`. This pairs with three
layers per AWS's "WebSocket through ALB" guidance:

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
   `create:guardian_enrollment_tickets`, `read:connections_options`.
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

| Service             | Purpose                              | Exposure                                     |
|---------------------|--------------------------------------|----------------------------------------------|
| **Dashboard SPA**   | Browser UI (static assets via CDN)   | `https://<STACK_DOMAIN>` (CloudFront)        |
| **Api**             | REST API + WebSocket `/attach`       | `https://api.<STACK_DOMAIN>` (public ALB)    |
| **Proxy**           | `<port>-<id>.proxy.<domain>` previews | `https://*.proxy.<STACK_DOMAIN>` (public ALB) |
| **SshGateway**      | `ssh <token>@ssh.<domain>:2222`      | `ssh.<STACK_DOMAIN>:2222` (public NLB, raw TCP) |
| **Jaeger**          | Trace viewer (no auth)               | internal ALB (set `JAEGER_PUBLIC=true` to expose) |
| **OtelCollector**   | OTLP ingest + health                 | internal ALB (in-VPC emitters only)          |
| **PgAdmin**         | Postgres admin UI                    | internal ALB (set `PGADMIN_PUBLIC=true` to expose) |
| **MailDev**         | Mock SMTP + web UI (no auth)         | internal ALB only — no public option (`MAILDEV_PUBLIC=true` is rejected) |
| **ClickHouse Cloud** | Managed OTel storage                 | external service; configured by env         |
| **ClickStack**      | Logs/traces/metrics explorer         | external ClickHouse Cloud UI                |

Run `npm run deploy -- --stage dev` without changes to reprint all URLs. See
[Public hostnames](#public-hostnames) below for the rationale behind the
dashboard-vs-API split.

## Common commands

```bash
npm run deploy -- --stage dev       # deploy / update
npm run sst -- diff --stage dev     # preview changes
npm run sst -- unlock --stage dev   # recover from "concurrent update detected"
npm run sst -- shell --stage dev    # open shell with SST-linked env vars
npm run remove -- --stage dev       # destroy everything
```

> These route through `scripts/sst-with-cloudflare.mjs` so the Cloudflare provider
> creds load from SSM. Bare `npx sst …` skips that and can't reach Cloudflare.

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
repo root. To deliver a new runner build without recreating the EC2:

```bash
# Uses the version in Cargo.toml by default; pass an explicit arg to override.
scripts/deploy/runner-update-binary.sh           # latest from Cargo.toml
scripts/deploy/runner-update-binary.sh 0.9.5     # explicit
```

The script uses AWS SSM Run Command to download the release tarball from
GitHub Releases and verify its SHA-256 *before* stopping the systemd unit — so
a failed or corrupt fetch never takes the runner down — then backs up the live
binary, swaps `/usr/local/bin/boxlite-runner`, and restarts. If the new binary
fails to come up, it performs a rollback to the backup. Box state under
`/var/lib/boxlite` is untouched.

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
   `npm run deploy` again — a new Runner is created with fresh state.

This is deliberate by construction: three code edits across two deploys. If
you find yourself doing this often, look at the future drain API (tracked
separately) instead of streamlining the ceremony.

### Future: control-plane drain (`runner.state` enum)

The current state is single-Runner with manual decommission. A future phase
will add a `runner.state` enum (`initializing`, `ready`, `disabled`,
`decommissioned`, `unresponsive`) and admin endpoints to drain a Runner via
the API, mirroring the upstream Daytona model. Multi-Runner Pulumi shape
follows that. Not yet implemented.

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

  Browser ───▶ Proxy ALB ───▶ box port (toolbox + user-app previews)
                proxy.<STACK_DOMAIN> + *.proxy.<STACK_DOMAIN>
                idle_timeout=1h

  ssh client ▶ SshGateway NLB ──▶ ssh-gateway ──▶ runner ──▶ box
                ssh.<STACK_DOMAIN>:2222  (raw TCP, no TLS termination)

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
points at a working host. apps/api strips a trailing slash *only* when composing
its own internal discovery URL; the value is exposed to clients via `/api/config`
verbatim — see the next two entries.

**CLI fails with `unexpected issuer URI`** — the trailing slash on
`OIDC_ISSUER_BASE_URL` doesn't match what the IdP's discovery doc returns
under `issuer`. Auth0 always reports the issuer with a trailing slash; spec-
compliant OIDC clients (including the Rust CLI's `openidconnect` crate)
demand byte-for-byte match. Fix: set `OIDC_ISSUER_BASE_URL` to the form your
IdP returns (Auth0: `https://dev-xxxxx.us.auth0.com/` *with* slash). See
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

**Box preview URL returns 503** — Proxy service may need a force-redeploy after
initial setup: `aws ecs update-service --force-new-deployment --service Proxy`.

**Docker build fails with "broken pipe"** — transient ECR push failure. Retry deploy.

## Cost (ap-southeast-1, always-on)

| Resource                              | Monthly |
|---------------------------------------|---------|
| EC2 c8i.2xlarge (Runner)              | ~$325   |
| Load balancers (6 ALB + 1 NLB)        | ~$115   |
| 7x Fargate 0.25 vCPU / 0.5 GB         | ~$65    |
| 2x NAT EC2 (`t4g.nano`) + public IPv4 | ~$16    |
| RDS `t4g.micro` Postgres              | ~$15    |
| ElastiCache Redis                     | ~$15    |
| CloudFront + S3 + CloudWatch Logs     | ~$20    |
| **Total**                             | **~$570** |

Figures are approximate (ap-southeast-1 on-demand). The **Runner and the load
balancers dominate** — the NAT is ~$16, not a headline cost. `npm run remove -- --stage dev` tears it all down; S3 buckets and RDS snapshots are retained in
production stage (`--stage production`) per SST's default.
