## TL;DR

Select the telemetry backend with shared inputs, then use the chosen cloud’s lifecycle and access procedures.

# Shared observability configuration

[Infrastructure index](../README.md)

| Cloud | Guide |
| --- | --- |
| AWS | [CloudWatch, EBS and private UI access](aws/clickhouse.md) |
| GCP | [Cloud Logging, Hyperdisk and ClickStack PSC](gcp/clickhouse.md) |

## Two telemetry paths

Application OTLP travels through `apps/otel-collector`, which supports BoxLite organization export
and optional ClickHouse export. Platform stdout/stderr, load-balancer health and cloud logs remain
in the selected cloud’s logging service. Disabling ClickHouse does not disable platform logging
or organization-configured OTLP destinations.

## Select a backend

Set `stages.<stage>.deploy.clickhouse.mode` in `.mstage.config.json` for mdeploy.

| Mode | Resources owned by this stack | Operator responsibility |
| --- | --- | --- |
| `self-hosted` | VM, boot/data disks, credentials and private endpoint | Capacity, retention, recovery and schema lifecycle |
| `managed` | Runtime references to an existing endpoint and credentials | Provision compatible schema/users and network reachability |
| `disabled` | No ClickHouse backend/exporter | Use other telemetry destinations as needed |

Self-hosted size and disk capacity come from `deploy.clickhouse.instanceSize` and `dataGb`.
`CLICKHOUSE_RETENTION_HOURS` (stage environment, positive integer hours, default `720`) sets
the TTL of the seven telemetry tables. It is rejected unless the ClickHouse mode is `self-hosted`.

| Cloud | How a changed value reaches existing tables |
| --- | --- |
| AWS | The SSM readiness command re-runs and alters every table TTL during the deploy. |
| GCP | An OS Config policy alters the TTLs on the host's next agent cycle, without a restart or VM replacement. Check the `clickhouse-retention` compliance report before treating the change as applied. |

Both clouds judge compliance by the `toIntervalHour(N)` marker in each table's `create_table_query`.
New GCP tables are bootstrapped at the default TTL and converge to the configured value afterwards.
Expiry runs in the background; raising retention cannot recover rows already deleted.
Moving a GCP host off the former 72-hour bootstrap schema replaces its VM once; the data disk is kept.
Keep database/user settings aligned with the bundled schema and boot scripts;
`otel`, `otel_writer` and `otel_reader` are the example's supported baseline.

## Optional OpenAPI log reader

Enable the dedicated account with the optional mstage deploy flag:

```bash
npm run mstage env set -- --stage dev --digest OTEL_OPENAPI_ENABLED=true
```

Add `--confirm` for protected stages. Missing, blank or `false` disables provisioning;
only `true` enables it. Other values fail. The feature requires self-hosted `otel`.

The SQL username is fixed at `otel_openapi_reader`. Secret naming follows each
cloud's existing `otel_reader` factory; neither the username nor naming rule is configurable.

| Cloud | Secret name | Credential reference |
| --- | --- | --- |
| GCP | `<app>-<stage>-clickhouse-openapi-reader` | `projects/<project>/secrets/<name>/versions/<version>` |
| AWS | `<app>-<stage>-clickhouse-openapi-reader-<generated-suffix>` | The resource's actual Secrets Manager ARN |

For example, AWS uses the prefix `boxlite-app-dev-clickhouse-openapi-reader-`.
The unique suffix avoids reusing a name still in the seven-day deletion recovery window.
No credential or secret address belongs in mstage.

Like `otel_reader`, the account uses the stack's RandomPassword, Secret and
SecretVersion resources. Deployment state preserves the generated password on an
unchanged redeploy, including the AWS secret name; each stage has its own credential.
Manually created secrets are not automatically imported or overwritten. An existing
GCP exact-name secret blocks creation; AWS creates a separate uniquely named secret.
Do not pre-create secrets under these names or prefixes: extra AWS matches make
consumer discovery ambiguous. State recovery/import requires an explicit ownership plan.

The GCP startup script or AWS SSM readiness command preserves the SQL user's identity
and reapplies the [policy](../clickhouse/openapi-log-reader.sql), removing inherited
roles and old grants. Only SELECT and SHOW COLUMNS on `otel.otel_logs` remain.
The `otel_openapi_reader_limits` profile replaces settings with all 18 immutable
limits. Access data survives on the retained disk. GCP reconciles at boot; AWS
reconciles when deployment inputs, policy SQL or managed credential versions change.
Disabling the flag removes the optional credential resources according to the stack's
normal removal policy; it does not revoke a SQL account already stored on disk.
Review the resource deletion plan before disabling or removing a stage.

Backoffice connects over the private ClickHouse endpoint as `otel_openapi_reader`.
Grant its runtime identity access to this one secret and inject the password through
its platform's secret mechanism. Host IAM is provisioned by this stack; consumer IAM
and application configuration are separate. Keep passwords out of URLs, code and logs.
On AWS, resolve the actual ARN instead of treating the prefix as a complete name.
If discovering by prefix, exclude secrets scheduled for deletion and require exactly
one active match. Refresh consumer references and IAM when a secret is recreated.

Rotate through the existing deployment engine by replacing only the account's
RandomPassword resource, then applying the resulting SecretVersion and host changes.
Inspect the plan first; replacing a secret container or hand-writing a new version
bypasses the managed credential flow. Coordinate Backoffice's credential refresh
with the host change. Keep the previous version until the new login is verified;
rollback must reconcile both the SQL password and consumer credential through the
same deployment state, rather than only moving a cloud version label.

For migration from a separately managed reader, deploy this account and secret,
verify access, then switch the consumer. Old users and external secrets require
explicit cleanup; removing their obsolete stage keys does not delete them.

If an earlier deployment used an exact AWS OpenAPI secret name, preview its replacement
with the generated name before applying. The RandomPassword resource keeps its identity
and inputs, preserving its state-managed value unless separately replaced. Coordinate
the new ARN and consumer IAM/reference updates; the existing readiness step restarts
ClickHouse. This naming migration does not alter GCP resources.

Review rollout impact first: GCP startup changes replace the VM, which
[rejoins its ClickStack backend](gcp/clickhouse.md#clickstack-publication) in the same
deploy; AWS readiness restarts ClickHouse. The data disk is retained, but rollout can interrupt queries.
Check authentication, denied writes/tables/settings and persistence after restart.
Run `BOXLITE_CLICKHOUSE_INTEGRATION=1 make test:apps:infra` with Docker for a
disposable local check. Full stack typechecking uses `make test:apps:infra-config`.

## Managed endpoint

Supply these three values together in the encrypted stage store:

| Key | Value |
| --- | --- |
| `CLICKHOUSE_URL` | HTTPS origin of the managed service |
| `CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN` | Writer credential reference for the stage's cloud |
| `CLICKHOUSE_READER_PASSWORD_SECRET_ARN` | Distinct reader credential reference for the stage's cloud |

The historical `_ARN` suffix remains part of the shared input contract. The selected cloud’s guide
defines its credential-address format and rotation behavior. Keep passwords out of the URL.
Provision the [bundled schema](../clickhouse/otel-schema-v0.144.0.sql) and appropriate reader/writer
grants before deploying; the collector does not create tables automatically.

## Retained data

Retained disks can outlive the instance or a switch to another backend mode. Take a verified backup
before intentional deletion or migration, and inventory detached disks during teardown.
A healthy VM does not prove tables exist or that the collector can insert into them.

## Verify ingestion and queries

1. Emit a uniquely identified test log/trace from a test box or service.
2. Check collector export errors and backend reachability.
3. Confirm the event exists using the reader path available to the API.
4. Verify timestamps and retention, then check any organization OTLP destination separately.

Inspect platform logs and application telemetry independently.

Sources: [shared contract](../mdeploy/stack/clickhouse.ts), [schema renderer](../mdeploy/stack/clickhouse-host.ts), [collector](../../otel-collector/config.yaml).
