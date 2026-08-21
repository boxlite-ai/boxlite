# ClickHouse observability

ClickHouse stores direct OTLP logs, traces, and metrics from the existing collector. ECS
`stdout`/`stderr` remains in CloudWatch.

`CLICKHOUSE_MODE` selects the backend:

- `self-hosted` (default): one private `m6a.large` with an encrypted 50 GiB gp3 data volume.
- `managed`: an existing ClickHouse service and two Secrets Manager password secrets.
- `disabled`: no ClickHouse resources or exporter.

Self-hosted sizing and schema are deliberately fixed: `m6a.large`, 50 GiB gp3, 72-hour retention,
database `otel`, and the `otel_writer` / `otel_reader` principals.

When upgrading from an earlier configuration, remove the old instance, disk, retention, database,
and username keys from `apps/infra/.env`, then rerun `npm run bootstrap -- --stage <stage>`. The
deploy fails closed while the SST stage store still names one of those removed keys.

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

The URL must be an origin only, with no path, query, fragment, or credentials; this prevents the
collector and API clients from interpreting one connection string differently. Both secret ARNs
must be distinct, in the deployment's AWS region and account, and have names beginning
`boxlite-<stage>-`, matching the runtime permissions boundary.

The managed database must already contain the schema in
`clickhouse/otel-schema-v0.144.0.sql` with the same database and principals. Managed mode relies on
the collector and API service health; after switching, verify both OTLP ingestion as `otel_writer`
and a query as `otel_reader`.

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

## Authenticated ClickStack gateway

Set the five `CLICKSTACK_*` stage values documented in `.env.example`, then store a dedicated
confidential OIDC application's credentials without writing them to `.env`:

```bash
npm run sst -- secret set CLICKSTACK_OIDC_CLIENT_ID --stage <stage>
npm run sst -- secret set CLICKSTACK_OIDC_CLIENT_SECRET --stage <stage>
```

Register `https://clickstack.<STACK_DOMAIN>/oauth2/idpresponse` as that application's callback URL.
After deployment, Backoffice can set `BACKOFFICE_CLICKSTACK_URL` to
`https://clickstack.<STACK_DOMAIN>/clickstack`; no workstation SSM tunnel is required.

The public ALB performs OIDC login. The gateway then verifies the Auth0 access-token signature,
audience, `boxlite-backoffice` scope, and configured Operator/Admin provider-role values before it
injects the server-side `otel_reader` credential. ClickHouse port 8123 remains private, and the
browser never receives the database password. Keep the SSM procedure above as break-glass access.

The EC2 instance may be replaced by bootstrap changes, but its data volume is retained and
reattached. Switching to managed or disabled mode detaches and retains the old volume outside SST;
take an EBS snapshot before deleting or restoring that retained data.
