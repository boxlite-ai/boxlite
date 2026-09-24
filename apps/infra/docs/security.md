## TL;DR

Keep bootstrap, deployment, and runtime identities distinct, and verify each cloud's actual permission and network boundaries.

# Infrastructure security

[Infrastructure index](../README.md) · [Configuration](configuration.md) · [Networking](networking.md)

## Identity boundaries

| Identity | GCP | AWS |
| --- | --- | --- |
| Bootstrap operator | Enables APIs and manages project IAM, federation and prerequisite stores | Reconciles IAM policies, trust and prerequisite stores |
| CI deployer | GitHub Workload Identity Federation → deployer service account | GitHub OIDC → stage deploy role |
| Image publisher | Separate Artifact Registry publisher service account | Stage registry access through the workflow's AWS role |
| Runtime | Service accounts per workload; GKE Workload Identity for proxy | Task/instance roles capped by runtime permissions boundary |

GCP bootstrap grants broad project administration, including project IAM administration. It does not
provide an AWS-style permissions boundary that prevents deployer privilege escalation. Review project
isolation and organization policy when deciding what a stage may administer.
GitHub Environment names, federation trust and reviewer settings are separate controls; inspect the
live Environment after bootstrap rather than inferring its protections from workflow YAML.

## Configuration and secret handling

mstage stores an encrypted stage map in GCS/S3. Its passphrase is in Secret Manager/SSM; deployment
state has its own engine-specific storage. Required/optional groups in `mstage.env.json` govern which
values a consumer receives. The ignored stage declaration is carried through a GitHub variable and
must not contain secret values. See [configuration](configuration.md).

`env list` reports names. `--values` and `--json` reveal values; write secrets through stdin and avoid
shell tracing. Runtime delivery may place values in resource definitions or encrypted Pulumi state;
a secret's storage encryption is not a claim that every downstream representation hides it.
Use the platform secret-reference channel only where the consumer supports it and has read access.

Preserve state encryption keys and object versions needed for recovery. Never rotate a Pulumi
passphrase by simply replacing the stored value: existing state must remain decryptable.

## Runtime and network boundaries

- Public traffic enters through the load balancers; GCP runners and GKE nodes have private addresses.
- Direct Cloud Run egress uses CIDR-based VM ingress rules, with the shared-subnet limitation described in [networking](networking.md).
- The collector's internal ingress restriction remains meaningful even where its invoker IAM binding permits `allUsers`.
- Database/cache use private connectivity. API and collector have different ClickHouse reader/writer credentials.
- Volume access uses scoped temporary credentials and bucket-prefix permissions; stage naming alone does not isolate every volume bucket.

## AWS policy scope and shared grants

The [bootstrap policy documents](../bootstrap/aws/README.md) are the source of truth. They scope
stage state, secrets and runtime IAM resources, while some permissions remain shared:

| Shared permission | Practical boundary |
| --- | --- |
| `sst-asset-*` bucket writes | Assets from multiple stages share a bucket |
| `boxlite-volume-*` bucket access | Prefix does not contain a stage |
| SSM `SendCommand` on `instance/*` | Can reach instances across stages in the account |
| SES `identity/*` management | Sender domains are not stage-named resources |
| List operations and shared bootstrap reads | May reveal names/metadata without granting secret-value access |

A runtime permissions boundary caps a role's grants; it does not grant access by itself.
The retained legacy wrapper additionally hydrates its `BOXLITE_STAGE_CONFIG` manifest and removes
Pulumi event logs. Those legacy controls should not be attributed to every mdeploy invocation.

## Resource and rollout protection

mdeploy requires confirmation for protected apply/refresh and refuses protected-stage removal.
Runner resources independently prevent replacement/deletion and ignore boot-image/startup changes.
Updates use OS Config on GCP and SSM on AWS; [runner operations](runners.md) explains convergence.
Database protection, backups and availability are explicit stage settings, not implied by the name `prod`.
The legacy deployment has an additional runner policy pack and scope restrictions.

Sources: [GCP bootstrap roles](../bootstrap/gcp.ts), [AWS policies](../bootstrap/aws/),
[mdeploy guards](../mdeploy/src/run.ts), [AWS runtime boundary](../mdeploy/sst.config.ts),
[GCP runtime identities](../mdeploy/stack/providers/gcp/network.ts), [legacy wrapper](../deployment/sst.ts).
