# BoxLite Infra (SST on AWS)

> **Based on [Daytona](https://github.com/daytonaio/daytona)** by Daytona
> Platforms Inc., licensed under AGPL-3.0. This infrastructure configuration
> is a modified deployment of the BoxLite control plane, rebranded as BoxLite.
> See the project root `LICENSE` file and individual source file headers for
> full license terms.

One-command deploy of the BoxLite control plane: ECS Fargate services, an
EC2 runner with nested KVM, RDS Postgres, ElastiCache Redis, S3, CloudFront.

- **Region:** `ap-southeast-1`
- **IaC:** SST v3 (Pulumi under the hood)
- **Cost at rest:** ~$500/month always-on (tear down with one command)

## Prerequisites

- A **Cloudflare-managed domain** (SST creates ACM certs + DNS records automatically)
- An **Auth0 tenant** (or any OIDC provider — see `.env.example` for setup steps)
- **Docker Desktop** running locally (SST builds container images)
- **AWS CLI** configured with a profile that has admin access

## Quick start

```bash
cd apps/infra
cp .env.example .env
# Fill in STACK_DOMAIN, CLOUDFLARE_*, OIDC_* (see .env.example comments)
npm install
npx sst deploy --stage dev
```

First deploy: 10–15 minutes. Output prints service URLs + CloudFront domain.

If the build fails with a transient `auth.docker.io` EOF or Debian mirror
`502 Bad Gateway`, just rerun `npx sst deploy --stage dev` — SST resumes
from the failed step.

## After first deploy

One value needs to be fed back into `.env`:

```bash
# Get runner private IP:
aws ec2 describe-instances --region ap-southeast-1 \
  --filters "Name=tag:Name,Values=boxlite-runner" \
  --query 'Reservations[].Instances[].PrivateIpAddress' --output text

# Add to .env:
echo "RUNNER_PRIVATE_IP=10.0.x.y" >> .env

# Redeploy (~2 min):
npx sst deploy --stage dev
```

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
| `proxy.<STACK_DOMAIN>`         | Proxy ALB (direct)     | Port-preview wildcard `<port>-<sandboxId>.proxy.<domain>`         |
| `*.proxy.<STACK_DOMAIN>`       | Proxy ALB (direct)     | Wildcard alias of the above (per-sandbox preview hosts)           |
| `ssh.<STACK_DOMAIN>`           | SshGateway NLB (TCP)   | `ssh -p 2222 <token>@ssh.<STACK_DOMAIN>` to a sandbox             |

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

## Auth0 setup

The stack delegates all authentication to an external OIDC provider. For Auth0:

1. **SPA Application** — create in Auth0, set callback/logout URLs to `https://<STACK_DOMAIN>`
2. **Custom API** — identifier becomes `OIDC_AUDIENCE` (e.g. `https://dev.boxlite.ai/api`)
3. **Post-Login Action** — Auth0 access_tokens don't include `email_verified` by default;
   without it BoxLite suspends the user's organization. Use
   `functions/auth0/setCustomClaims.onExecutePostLogin.js`, copied from upstream BoxLite
   with its AGPL-3.0 SPDX header preserved.
   Deploy → Actions → Flows → Login → drag onto flow → Apply.
4. **Machine-to-Machine app** (optional, for account linking) — authorize for Auth0 Management API
   with permissions: `read:users`, `update:users`, `read:connections`,
   `create:guardian_enrollment_tickets`, `read:connections_options`.

## Service URLs

| Service             | Purpose                              | Public hostname                              |
|---------------------|--------------------------------------|----------------------------------------------|
| **Dashboard SPA**   | Browser UI (static assets via CDN)   | `https://<STACK_DOMAIN>`                     |
| **Api**             | REST API + WebSocket `/attach`       | `https://api.<STACK_DOMAIN>` (direct ALB)    |
| **Proxy**           | `<port>-<id>.proxy.<domain>` previews | `https://*.proxy.<STACK_DOMAIN>` (direct ALB) |
| **SshGateway**      | `ssh <token>@ssh.<domain>:2222`      | `ssh.<STACK_DOMAIN>:2222` (NLB, raw TCP)     |
| **SnapshotManager** | S3-backed docker registry            | internal only                                |
| **Jaeger**          | Trace viewer                         | public ALB                                   |
| **OtelCollector**   | OTLP ingest                          | internal + public health                     |
| **PgAdmin**         | Postgres admin UI                    | public ALB                                   |
| **RegistryUI**      | Browse snapshot images               | public ALB                                   |
| **MailDev**         | Mock SMTP + web UI                   | public ALB                                   |

Run `npx sst deploy --stage dev` without changes to reprint all URLs. See
[Public hostnames](#public-hostnames) below for the rationale behind the
dashboard-vs-API split.

## Common commands

```bash
npx sst deploy --stage dev       # deploy / update
npx sst diff   --stage dev       # preview changes
npx sst unlock --stage dev       # recover from "concurrent update detected"
npx sst shell  --stage dev       # open shell with SST-linked env vars
npx sst remove --stage dev       # destroy everything
```

## Runner lifecycle

The Runner EC2 instance (`tag:Name=boxlite-runner`) holds load-bearing state:
`/var/lib/boxlite` on its root disk, plus the in-memory libkrun VMs that back
running sandboxes. **It must not be replaced by routine deploys.** Two Pulumi
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

The script uses AWS SSM Run Command to stop the systemd unit, download the
release tarball from GitHub Releases, swap `/usr/local/bin/boxlite-runner`,
and restart. Sandbox state under `/var/lib/boxlite` is untouched.

### Deliberate decommission (three-step ceremony)

When you actually need to replace the Runner (failed disk, security incident,
major version upgrade with on-disk format change), it is a multi-edit
operation by design:

1. Verify no `running` sandboxes are pinned to this Runner (DB query against
   `sandbox.runnerId`).
2. Edit `sst.config.ts`: change `protect: true` to `protect: false` on the
   Runner resource. Run `npx sst deploy --stage <stage>`. This only updates
   the resource metadata; the EC2 is not yet touched.
3. Destroy the EC2:
   ```bash
   npx pulumi destroy --target 'urn:pulumi:<stage>::boxlite::aws:ec2/instance:Instance::Runner'
   ```
4. Edit `sst.config.ts`: change `protect: false` back to `protect: true`. Run
   `npx sst deploy` again — a new Runner is created with fresh state.

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

  Browser ───▶ Proxy ALB ───▶ sandbox port (toolbox + user-app previews)
                proxy.<STACK_DOMAIN> + *.proxy.<STACK_DOMAIN>
                idle_timeout=1h

  ssh client ▶ SshGateway NLB ──▶ ssh-gateway ──▶ runner ──▶ box
                ssh.<STACK_DOMAIN>:2222  (raw TCP, no TLS termination)

                          ┌───────┬────────┬────────┬──────────┐
                          │  RDS  │ Redis  │   S3   │ Snapshot │ ← Api links
                          │  PG   │        │ bucket │ Manager  │
                          └───────┴────────┴────────┴──────────┘
                                                       ▲
                                                       │ docker push
  private VPC                                          │
                          ┌───────────────────────────────┐
                          │  EC2 c8i.2xlarge Runner       │
                          │  (nested KVM, privileged)     │
                          └───────────────────────────────┘

Auth: Auth0 (external) ← OIDC tokens validated by Api via JWKS
```

## Troubleshooting

**"concurrent update detected"** — run `npx sst unlock --stage dev` and retry.

**Service stuck at `rolloutState: FAILED` with 1 running task** — stale event
from an earlier failed deploy. If `runningCount == desiredCount` the service
is fine; ignore it.

**Api crashes with `Failed to fetch OpenID configuration`** — `OIDC_ISSUER_BASE_URL`
has a trailing slash causing `//` in the discovery URL. Remove the trailing slash.

**"Organization is suspended: Please verify your email address"** — Auth0 access_token
missing `email_verified` claim. Deploy the Post-Login Action described above.

**Runner never registers with API** — `RUNNER_PRIVATE_IP` in `.env` is stale or
missing. Get the current IP and redeploy. The runner also self-registers via
`RUNNER_DOMAIN` set from EC2 instance metadata.

**Sandbox preview URL returns 503** — Proxy service may need a force-redeploy after
initial setup: `aws ecs update-service --force-new-deployment --service Proxy`.

**Docker build fails with "broken pipe"** — transient ECR push failure. Retry deploy.

## Cost (ap-southeast-1, always-on)

| Resource                           | Monthly |
|------------------------------------|---------|
| EC2 c8i.2xlarge (Runner)           | ~$245   |
| NAT EC2 instance                   | ~$5     |
| 9x Fargate 0.25 vCPU / 0.5 GB     | ~$70    |
| RDS `t4g.micro` Postgres           | ~$15    |
| ElastiCache Redis                  | ~$15    |
| ALBs (10x)                         | ~$160   |
| CloudFront + S3 + CloudWatch Logs  | ~$20    |
| **Total**                          | **~$530** |

`npx sst remove --stage dev` tears it all down; S3 buckets and RDS snapshots
are retained in production stage (`--stage production`) per SST's default.
