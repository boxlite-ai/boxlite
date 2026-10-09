## TL;DR

Restore `CLICKHOUSE_RETENTION_HOURS`, default to 720 hours, and reconcile existing telemetry tables when the desired retention changes.

## Problem and scope

The stage contract rejects retention overrides and both clouds render a fixed 72-hour schema.
AWS already alters existing table TTLs during its readiness command. GCP only creates tables at
boot; `CREATE TABLE IF NOT EXISTS` cannot change an existing TTL. Existing hosts must receive
subsequent retention updates without replacement or an operator SSH session. Adopting the
new bootstrap script can require one instance replacement, reusing the separate data disk.

The input remains an optional stage environment value, measured in positive integer hours.
Omitting it selects 720 hours (30 days). This change owns self-hosted telemetry tables only;
managed schema lifecycle remains the managed service operator's responsibility.

## Related work and lessons

- `apps/infra/deployment/clickhouse.ts:23`: the legacy contract explicitly rejects old tuning
  inputs. Remove only retention from that rejection and register it in both stage contracts.
- `apps/infra/scripts/clickhouse-ops.mjs:29`: AWS reconciles all seven tables with `MODIFY TTL`
  and checks their stored definitions. Reuse its command and include retention in deploy inputs.
- `apps/infra/mdeploy/stack/providers/gcp/clickhouse.ts:194`: boot-time schema creation cannot
  update an existing table. Use the default bootstrap TTL and reconcile configured TTLs separately.
- `apps/infra/mdeploy/stack/providers/gcp/runners.ts:480`: OS Config already provides in-place
  convergence without OS Login. Adapt that mechanism for authenticated TTL validation/enforcement.
- [ClickHouse ALTER TTL](https://clickhouse.com/docs/reference/statements/alter/ttl): use
  `MODIFY TTL` on existing tables rather than recreating data. Expiration runs in the background;
  increasing retention cannot restore previously expired data.
- [Google OS policies](https://docs.cloud.google.com/compute/vm-manager/docs/os-policies/working-with-os-policies):
  exec validation returns 100 for compliance and 101 to request enforcement. Authenticate locally,
  check actual table definitions, and return errors separately from a retention mismatch.

## Approach and trade-offs

Validate the environment at the deployment boundary before constructing resources. Share the
default and parser between legacy deploy and mdeploy; carry the resolved value to providers.
Render the AWS initial schema with that value. On AWS it changes the readiness command environment
and triggers SSM reconciliation. On GCP a labelled instance receives an OS policy whose script
changes with retention. Validation reads actual TTLs; enforcement alters all seven tables and
revalidates. This also repairs partial updates on a later agent cycle, without restarting ClickHouse.
GCP bootstrap uses a fixed 720-hour schema; only its policy depends on configured retention.
Keep startup-script changes visible so pinned secret versions reach the host when credentials rotate.
Those changes preserve the existing replacement path, while later TTL-only updates preserve the VM.
New tables use the bootstrap TTL until the agent converges; existing table TTLs change only through ALTER.

[Pulumi ignoreChanges](https://www.pulumi.com/docs/iac/concepts/resources/options/ignorechanges/)
reuses stored inputs. Ignoring the entire script freezes credentials while consumers advance.
[GCP metadataStartupScript](https://www.pulumi.com/registry/packages/gcp/api-docs/compute/instance/)
changes force replacement. Preserve that path instead of adding account reconciliation here.

GCP enforcement is asynchronous, like the existing runner OS policies. Deploy publishes the
desired state; OS Config compliance reports establish application on the host. Document that
completion boundary rather than claim a successful Pulumi apply proves SQL completion.

Reject SSH-based updates because deployed callers may lack a usable OS Login identity. Reject
instance replacement/reboot for TTL-only changes because those do not require service downtime.
Do not add a second JSON retention setting with precedence rules.

## Validation and delivery

Run tests with production unchanged first, then implement and rerun `make test:apps:infra`.
Provider-boundary regression tests must fail before the fix when TTL changes alter the startup
script and when any account's credential update is ignored. Exercise default/override/invalid inputs, rendered
schema, stack wiring, and GCP validate/enforce scripts through fake command boundaries, including
unchanged TTL, changed TTL, partial table convergence and command failure. Check shell syntax.
Local tests do not prove cloud IAM/agent availability; no live deployment is part of this task.
