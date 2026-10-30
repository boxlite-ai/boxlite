## TL;DR

Keep existing GCP runner machine types and accept an optional capacity for newly created data disks.

# GCP runner creation sizing

## Scope

Port the runner sizing contract from `x_features` to main: optional `deploy.runners.dataDiskGb`,
GCP machine-type preservation, and rejection of the GCP-only disk field on AWS. Preserve logical
resource names, disk protections, boot scripts and rollout behavior. AWS instance sizing, per-host
configuration, snapshots and live infrastructure changes are outside this design.

## Research and alternatives

| Evidence | Consequence |
| --- | --- |
| [The base parser](https://github.com/boxlite-ai/boxlite/blob/24cef4607416b4b75e4663f966f8315a5e4773bd/apps/infra/mdeploy/src/config.ts#L244) accepts only `size` and `rootDiskGb`. | Add an optional field without relaxing required-field or unknown-key checks. |
| [The composition root](https://github.com/boxlite-ai/boxlite/blob/24cef4607416b4b75e4663f966f8315a5e4773bd/apps/infra/mdeploy/stack/index.ts#L557) already forwards `config.runners` to the provider. | No new environment variable or adapter is needed. |
| [The base GCP provider](https://github.com/boxlite-ai/boxlite/blob/24cef4607416b4b75e4663f966f8315a5e4773bd/apps/infra/mdeploy/stack/providers/gcp/runners.ts#L440) protects disks and ignores disk sizing changes, but does not ignore `machineType`. | Extend the existing resource lifecycle policy to machine sizing. |
| [The prior implementation](https://github.com/boxlite-ai/boxlite/blob/6e43e7f4f/apps/infra/mdeploy/src/config.ts#L244) supplies the optional field and corresponding provider behavior. | Reuse the isolated sizing changes; its unrelated quota and snapshot changes are unnecessary. |
| [Pulumi's `ignoreChanges` contract](https://www.pulumi.com/docs/iac/concepts/resources/options/ignorechanges/#how-ignorechanges-works) uses program inputs at creation and recorded state afterward. | New hosts can use current defaults while existing hosts retain their specifications. Refresh state after out-of-band resizing. |
| [The GCP provider contract](https://www.pulumi.com/registry/packages/gcp/api-docs/compute/instance/#inputs) requires permission to stop a running instance before changing its machine type. | Retaining existing types avoids introducing a disruptive update path. |

The [failed deployment](https://github.com/boxlite-ai/boxlite/actions/runs/41046473086/job/124038292791)
attempted `machineType` updates for `Runner` and `Runner-runner-2` before both updates were refused.
Changing a single stage size cannot represent a mixed existing fleet. Allowing stop-for-update
would change running hosts; a per-host sizing schema would add configuration ownership that the
creation-default contract does not need. Leaving the code unchanged retains both incompatibilities.

## How it works

Add optional `dataDiskGb` to the shared runner request and parsed settings. Validate it against the
existing 20–4000 GiB integer range while keeping `size` and `rootDiskGb` required. The composition
root forwards the parsed value through its existing spread.

GCP selects `request.dataDiskGb ?? DATA_DISK[request.size].sizeGb` and adds `machineType` to the
instance's existing `ignoreChanges`. Capacity defaults to 200 GiB; IOPS and throughput still use
the machine-size presets. Existing disk protections and ignored properties remain in place.
AWS rejects `dataDiskGb` before declaring resources and continues using `rootDiskGb` for box state.

For example, `size=large` with `dataDiskGb=2048` creates a new GCP host with a 2 TiB data disk.
Existing smaller hosts retain their recorded machine types and disk capacities. These settings
do not resize existing hosts or disks.

## Validation

| Check | Observed result |
| --- | --- |
| Regression tests with every production file unchanged from the base | Five failures: unknown disk field in parsing and forwarding, missing machine-type ignore, 200 instead of 2048 GiB, and no AWS refusal. |
| Complete implementation with `make test:apps:infra` | 1,632 passing tests and one existing ClickHouse integration skip. |
| `npm run --silent typecheck:mdeploy` | Passed. No Make target covers this package-specific typecheck. |
| `make test:apps:infra-config` with proxy variables cleared for the command | Provider installation and full configuration typecheck passed. |

Tests exercise the production parser, composition root and provider declarations, including bounds,
required fields, defaults, resource protections and rejection before AWS resource creation.
Recording constructors do not simulate Pulumi state reconciliation. A live preview/apply and cloud
rollout remain untested.
