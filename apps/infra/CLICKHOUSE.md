# ClickHouse observability

ClickHouse stores direct OTLP logs, traces, and metrics from the existing collector. ECS
`stdout`/`stderr` remains in CloudWatch.

`CLICKHOUSE_MODE` selects the backend:

- `self-hosted` (default): one private `m6a.large` with an encrypted 50 GiB gp3 data volume.
- `managed`: an existing ClickHouse service and two Secrets Manager password secrets.
- `disabled`: no ClickHouse resources or exporter.

The self-hosted rollout is automatic: database readiness, collector rollout, a real OTLP log smoke
test, then the API rollout. Managed mode waits for the collector before the API but needs a manual
synthetic-event check because the deployment runner may not be allowed to reach the managed endpoint.

Managed mode uses one endpoint with separate principals:

```dotenv
CLICKHOUSE_MODE=managed
CLICKHOUSE_URL=https://example.clickhouse.cloud:8443
CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN=arn:aws:secretsmanager:...
CLICKHOUSE_READER_PASSWORD_SECRET_ARN=arn:aws:secretsmanager:...
```

The URL must not contain credentials. Both secret ARNs must be in the deployment's AWS region and
account, with names beginning `boxlite-<stage>-`, matching the runtime permissions boundary.

The managed database must already contain the schema in
`clickhouse/otel-schema-v0.144.0.sql`. Managed mode relies on the collector and API service health;
verify a synthetic OTLP event after switching.

## Private UI

Find the current self-hosted instance and forward its HTTP port:

```sh
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters 'Name=tag:Name,Values=boxlite-<stage>-clickhouse' 'Name=instance-state-name,Values=running' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8123"],"localPortNumber":["18123"]}'
```

Open `http://127.0.0.1:18123/clickstack` and use the `otel_reader` secret. The embedded UI is for
search and debugging; saved HyperDX state is not retained.

The EC2 instance may be replaced by bootstrap changes, but its data volume is retained and
reattached. Switching to managed or disabled mode detaches and retains the old volume outside SST;
take an EBS snapshot before deleting or restoring that retained data.
