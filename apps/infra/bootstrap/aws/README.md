## TL;DR

AWS bootstrap prepares native Pulumi prerequisites using the declared app, registry, region and stage.

## Details

[Infrastructure index](../../README.md) · [Deployment](../../docs/aws/deployment.md) · [Security](../../docs/aws/security.md)

Run `npm run bootstrap -- --stage <stage>` from `apps/infra` with an authorized administrator and authenticated `gh`.
Protected stages require `--confirm`; local edits alone do not update cloud IAM or deploy workloads.

### Ownership

| Resource | Contract |
| --- | --- |
| `<app>-<stage>-pulumi-deploy` | Distinct, stage-bound GitHub OIDC role |
| `<app>-<stage>-runtime-boundary` | Ceiling for workload IAM permissions |
| Declared ECR repository | One immutable, scanned repository holding the stage's tagged artifacts |
| `<app>-<stage>-artifacts-<account>` | Private, versioned Runner build artifacts |
| Regional state bucket | Existing `/sst/bootstrap` bucket or a native bucket when absent |
| Encryption keys | Existing SSM environment key and native Pulumi passphrase are preserved |

The bootstrap writes `AWS_PULUMI_DEPLOY_ROLE_ARN`, `AWS_ACCOUNT_ID` and `AWS_REGION` to the stage's GitHub Environment.
Native mbuild and mdeploy workflows use that distinct role.

It initializes the encrypted environment envelope without installing SST.
Configure declared mstage groups and AWS secret ARNs before previewing the application.

### AWS mdeploy compatibility

Existing SST stages need the [adoption runbook](../../docs/aws/migration.md).
Bootstrap does not import resources, fence historical workflows, migrate Runner files or transfer ownership.

`--legacy-sst` explicitly selects the retained bootstrap and its `boxlite` app conventions.
Its Auth0/SES provisioning switches remain specific to that path.

### Policy documents

| File | Contract |
| --- | --- |
| [deploy-role-trust.json](deploy-role-trust.json) | GitHub repository and stage Environment trust |
| [native-deploy-role-policy.json](native-deploy-role-policy.json) | Native state, ownership, deployment and bounded IAM permissions |
| [native-runtime-boundary-policy.json](native-runtime-boundary-policy.json) | Checkpoints, registry credentials, tagged EBS growth and existing runtime channels |
| [deploy-role-policy.json](deploy-role-policy.json) | Retained SST role permissions and shared ownership lease |
| [runtime-boundary-policy.json](runtime-boundary-policy.json) | Retained SST runtime ceiling |

The native role cannot change its own permissions, runtime boundary policies or historical deployment-role fences.
Runtime boundaries cap grants; separate task and instance policies supply each workload's actual permissions.

Reconciliation creates policy versions and prunes old non-default versions at IAM's version limit.
Artifact lifecycle expires superseded object versions, preserving current commit artifacts for later boots.

Review the live trust policy and GitHub Environment protections separately.
Run `make test:apps:infra` before an approved bootstrap reconciliation, then read back IAM and preview application changes.
