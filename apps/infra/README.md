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
> it automatically via your `STACK_DOMAIN`.

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

| Service             | Purpose                        | Access                           |
|---------------------|--------------------------------|----------------------------------|
| **Api**             | REST API + dashboard           | `https://<STACK_DOMAIN>`         |
| **Proxy**           | `<port>-<id>.proxy.<domain>`   | `https://*.proxy.<STACK_DOMAIN>` |
| **SshGateway**      | `ssh <sandbox>@host`           | TCP `:2222`                      |
| **SnapshotManager** | S3-backed docker registry      | internal only                    |
| **Jaeger**          | Trace viewer                   | public ALB                       |
| **OtelCollector**   | OTLP ingest                    | internal + public health         |
| **PgAdmin**         | Postgres admin UI              | public ALB                       |
| **RegistryUI**      | Browse snapshot images         | public ALB                       |
| **MailDev**         | Mock SMTP + web UI             | public ALB                       |

Run `npx sst deploy --stage dev` without changes to reprint all URLs.

## Common commands

```bash
npx sst deploy --stage dev       # deploy / update
npx sst diff   --stage dev       # preview changes
npx sst unlock --stage dev       # recover from "concurrent update detected"
npx sst shell  --stage dev       # open shell with SST-linked env vars
npx sst remove --stage dev       # destroy everything
```

## Architecture

```
                                    HTTPS
  Browser ──▶ CloudFront (Router) ──────▶ ALB → Api (NestJS)
              dev.boxlite.ai                     │ links
                                                 ▼
                        ┌───────┬────────┬────────┬──────────┐
                        │  RDS  │ Redis  │   S3   │ Snapshot │
                        │  PG   │        │ bucket │ Manager  │
                        └───────┴────────┴────────┴──────────┘
                                                     ▲
         ┌──────────────┐   private VPC              │ docker push
SSH ────▶│ SshGateway   │─────────┐                  │
:2222    └──────────────┘         ▼                  │
         ┌──────────────┐   ┌───────────────────────────┐
HTTPS ──▶│ Proxy (ALB)  │   │  EC2 c8i.2xlarge Runner   │
*.proxy  └──────────────┘   │  (nested KVM, privileged) │
                            └───────────────────────────┘

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
