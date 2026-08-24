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

The gateway is supported only with the self-hosted backend, whose ClickHouse server exposes the
embedded `/clickstack` UI. Managed mode does not define a ClickStack UI endpoint and is rejected.

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

### Employee SSO deployment

The Gateway and Backoffice are separate OIDC clients. Create a confidential Regular Web Application
in the same isolated employee Auth0 tenant used by Backoffice; do not use the BoxLite customer tenant.
Configure that application with:

- callback URL `https://clickstack.<STACK_DOMAIN>/oauth2/idpresponse`;
- the same API audience used by Backoffice, whose Auth0 API defines the `boxlite-backoffice` scope;
- the same corporate connection(s) enabled for the Backoffice client;
- the Backoffice tenant's existing post-login Action, which adds the configured namespaced role
  claim to the access token, with only the Operator/Admin provider-role values admitted by the
  Gateway.

Do not infer the audience, role-claim name, or provider-role values from the examples below. Copy
the exact non-secret values from Backoffice's authoritative
`/boxlite/backoffice/<stage>/stage-auth-config` SSM parameter: use `audience`, `roleClaim`, and the
entries under `roleMappings.operator` and `roleMappings.admin`. The issuer must name that same
employee Auth0 tenant. A mismatch passes static configuration validation but causes authenticated
requests to be rejected by the Gateway.

Put only the non-secret values in `apps/infra/.env`, then persist the stage configuration and set the
two application secrets through the non-echoing SST secret prompt:

```dotenv
CLICKHOUSE_MODE=self-hosted
CLICKSTACK_GATEWAY_ENABLED=true
CLICKSTACK_OIDC_ISSUER_BASE_URL=https://YOUR_EMPLOYEE_TENANT.auth0.com/
CLICKSTACK_OIDC_AUDIENCE=YOUR_EXACT_BACKOFFICE_API_AUDIENCE
CLICKSTACK_OIDC_ROLE_CLAIM=YOUR_EXACT_BACKOFFICE_ROLE_CLAIM
CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES=backoffice-operator,backoffice-admin
```

```bash
cd apps/infra
npm run bootstrap -- --stage <stage>
npm run sst -- secret set CLICKSTACK_OIDC_CLIENT_ID --stage <stage>
npm run sst -- secret set CLICKSTACK_OIDC_CLIENT_SECRET --stage <stage>
npm run deploy -- --stage <stage>
```

Set `BACKOFFICE_CLICKSTACK_URL=https://clickstack.<STACK_DOMAIN>/clickstack` in the Backoffice deploy
environment and redeploy Backoffice. Its Operator/Admin roles already carry
`observability.clickstack.open`; other roles do not receive the link capability.

Each deployed commit or release, as well as enabling or disabling the Gateway, retriggers the real
OTLP log smoke. The Gateway deployment waits for its unique marker to reach `otel.otel_logs` through
the Collector. At runtime, its ALB target check calls `/ready`, which reads from `otel.otel_logs` as
`otel_reader` and validates the embedded ClickStack HTML shell plus its runtime environment script.
The Gateway maps the shell's root `/__ENV.js` request to ClickHouse's embedded
`/clickstack/__ENV.js` path. An unreachable ClickHouse, missing table or UI asset, invalid response,
or invalid reader credential removes the target from service. A post-deploy public smoke also
verifies that the unauthenticated HTTPS URL redirects to the configured employee Auth0 `/authorize`
endpoint with the expected callback, audience, and `boxlite-backoffice` scope. Employee login, MFA,
role-claim issuance, and the authenticated browser render remain a one-time manual rollout check
because the deployment must not hold an employee session or bypass the identity provider.
After signing in through Backoffice, open ClickStack and search the last 24 hours for
`ServiceName:"boxlite-clickhouse-readiness"` to confirm the deployment marker is queryable. An active
Auth0 SSO session usually avoids another password prompt, but Auth0 may still require MFA, consent, or
fresh authentication according to tenant policy.

The EC2 instance may be replaced by bootstrap changes, but its data volume is retained and
reattached. Switching to managed or disabled mode detaches and retains the old volume outside SST;
take an EBS snapshot before deleting or restoring that retained data.
