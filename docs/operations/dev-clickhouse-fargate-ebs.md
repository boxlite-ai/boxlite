# Dev ClickHouse on Fargate + EBS

This runbook describes the cheapest dev-only ClickHouse fallback for BoxLite when ClickHouse Cloud is unavailable.

## Scope

- Dev only.
- Region: `ap-southeast-1`.
- ECS cluster: `boxlite-dev-ClusterCluster-vmauahcx`.
- Private VPC access only.
- Not production-ready.

## Cost

Default config:

- Fargate ARM: `0.5 vCPU / 1GB`.
- EBS gp3: `50GB`.

Approximate monthly cost if left running 24/7:

- Compute: about `$18/month`.
- EBS: about `$5/month`.
- Total: about `$23/month`, excluding CloudWatch logs and data transfer.

## Durability Warning

ECS service-managed EBS volumes are deleted when service-managed tasks terminate. This service is intentionally a dev telemetry fallback, not a durable ClickHouse database.

For durable dev storage, use EC2 + EBS instead.

## Required Secrets

Set these only on the remote worker shell or remote secret env file:

```bash
export CLICKHOUSE_WRITER_PASSWORD='<secret>'
```

Do not commit these values.

The cheapest dev fallback uses the same ClickHouse user for writer and reader. This is intentionally dev-only.

## Plan

Run from `boxlite-dev`:

```bash
cd /home/brian/work/boxlite/repos/boxlite
scripts/deploy/dev-clickhouse-fargate-ebs.sh plan
```

Expected:

- Prints config.
- Prints AWS identity.
- Security group dry-run returns `DryRunOperation`.

## Create

Stop for PR review before running this command.

```bash
cd /home/brian/work/boxlite/repos/boxlite
export CLICKHOUSE_WRITER_PASSWORD='<secret>'
scripts/deploy/dev-clickhouse-fargate-ebs.sh create
```

## Status

```bash
scripts/deploy/dev-clickhouse-fargate-ebs.sh status
```

Expected:

- ECS service desired count is `1`.
- ECS service running count becomes `1`.
- A task private IP is printed.

## Print BoxLite Env

```bash
scripts/deploy/dev-clickhouse-fargate-ebs.sh print-env
```

Use the output to update the dev infra env. Keep password values in remote secret env only.

## Deploy OtelCollector

Stop before deploy and inspect diff:

```bash
cd apps/infra
npx sst diff --stage dev --target OtelCollector
```

If scoped, deploy:

```bash
npx sst deploy --stage dev --target OtelCollector
```

If target deploy shows Runner dependency errors or broad unrelated deletes/creates, stop and report before widening scope.

## Deploy API

Deploy API only if reader env changed:

```bash
cd apps/infra
npx sst diff --stage dev --target Api
npx sst deploy --stage dev --target Api
```

## Verify

Check service:

```bash
scripts/deploy/dev-clickhouse-fargate-ebs.sh status
```

Check ClickHouse from inside the VPC with the printed private IP:

```bash
curl -sS http://<private-ip>:8123/ping
```

Expected:

```text
Ok.
```

Check `OtelCollector`:

```bash
aws ecs describe-services \
  --region ap-southeast-1 \
  --cluster boxlite-dev-ClusterCluster-vmauahcx \
  --services OtelCollector \
  --query 'services[0].{desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState}'
```

Expected:

```json
{"desired":1,"running":1,"rollout":"COMPLETED"}
```

Check API:

```bash
curl -fsS https://dev.boxlite.ai/api/health
```

Expected:

```json
{"status":"ok"}
```

## Rollback

1. Restore the previous remote `.env` backup.
2. Redeploy `OtelCollector` if writer env changed.
3. Redeploy `Api` if reader env changed.
4. Delete the dev ClickHouse service only after telemetry is no longer pointing at it:

```bash
scripts/deploy/dev-clickhouse-fargate-ebs.sh delete
```
