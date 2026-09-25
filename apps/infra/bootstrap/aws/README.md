## TL;DR

AWS bootstrap reconciles the legacy deployment's prerequisite policies, registry and artifact bucket; inspect naming before using mdeploy.

# AWS bootstrap reference

[Infrastructure index](../../README.md) · [Deployment](../../docs/aws/deployment.md) · [Security](../../docs/aws/security.md)

Run `npm run bootstrap -- --stage <stage>` from `apps/infra` with an authorized AWS identity,
authenticated `gh`, and reviewed `.env` input. The operator needs IAM write privileges beyond the
deploy role this command creates. AWS bootstrap reads the legacy environment's region; align it
with the intended stage declaration and verify the printed account/region/repository.

## Ownership

| Resource | Implementation / purpose |
| --- | --- |
| `boxlite-<stage>-github-deploy` | Stage-bound GitHub OIDC deployment role |
| `boxlite-<stage>-runtime-boundary` | Maximum permissions for legacy SST-created workload roles |
| API ECR repository | Immutable tags and scan-on-push, named by `artifacts/api.ts` |
| Runner artifact bucket | Private, versioned commit artifacts, named by `artifacts/runner.ts` |
| GitHub Environment and stage values | Orchestrated by `bootstrap/bootstrap.ts` |

[`../aws.ts`](../aws.ts) renders the checked-in JSON through the AWS CLI; these resources are not
created by a CloudFormation stack or by the application deploy. Re-running reconciles policies.
Repository identity defaults to `gh repo view`; `--repo owner/name` selects it explicitly.

## AWS mdeploy compatibility

The checked-in bootstrap uses the legacy app name `boxlite`. The current
[`mdeploy/sst.config.ts`](../../mdeploy/sst.config.ts) uses `boxlite-app`, including its state identity
and runtime-boundary name. The [stage example](../../.mstage.config.example.json) also declares
mbuild repositories separately from the legacy API repository.

Consequently, bootstrap completion alone does not prepare a fresh AWS mdeploy stage, and mdeploy
must not be described as automatically adopting the legacy state. Verify the app/state key, runtime
boundary, registry, artifact bucket and role grants before previewing a migration. The existing
[legacy AWS path](../../docs/aws/deployment.md#retained-legacy-aws-deployment) remains documented.

## Policy documents

| File | Contract |
| --- | --- |
| [`deploy-role-trust.json`](deploy-role-trust.json) | GitHub OIDC subject pinned to repository and stage Environment |
| [`runtime-boundary-policy.json`](runtime-boundary-policy.json) | Runtime data-plane ceiling; no IAM mutation |
| [`deploy-role-policy.json`](deploy-role-policy.json) | Deployment permissions and bounded runtime-role creation |

Trust uses `repo:<owner>/<repo>:environment:<stage>`, not a branch-form subject. Jobs assuming the
role must bind that Environment. The role uses short-lived federation; review required reviewers
and branch protection separately in GitHub.

`CreateBoundedBoxLiteRoles` and `SetBoxLiteRoleBoundary` require the stage boundary.
`DenySelfPrivilegeEscalation` protects deploy roles and boundary policies across stages.
A boundary update creates a managed-policy version; bootstrap prunes the oldest non-default version
when needed to stay within IAM's version limit.

Stage state/secrets grants coexist with shared asset buckets, volume-prefix access, account-wide
SSM instance targets and SES identity management. [Security](../../docs/aws/security.md#policy-scope-and-shared-grants)
records those limits. `cloudfront-keyvaluestore:*` is separate from `cloudfront:*`; the latter's
wildcard does not cover another service prefix.

## Artifact retention and changes

Bootstrap creates missing ECR/artifact stores but does not delete or replace them. Its bucket
lifecycle expires superseded object versions, not the current commit-keyed object a later runner
boot may need. Application teardown does not imply these stores were removed.

Edit and review policy documents, run `make test:apps:infra` from the repository root, then reconcile
with bootstrap under the intended operator identity. A local policy edit is not a live IAM update;
read back the resulting policy and run a deployment preview before applying application changes.
