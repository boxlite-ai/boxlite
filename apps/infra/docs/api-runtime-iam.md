# API runtime IAM capabilities

## TL;DR

Deployment grants feature-specific API runtime permissions through explicit API capabilities. For
a GCP stage, mdeploy derives Filestore instance reads from `FILESTORE_INSTANCES` and binds the API
runtime identity to `roles/file.viewer` in each configured project. Routine deployment in the
stage's own project requires no manual API authorization. Baseline provider resources such as
secret access, Cloud Run invokers, and the credential-vending ceiling are declared separately and
are not claimed to be capabilities.

## Capability contract

mdeploy composes an `ApiCapability[]` before it creates the API workload. The list is a closed
union, not free-form role strings. This keeps "the API can do X" type-checked and forces every
new permission to have a provider implementation.

| Stage | Owner | Decision |
| --- | --- | --- |
| Parse a feature's configuration | `apiEnvironmentFrom` | Turn active configuration into deployment inputs. |
| Select capabilities | `capabilitiesFor` | Add a capability only when its resource or feature is active. |
| Grant permissions | Cloud API provider | Map each supported capability to the runtime identity's IAM. |

The API image receives the corresponding resource references and environment values. IAM and
configuration are joined by deployment; an environment variable alone does not grant permission.
The identity is stable across container replacements, so a Pod or container address is irrelevant
to cloud authorization.

## Filestore instance reads

`FILESTORE_INSTANCES` names the logical instances the API may select or resolve. On GCP,
mdeploy:

1. Parses `FILESTORE_INSTANCES` in `apiEnvironmentFrom`. Unset uses the environment's default,
   explicit whitespace disables Filestore, and each nonempty entry must carry `project_id`.
2. Deduplicates and sorts the configured `project_id` values.
3. Adds `read-filestore-instances` as the final capability only when that project list is nonempty.
4. Creates one project IAM binding per configured project for the API runtime identity. The role is
   `roles/file.viewer`, which contains `file.instances.get`.
5. Bootstrap enables `file.googleapis.com` in the stage project. An external Filestore project also
   needs a one-time onboarding step: enable Service Usage and Filestore, and let the deployer manage
   the API identity's IAM binding there.

`roles/file.viewer` is the control-plane read that lets the API resolve server and export metadata.
It is separate from runner access to the NFS server: granting the API role does not authorize a
mount, and granting runner network access does not authorize instance lookup. An AWS deployment
rejects `read-filestore-instances` and omits `FILESTORE_INSTANCES`, even if stage configuration
supplies instances. Deployment also exports `FILESTORE_SUPPORTED=false` on AWS and `true` on GCP;
the API hides the Filestore capability and answers a create request with HTTP 501 and the
structured code `unsupported` only on unsupported deployments. Local APIs default to supported so an explicitly configured
instance list remains usable.

For a configured instance in a project other than the stage project, the deployer identity needs
permission to set IAM policy in that project. That is deployment bootstrapping, not a recurring
API runtime grant. After the stack owns the binding, mdeploy recreates it if it is removed.

## Diagnose a Filestore lookup permission failure

Check the pipeline in this order:

1. `FILESTORE_INSTANCES` resolves to the intended nonempty project list on GCP.
2. The API deployment request contains `read-filestore-instances` with those projects.
3. The GCP provider resources include a `roles/file.viewer` binding for the API runtime identity in
   each project.
4. `file.googleapis.com` is enabled and IAM policy has propagated.

An API container's ephemeral address is not part of this check. A generic "Could not look up
Filestore instance" response wraps a non-not-found control-plane failure; inspect the API log's
`filestore_lookup_failed` event for the GCP code and message.

Manual grants are emergency recovery actions. If a binding was already created manually before the
stack managed it, import it into stack state or remove it before applying; otherwise the provider
may try to create a duplicate binding.

## Disk-resize example

Runner data disk resizing works this way on GCP:

1. The GCP provider declares that the cloud supports runner data disks, so
   `providers.resizeRunnerDisks()` is true. AWS returns false and receives no capability.
2. `capabilitiesFor` appends `resize-runner-disks` only when that answer is true.
3. The GCP provider creates two custom roles: one to resize disks, and one to read the operations
   that confirm a resize. There is no predefined role this narrow.
4. The roles are bound at project level with CEL conditions that name the stage's zone and runner
   data-disk prefix. The API can resize this stage's disks, not arbitrary Compute Engine disks.

Prefer a resource-scoped binding. When the provider cannot address the exact resource, use a
project-level binding with a condition only when the service supports the intended condition. Do
not attach a condition merely for symmetry. Filestore is an explicit exception: discovery uses the
predefined, read-only `roles/file.viewer` at project level without a condition. That role covers
instance reads without a custom role lifecycle and grants no writes.

## Add a capability

When a new API runtime permission is needed, extend the deployment model instead of granting a
role manually as the primary mechanism:

1. Add a value to the `ApiCapability` closed union.
2. Add the capability to `capabilitiesFor` only when its resource or feature is active.
3. Implement its IAM mapping in every provider that supports the feature, and reject or omit it on
   providers that do not.
4. Add focused tests proving that an inactive feature gets no grant, an active feature gets the
   intended grant, and inserting the capability does not rename existing grants.

On GCP, provider resources such as `ApiCapability0` and `ApiCapability1` are keyed by list index.
Appending a new capability at the end preserves existing resource names and bindings. Inserting one
earlier can delete and recreate bindings during deployment, so treat capability order as a
compatibility contract.

Sources: [capability union](../mdeploy/stack/api.ts),
[capability selection](../mdeploy/stack/index.ts), [GCP bindings](../mdeploy/stack/providers/gcp/api.ts),
[AWS policies](../mdeploy/stack/providers/aws/api.ts), [Filestore configuration](../mdeploy/src/api-environment.ts).
