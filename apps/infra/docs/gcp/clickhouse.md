## TL;DR

GCP hosts optional ClickHouse on Compute Engine with retained Hyperdisk and exposes ClickStack through Private Service Connect.

# GCP observability and ClickHouse

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

Follow the shared [backend configuration](../clickhouse.md#select-a-backend)
and [ingestion checks](../clickhouse.md#verify-ingestion-and-queries).
Platform stdout/stderr, load-balancer health and cloud logs remain in Cloud Logging.

## Managed credentials

The shared `_PASSWORD_SECRET_ARN` keys use `projects/<project>/secrets/<secret>` in the stage's project,
optionally followed by `/versions/<version>`; omission selects `latest`. A pinned version makes rotation
an explicit deployment input. Check runtime grants and restart/rollout behavior for either form.

## Self-hosted lifecycle

| Concern | Behavior |
| --- | --- |
| Hosting | N4 VM, boot disk and separate retained Hyperdisk Balanced data disk |
| Setup | Startup mounts the disk, installs ClickHouse and applies schema/users |
| Rotation/schema | Requires the appropriate startup/reconciliation cycle; apply alone is insufficient evidence |
| Queries | API and collector use Direct VPC egress to TCP 8123 |

## ClickStack publication

Self-hosted GCP ClickHouse also creates an internal passthrough load balancer and PSC service
attachment. The consumer endpoint and ClickStack UI belong to the separate Backoffice stack.
The current producer accepts endpoints from its own project. Connection acceptance and
reader-secret access are distinct: `CLICKSTACK_CONSUMER_ACCOUNT` grants
the named service account reader-secret access; it does not itself create a consumer endpoint.
See [publication source](../../mdeploy/stack/providers/gcp/clickstack.ts) and the full [data-path graph](architecture.md#gcp-runtime-and-data-paths).


## Verify the result

Check tables, collector insertion and the API's distinct reader path. A healthy VM is insufficient.
Verify ingestion and queries after each deployment.
See [retained data precautions](../clickhouse.md#retained-data) before changing backend mode or removing disks.

Sources: [ClickHouse provider](../../mdeploy/stack/providers/gcp/clickhouse.ts),
[ClickStack publication](../../mdeploy/stack/providers/gcp/clickstack.ts).
