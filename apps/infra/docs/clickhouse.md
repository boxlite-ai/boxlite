## TL;DR

The collector writes telemetry to the selected ClickHouse backend, while the API reads it with separate credentials.

# Observability and ClickHouse

[Infrastructure index](../README.md) · [Architecture](architecture.md) · [Status page](status-page.md)

## Two telemetry paths

Application OTLP travels through `apps/otel-collector`, which supports BoxLite organization export
and optional ClickHouse export. Platform stdout/stderr, load-balancer health and cloud logs remain
in Cloud Logging on GCP or CloudWatch on AWS. Disabling ClickHouse does not disable platform logging
or organization-configured OTLP destinations.

## Select a backend

Set `stages.<stage>.deploy.clickhouse.mode` in `.mstage.config.json` for mdeploy.
The retained legacy stack instead uses `CLICKHOUSE_MODE` in its stage environment.

| Mode | Resources owned by this stack | Operator responsibility |
| --- | --- | --- |
| `self-hosted` | VM, boot/data disks, credentials and private endpoint | Capacity, retention, recovery and schema lifecycle |
| `managed` | Runtime references to an existing endpoint and credentials | Provision compatible schema/users and network reachability |
| `disabled` | No ClickHouse backend/exporter | Use other telemetry destinations as needed |

Self-hosted size and disk capacity come from `deploy.clickhouse.instanceSize` and `dataGb`.
GCP uses N4 and Hyperdisk Balanced; AWS uses EC2 and EBS. The vendored schema currently renders
72-hour retention. Keep database/user settings aligned with the bundled schema and boot scripts;
`otel`, `otel_writer` and `otel_reader` are the example's supported baseline.

## Managed endpoint

Supply these three values together in the encrypted stage store:

| Key | Value |
| --- | --- |
| `CLICKHOUSE_URL` | HTTPS origin of the managed service |
| `CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN` | Writer credential reference for the stage's cloud |
| `CLICKHOUSE_READER_PASSWORD_SECRET_ARN` | Distinct reader credential reference for the stage's cloud |

The historical `_ARN` suffix is shared across clouds. AWS references use Secrets Manager ARNs;
GCP uses `projects/<project>/secrets/<secret>` in the stage's project, optionally followed by
`/versions/<version>`; omission selects `latest`. A pinned version makes rotation an explicit
deployment input. Check runtime grants and restart/rollout behavior when rotating either form. Keep passwords out of the URL.
Provision the [bundled schema](../clickhouse/otel-schema-v0.144.0.sql) and appropriate reader/writer
grants before deploying; the collector does not create tables automatically.

## Self-hosted lifecycle

| Concern | GCP | AWS |
| --- | --- | --- |
| Setup | Startup script mounts disk, installs ClickHouse, applies schema/users | Boot plus SSM reconciliation |
| Rotation/schema changes | Require the appropriate host startup/reconciliation cycle; a resource apply alone is insufficient proof | Provider reconciliation applies schema/credentials over SSM |
| Persistent data | Separate retained Hyperdisk | Separate retained EBS volume |
| Query path | API and collector direct VPC egress to TCP 8123 | Private service/host connectivity |

Retained disks can outlive the instance or a switch to another backend mode. Take a verified backup
before intentional deletion or migration, and inventory detached disks during teardown.
A healthy VM does not prove tables exist or that the collector can insert into them.

## GCP ClickStack publication

Self-hosted GCP ClickHouse also creates an internal passthrough load balancer and PSC service
attachment. The consumer endpoint and ClickStack UI belong to the separate Backoffice stack.
The current producer accepts endpoints from its own project. Connection acceptance and
reader-secret access are distinct: `CLICKSTACK_CONSUMER_ACCOUNT` grants
the named service account reader-secret access; it does not itself create a consumer endpoint.
See [publication source](../mdeploy/stack/providers/gcp/clickstack.ts) and the full [data-path graph](architecture.md#gcp-runtime-and-data-paths).

## AWS private UI

Find the intended ClickHouse instance, then use an authorized SSM session:

```bash
aws ssm start-session --target <instance-id>   --document-name AWS-StartPortForwardingSession   --parameters '{"portNumber":["8123"],"localPortNumber":["18123"]}'
```

Open `http://127.0.0.1:18123/clickstack` using the reader credential. The embedded UI's saved state
is not the retained ClickHouse telemetry dataset. Confirm the target account, region and instance first.

## Verify ingestion and queries

1. Emit a uniquely identified test log/trace from a test box or service.
2. Check collector export errors and backend reachability.
3. Confirm the event exists using the reader path available to the API.
4. Verify timestamps and retention, then check any organization OTLP destination separately.

The retained legacy deployment includes its own self-hosted smoke checks. Do not infer that the
current GCP apply performs those same tests. Inspect platform logs and application telemetry independently.

Sources: [shared contract](../mdeploy/stack/clickhouse.ts), [schema renderer](../mdeploy/stack/clickhouse-host.ts),
[GCP provider](../mdeploy/stack/providers/gcp/clickhouse.ts), [AWS provider](../mdeploy/stack/providers/aws/clickhouse.ts),
[collector configuration](../../otel-collector/config.yaml).
