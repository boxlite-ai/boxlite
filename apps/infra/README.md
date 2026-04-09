# BoxLite Infra (SST on AWS)

One-command deploy of the BoxLite control plane: 10 ECS Fargate services, an
EC2 runner with nested KVM, RDS Postgres, ElastiCache Redis, S3, CloudFront.

- **Region:** `ap-southeast-1`
- **IaC:** SST v3 (Pulumi under the hood)
- **Cost at rest:** ~$560/month always-on (tear down with one command)

## Quick start

```bash
cd apps/infra
cp .env.example .env                  # empty .env is fine on first deploy
export AWS_PROFILE=your-profile
npm install
npx sst deploy --stage dev
```

First deploy: 8–12 minutes. Output prints 10 service URLs + one CloudFront URL.

## Second deploy (2 minutes)

Two values need to be fed back into `.env` before everything works end-to-end.

```bash
# 1. Copy from deploy output:
echo "CLOUDFRONT_DOMAIN=d1a2b3c4e5f6g7.cloudfront.net" >> .env

# 2. Get runner private IP:
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=boxlite-runner" \
  --query 'Reservations[].Instances[].PrivateIpAddress' --output text
echo "RUNNER_PRIVATE_IP=10.0.x.y" >> .env

# 3. Generate SSH keys for the SSH gateway:
ssh-keygen -t ed25519 -f /tmp/boxlite-user -N ""
ssh-keygen -t ed25519 -f /tmp/boxlite-host -N ""
echo "SSH_PRIVATE_KEY_B64=$(base64 -i /tmp/boxlite-user)" >> .env
echo "SSH_HOST_KEY_B64=$(base64 -i /tmp/boxlite-host)" >> .env

# 4. Redeploy:
npx sst deploy --stage dev
```

See `.env.example` for every variable, grouped by when you'll need it.

## Service URLs

| Service           | Purpose                        | Access                    |
|-------------------|--------------------------------|---------------------------|
| **Api**           | REST API + dashboard           | CloudFront (HTTPS)        |
| **Dex**           | OIDC provider (swappable)      | CloudFront `/dex/*`       |
| **Proxy**         | `<sandbox>.host` URL preview   | public ALB                |
| **SshGateway**    | `ssh <sandbox>@host`           | TCP `:2222`               |
| **SnapshotManager** | S3-backed docker registry    | internal only             |
| **Jaeger**        | Trace viewer                   | public ALB                |
| **OtelCollector** | OTLP ingest                    | internal + public health  |
| **PgAdmin**       | Postgres admin UI              | public ALB                |
| **RegistryUI**    | Browse snapshot images         | public ALB                |
| **MailDev**       | Mock SMTP + web UI             | public ALB                |

Run `npx sst deploy --stage dev` without changes to reprint all URLs.

## Common commands

```bash
npx sst deploy --stage dev       # deploy / update
npx sst diff   --stage dev       # preview changes
npx sst unlock --stage dev       # recover from "concurrent update detected"
npx sst shell  --stage dev       # open shell with SST-linked env vars
npx sst remove --stage dev       # destroy everything
```

## Logs

```bash
# List log groups for all services
aws logs describe-log-groups --region ap-southeast-1 \
  --log-group-name-prefix /sst --query 'logGroups[].logGroupName' --output text

# Tail a specific service
aws logs tail <log-group> --region ap-southeast-1 --follow
```

## Secrets

All API keys, encryption keys, and admin passwords are auto-generated on first
deploy and stored in Pulumi state. Read any runtime secret from its ECS task
definition:

```bash
aws ecs describe-task-definition \
  --task-definition <family-name> --region ap-southeast-1 \
  --query 'taskDefinition.containerDefinitions[0].environment' --output json
```

Override any generated secret by setting its env var in `.env` before deploy
(for example `ENCRYPTION_KEY=…`, `PROXY_API_KEY=…`).

## Architecture

```
          ┌─────────────────┐   HTTPS    ┌──────────────┐
  Browser │   CloudFront    │──────────▶ │  ALB → Api   │ (NestJS)
          │   /dex/* → Dex  │            └──────┬───────┘
          └─────────────────┘                   │ links
                                                ▼
                          ┌───────┬────────┬────────┬──────────┐
                          │  RDS  │ Redis  │   S3   │ Snapshot │
                          │  PG   │        │ bucket │ Manager  │
                          └───────┴────────┴────────┴──────────┘
                                                       ▲
           ┌──────────────┐   private VPC              │ docker pull/push
  SSH ────▶│ SshGateway   │─────────┐                  │
  :2222    └──────────────┘         ▼                  │
           ┌──────────────┐   ┌───────────────────────────┐
  HTTPS ──▶│ Proxy (ALB)  │   │  EC2 c8i.2xlarge Runner   │
           └──────────────┘   │  (nested KVM, privileged) │
                              └───────────────────────────┘
```

Observability (Jaeger, OtelCollector) and admin UIs (PgAdmin, RegistryUI,
MailDev) live in the same cluster but aren't shown above for brevity.

## Troubleshooting

**"concurrent update detected"** — a previous deploy didn't release the lock.
Run `npx sst unlock --stage dev` and retry.

**Service stuck at `rolloutState: FAILED` with 1 running task** — stale state
from an earlier failed deploy. If `runningCount == desiredCount` the service
is fine. `aws ecs describe-services` will show the old event, ignore it.

**Target group shows `unhealthy`** — the `loadBalancer.health.path` doesn't
match what the container actually serves. Check by curling the ALB URL
directly: `curl http://<alb-dns>/<health-path>`. Fix the path in
`sst.config.ts` and redeploy.

**Runner never registers with API** — the API service uses `RUNNER_PRIVATE_IP`
from `.env` to build its URL. First deploy creates the EC2 instance; second
deploy (after adding `RUNNER_PRIVATE_IP=...` to `.env`) wires it into the API.

**SSH gateway accepts connections but all auths fail** — `SSH_PRIVATE_KEY_B64`
/ `SSH_HOST_KEY_B64` aren't set. See "Second deploy" above.

**`go mod tidy` fails in otel-collector Docker build** — workspace paths
diverged. Check `apps/otel-collector/builder-config.yaml` replaces: they
must point at `../../../apps/api-client-go` and `../../../apps/common-go`.

## Cost (ap-southeast-1, always-on)

| Resource                           | Monthly |
|------------------------------------|---------|
| EC2 c8i.2xlarge (Runner)           | ~$245   |
| NAT EC2 instance                   | ~$5     |
| 10× Fargate 0.25 vCPU / 0.5 GB     | ~$80    |
| RDS `t4g.micro` Postgres           | ~$15    |
| ElastiCache Redis                  | ~$15    |
| ALBs (11×)                         | ~$180   |
| CloudFront + S3 + CloudWatch Logs  | ~$20    |
| **Total**                          | **~$560** |

`npx sst remove --stage dev` tears it all down; S3 buckets and RDS snapshots
are retained in production stage (`--stage production`) per SST's default.
