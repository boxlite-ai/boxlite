# Dev ClickHouse Fallback

This runbook covers the SST-managed dev-only ClickHouse fallback used when ClickHouse Cloud is unavailable.

## Scope

- Dev only. `DEV_CLICKHOUSE_ENABLED=true` is rejected in `production`.
- Region: `ap-southeast-1`.
- Runs as the `DevClickHouse` ECS Fargate service in the existing SST cluster.
- Private-only internal ALB, same pattern as `MailDev`.
- Uses one ECS service-managed EBS volume mounted at `/var/lib/clickhouse`.

## Cost

Default config:

- Fargate ARM: `0.5 vCPU / 1 GB`.
- EBS gp3: `50 GB`.
- Internal ALB created by `sst.aws.Service`.

Approximate monthly cost if left running 24/7:

- Fargate compute: about `$18/month`.
- EBS: about `$5/month`.
- Internal ALB: region-dependent, often roughly `$18+/month` before LCU usage.
- CloudWatch logs and data transfer are extra.

## Durability

The fallback is for dev telemetry continuity, not durable analytics storage. ECS service-managed EBS volumes are attached to service tasks and can be replaced when the service is replaced or removed.

## Enable

Set this in `apps/infra/.env` for dev:

```bash
DEV_CLICKHOUSE_ENABLED=true
DEV_CLICKHOUSE_EBS_GB=50
```

Optional overrides:

```bash
DEV_CLICKHOUSE_USERNAME=boxlite_otel_writer
DEV_CLICKHOUSE_DATABASE=otel
DEV_CLICKHOUSE_PASSWORD=<secret>
```

If `DEV_CLICKHOUSE_PASSWORD` is unset, SST generates `DevClickHousePassword`.

When enabled, SST automatically:

- creates the private `DevClickHouse` service,
- creates the ECS infrastructure role required for service-managed EBS,
- configures `OtelCollector` to write to the internal ClickHouse URL,
- configures `Api` to read from the same internal ClickHouse URL,
- enables ClickHouse schema creation for the collector by default.

Existing `CLICKHOUSE_*` cloud endpoint env values do not win over `DEV_CLICKHOUSE_ENABLED=true`; the dev fallback becomes the active read/write backend.

## Deploy

Preview first:

```bash
cd apps/infra
npx sst diff --stage dev
```

Deploy after review:

```bash
npx sst deploy --stage dev
```

Avoid target-only deploys for the first enablement. `DevClickHouse`, `OtelCollector`, and `Api` need to roll together.

## Verify

Check ECS services:

```bash
aws ecs describe-services \
  --region ap-southeast-1 \
  --cluster boxlite-dev-ClusterCluster-vmauahcx \
  --services DevClickHouse OtelCollector Api \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,rollout:deployments[0].rolloutState}'
```

Expected:

```json
[
  { "service": "DevClickHouse", "desired": 1, "running": 1, "rollout": "COMPLETED" },
  { "service": "OtelCollector", "desired": 1, "running": 1, "rollout": "COMPLETED" },
  { "service": "Api", "desired": 1, "running": 1, "rollout": "COMPLETED" }
]
```

Check API:

```bash
curl -fsS https://dev.boxlite.ai/api/health
```

Expected:

```json
{ "status": "ok" }
```

Check `OtelCollector` logs for current-task ClickHouse exporter errors. Ignore old stopped task streams from the pre-SST manual fallback.

## Remove Old Manual Fallback

After the SST-managed `DevClickHouse` service is deployed and verified, delete the old manual fallback resources:

- ECS service: `boxlite-dev-clickhouse`
- task family: `boxlite-dev-clickhouse`
- security group: `boxlite-dev-clickhouse-fargate-sg`
- IAM roles:
  - `boxlite-dev-clickhouse-task-execution-role`
  - `boxlite-dev-clickhouse-ebs-infra-role`
- log group: `/boxlite/dev/clickhouse`

Do not delete them before `Api` and `OtelCollector` are confirmed to use SST-managed `DevClickHouse`.

## Rollback

To return dev to ClickHouse Cloud:

1. Set `DEV_CLICKHOUSE_ENABLED=false` or remove it.
2. Restore the desired `CLICKHOUSE_WRITER_*` and `CLICKHOUSE_READER_*` env values.
3. Run `npx sst diff --stage dev`.
4. Run `npx sst deploy --stage dev`.
