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

## Backoffice ClickStack gateway

The optional gateway makes the self-hosted ClickStack UI available without an
operator workstation tunnel. ClickHouse port 8123 stays private. A logged-in
Backoffice employee requests a 30-second, single-use handoff code; the browser
posts it to the gateway, which redeems it with Backoffice and creates a
five-minute HttpOnly session. The gateway strips browser-supplied credentials
and injects the server-side `otel_reader` password. Backoffice logout or lost
presence does not revoke an already-issued gateway cookie; its remaining access
is bounded by the five-minute expiry.

Configure the public Backoffice endpoints in the BoxLite stage configuration:

```dotenv
CLICKSTACK_GATEWAY_ENABLED=true
CLICKSTACK_BACKOFFICE_REDEEM_URL=https://backoffice.dev.boxlite.ai/api/backoffice/v1/observability/clickstack/redeem
CLICKSTACK_BACKOFFICE_ENTRY_URL=https://backoffice.dev.boxlite.ai/platform/observability
```

Set both secrets through SST's non-echoing secret prompt. `CLICKSTACK_REDEEM_TOKEN`
is JSON containing current and optional previous 32-byte base64url tokens used
only for Gateway-to-Backoffice authentication. A legacy single token remains
accepted for initial compatibility, but production rotation uses the JSON form.
`CLICKSTACK_SESSION_KEYS` is JSON containing a current signing
key and, during rotation, an optional previous key:

```json
{ "current": "BASE64URL_32_BYTE_KEY", "previous": "OPTIONAL_PREVIOUS_BASE64URL_32_BYTE_KEY" }
```

```bash
cd apps/infra
npm run sst -- secret set CLICKSTACK_REDEEM_TOKEN --stage <stage>
npm run sst -- secret set CLICKSTACK_SESSION_KEYS --stage <stage>
npm run deploy -- --stage <stage>
```

Rotate session keys in three deployments so mixed ECS revisions accept each
other's cookies: deploy `{current: old, previous: new}` and wait for convergence;
then deploy `{current: new, previous: old}`; after another convergence plus five
minutes, deploy `{current: new}`. Skipping the first phase can make old tasks
reject cookies issued by new tasks.

Rotate the redeem token with the same three phases. Unlike session cookies, no
five-minute wait is needed before phase 3, but both Gateway and Backoffice must
have fully converged on phase 2 before removing the previous token. Its stable
Secrets Manager copy remains in the stack while the gateway flag is off, so a
normal disable/re-enable cannot collide with a secret pending recovery.
The disabled stack stores only an invalid non-empty sentinel in that runtime
copy; enabling the gateway removes the fallback and requires a real key set at
deployment planning time.

Then configure Backoffice's `BACKOFFICE_CLICKSTACK_URL` as
`https://clickstack.<STACK_DOMAIN>/clickstack` and deploy the matching
Backoffice handoff implementation. Keep `CLICKSTACK_GATEWAY_ENABLED=false`
until both sides, the redeem token, and the session keys are ready. The gateway supports only the
self-hosted backend because managed ClickHouse does not provide this embedded
UI. The SSM tunnel remains the break-glass path.

The EC2 instance may be replaced by bootstrap changes, but its data volume is retained and
reattached. Switching to managed or disabled mode detaches and retains the old volume outside SST;
take an EBS snapshot before deleting or restoring that retained data.
