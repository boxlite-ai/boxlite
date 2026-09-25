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
The vendored schema currently renders 72-hour retention.
Keep database/user settings aligned with the bundled schema and boot scripts;
`otel`, `otel_writer` and `otel_reader` are the example's supported baseline.

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
