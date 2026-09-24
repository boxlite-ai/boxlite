## TL;DR

AWS runtime roles are bounded, but several bootstrap grants intentionally reach resources shared across stages.

# AWS security

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Identity boundaries

| Identity | Role |
| --- | --- |
| Bootstrap operator | Reconciles IAM policies, trust and prerequisite stores |
| CI deployer | GitHub OIDC → stage deploy role |
| Image publisher | Stage registry access through the workflow's AWS role |
| Runtime | Task/instance roles capped by the runtime permissions boundary |

The encrypted stage map lives in S3, with its passphrase in SSM; SST state has separate keys.
Follow the shared [secret-handling and resource-protection rules](../security.md).
Inspect live GitHub Environment reviewers and OIDC trust separately from workflow declarations.
Review [bootstrap compatibility](../../bootstrap/aws/README.md#aws-mdeploy-compatibility)
before relying on a boundary created for another app name.

## Policy scope and shared grants

The [bootstrap policy documents](../../bootstrap/aws/README.md) are the source of truth. They scope
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


Runner updates use [SSM](runners.md). The legacy deployment also has a runner policy pack and scope restrictions.

Sources: [bootstrap policies](../../bootstrap/aws/), [runtime boundary](../../mdeploy/sst.config.ts), [legacy wrapper](../../deployment/sst.ts).
