## TL;DR

AWS hosts optional ClickHouse on EC2 with retained EBS and SSM reconciliation and access.

# AWS observability and ClickHouse

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Follow the shared [backend configuration](../clickhouse.md#select-a-backend)
and [ingestion checks](../clickhouse.md#verify-ingestion-and-queries).
Platform stdout/stderr, load-balancer health and cloud logs remain in CloudWatch.
The retained legacy stack selects its mode through `CLICKHOUSE_MODE`; mdeploy uses the stage declaration.

## Managed credentials

The writer/reader `_PASSWORD_SECRET_ARN` inputs are separate Secrets Manager ARNs.
Check runtime read grants and restart/rollout behavior when rotating credentials; keep passwords out of the URL.

## Self-hosted lifecycle

| Concern | Behavior |
| --- | --- |
| Hosting | EC2 with a separate retained EBS data volume |
| Setup | Boot and SSM reconciliation install schema/users |
| Rotation/schema | Provider reconciliation applies changes over SSM |
| Queries | Private service/host connectivity |

## Private UI

Find the intended ClickHouse instance, then use an authorized SSM session:

```bash
aws ssm start-session --target <instance-id>   --document-name AWS-StartPortForwardingSession   --parameters '{"portNumber":["8123"],"localPortNumber":["18123"]}'
```

Open `http://127.0.0.1:18123/clickstack` using the reader credential. The embedded UI's saved state
is not the retained ClickHouse telemetry dataset. Confirm the target account, region and instance first.


## Verify the result

Verify insertion and queries independently of VM health. The retained legacy deployment includes
self-hosted smoke checks; do not assume current mdeploy performs the same checks.
See [retained data precautions](../clickhouse.md#retained-data) before changing backend mode or removing disks.

Source: [ClickHouse provider](../../mdeploy/stack/providers/aws/clickhouse.ts).
