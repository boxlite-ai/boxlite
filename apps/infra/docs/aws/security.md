## TL;DR

AWS runtime roles are bounded, but several bootstrap grants intentionally reach resources shared across stages.

## Details

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Identity boundaries

| Identity | Role |
| --- | --- |
| Bootstrap operator | Reconciles IAM policies, trust and prerequisite stores |
| CI deployer | GitHub OIDC → stage deploy role |
| Image publisher | Stage registry access through the workflow's AWS role |
| Runtime | Task/instance roles capped by the runtime permissions boundary |

The encrypted stage map lives in S3, with its passphrase in SSM; native Pulumi checkpoints use separate keys in that bucket.
Follow the shared [secret-handling and resource-protection rules](../security.md).
Inspect live GitHub Environment reviewers and OIDC trust separately from workflow declarations.
Existing SST stages require the [ownership and IAM fence](migration.md).

## Policy scope and shared grants

The [bootstrap policy documents](../../bootstrap/aws/README.md) are the source of truth. They scope
stage state, secrets and runtime IAM resources, while some permissions remain shared:

| Shared permission | Practical boundary |
| --- | --- |
| Declared volume prefix, default `boxlite-volume-*` | Default prefix does not contain a stage |
| SSM `SendCommand` on `instance/*` | Can reach instances across stages in the account |
| SES `identity/*` management | Sender domains are not stage-named resources |
| List operations and shared bootstrap reads | May reveal names/metadata without granting secret-value access |

A runtime permissions boundary caps a role's grants; it does not grant access by itself.
The retained legacy role also grants shared `sst-asset-*` bucket writes.
Its wrapper additionally hydrates its `BOXLITE_STAGE_CONFIG` manifest and removes
Pulumi event logs.

Those legacy controls should not be attributed to every mdeploy invocation.
Runner updates use [SSM](runners.md). The legacy deployment also has a runner policy pack and scope restrictions.

Registry task identities can read pinned credential versions but cannot write credentials.
The API can create/write/revoke those credentials without reading their values or changing resource policies.

Checkpoint grants target the dedicated bucket and checkpoint prefix.
EBS modifications require matching app, stage and Runner-data tags; application checks also bind each volume to its trusted Runner name.

Sources: [bootstrap policies](../../bootstrap/aws/), [runtime defaults](../../mdeploy/pulumi/aws-defaults.ts), [legacy wrapper](../../deployment/sst.ts).

The retained Runner-unreachable alarm contract expects an API `runner.unreachable` event.
No producer was found in the current API source; verify and implement that shared signal separately before relying on this alarm.
Disk expansion and pressure filters consume the existing structured events.
