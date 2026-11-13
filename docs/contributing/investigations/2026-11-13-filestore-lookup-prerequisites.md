**Status:** Implemented

## TL;DR

Reconcile Filestore discovery prerequisites during deployment, grant the API
`roles/file.viewer` in every configured GCP project, enable the Filestore API in
the stage project, and retain sanitized GCP failure details in API logs without
changing the client error contract.

The resolver diagnostics, effective-configuration, IAM, and service-enablement
slices are implemented. The default `FILESTORE_INSTANCES` entry remains
`boxlite-dev-shared` in `boxlite-dev-project`, zone `us-east5-a`.

## Context and evidence

A Filestore volume create currently fails with:

```text
Could not look up Filestore instance 'projects/boxlite-dev-project/locations/us-east5-a/instances/boxlite-dev-shared'
```

`FilestoreInstanceResolver.lookup` emits this message only when `getInstance`
rejects with something other than the recognized `NOT_FOUND` shape. The call
happens before the Volume row is saved and before runner dispatch, so this is
control-plane discovery, not an NFS mount failure.

The current implementation contains a separate correction that accepts both
numeric and string forms of the READY state. That correction addresses an
`is not ready` response after a successful lookup; it does not address this
lookup exception.

Repository evidence exposes three gaps:

| Gap                              | Current evidence                                                                                                                                                   | Consequence                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| No automatic Filestore IAM grant | The discovery design requires Filestore read access, but neither the GCP API provider nor deployment history declares `roles/file.viewer` or `file.instances.get`. | A stage can advertise Filestore while its API identity receives `PERMISSION_DENIED`.           |
| No Filestore API declaration     | `apps/infra/bootstrap/gcp.ts` enables the other required Google services but omits `file.googleapis.com`.                                                          | A fresh stage can fail at request time with API-disabled or service-unavailable errors.        |
| Lost cause                       | `FilestoreInstanceResolver` catches the GCP error and constructs a new exception without logging it or attaching it as `cause`.                                    | Permission, authentication, API-disabled, and transport failures have the same public symptom. |

This record does not assert which gap caused the observed incident. The live GCP
state was not available during investigation; the design removes all three gaps
and makes any remaining failure identifiable.

## Sources and constraints

- [Filestore IAM roles and permissions](https://cloud.google.com/filestore/docs/iam)
  assigns `file.instances.get` to `roles/file.viewer`. The role is read-only; it
  also permits instance, operation, backup, and snapshot reads, but no writes.
- [Filestore `projects.locations.instances.get`](https://cloud.google.com/filestore/docs/reference/rest/v1/projects.locations.instances/get)
  confirms that discovery calls `file.googleapis.com` and uses the
  cloud-platform OAuth scope.
- [Service Usage](https://cloud.google.com/service-usage/docs/enable-disable)
  makes service enablement a project-level prerequisite and requires
  administrative permission to change it.
- [NestJS exception filters](https://docs.nestjs.com/exception-filters)
  documents that `cause` is not serialized to the client and that built-in
  exceptions are not logged by the default filter. The implementation therefore
  needs both `cause` and an explicit log.
- The existing `ApiCapability` union and per-cloud expansion keep policy out of
  the shared stack. Capability grants are appended, never inserted, because
  their indexes form Pulumi resource names.
- `FILESTORE_INSTANCES` already distinguishes unset, explicit empty, and
  configured entries. Unset currently selects the development default; explicit
  empty disables Filestore. Entries may name different projects.

The implementation must not create, modify, or delete Filestore instances,
change NFS permissions, widen runner IAM, expose credentials or request contexts
to dashboard users, or add a second application-level retry loop.

## Design

### Derive one effective discovery configuration

`apiEnvironmentFrom` already reads `FILESTORE_INSTANCES` while assembling the
API environment. Extend that deployment seam to return both the environment
value and a sorted, deduplicated `filestoreProjects` list.

- On GCP, an unset variable materializes the same default JSON that the API
  currently applies internally. The container and IAM derivation therefore see
  identical effective configuration.
- An explicit empty value produces no projects and no grant.
- A non-empty value is parsed and validated before cloud resources are built.
  Invalid JSON, entries, project IDs, or zones fail deployment with the
  configuration error rather than a later request failure.
- `StackEnvironment` and `StackInputs` carry `filestoreProjects` through both
  the SST and Pulumi composition paths.
- AWS preserves its existing environment behavior but derives no Filestore
  projects or capability. An unset AWS configuration does not acquire the GCP
  default.

The deployment parser should be a small shared deployment function beside
`apiEnvironmentFrom`, not an import from `apps/api/src/config`: infrastructure
must not depend on the API application's Nest configuration module. Contract
tests use the same unset, empty, malformed, and multi-project fixtures on both
sides so the two parsers cannot silently diverge.

### Reconcile read-only IAM through `ApiCapability`

Append one closed-union member:

```text
{ kind: 'read-filestore-instances', projects: string[] }
```

The shared composition root adds it last when the effective project list is
non-empty and the provider supports GCP Filestore discovery. The AWS provider
rejects the capability if composition ever hands it one.

The GCP provider expands the capability into one `gcp.projects.IAMMember` per
project:

```text
project: <configured project>
role: roles/file.viewer
member: serviceAccount:<API runtime service account>
```

Use a deterministic logical name derived from the capability index and project
ID. Existing `granted` handling already includes these resources in `Api.ready`.
The predefined viewer role is preferred over per-project custom roles: it has no
write permissions and avoids additional role lifecycle and deployment resources.

For the stage's own project, the existing deployer permissions are sufficient.
For another project, automatic reconciliation requires that project's
administrator to grant the deployment identity IAM policy-write access first.
Deployment must fail loudly if that prerequisite is absent; it must not attempt
privilege escalation or silently skip the binding. Removing a project from the
effective configuration removes its managed binding on a later apply while
leaving unrelated IAM members intact.

### Enable the API before the runtime depends on it

Add `file.googleapis.com` to `SERVICES` in `apps/infra/bootstrap/gcp.ts`. The
existing bootstrap reconciliation then enables it on a fresh stage project and
does no work when it is already enabled.

An external Filestore project needs a one-time onboarding step before
deployment: enable Service Usage and Filestore, and allow the deployment
identity to manage the API service account's IAM binding. This is an explicit
cross-project trust decision, not something the stage bootstrap should infer.
The normal same-project path, including `boxlite-dev-project`, remains fully
automatic.

The API revision does not need a startup discovery probe. Readiness must not
depend on an operator-provisioned instance being present; configuration
disablement and instance lifecycle remain request-time concerns.

### Preserve diagnostic detail without exposing it

In `FilestoreInstanceResolver`:

- Keep the existing public statuses, including `400` for an explicitly requested
  missing instance and `503` for configured lookup, authentication, permission,
  and transport failures. The public message includes the configured `instanceName`,
  full GCP resource path, GCP status name, and original error message so the dashboard
  can show the actual cause.
- Attach the caught error as `cause` to each new lookup exception.
- On non-`NOT_FOUND` lookup failures, emit one structured error log with event
  name `filestore_lookup_failed`, configured `instanceName`, `resourceName`, lookup
  source, and the GCP error's `code` and `message`.
- Log only these explicit fields rather than serializing request options,
  credentials, headers, or the whole GCP client context.
- Preserve failed-lookup retry behavior: failures are not cached, and the Google
  client retains its own transient retry policy. No additional resolver retry or
  circuit breaker is introduced.

The log lets an operator distinguish at least `PERMISSION_DENIED`,
`UNAUTHENTICATED`, API-disabled responses, `UNAVAILABLE`, and
`DEADLINE_EXCEEDED` without reproducing the dashboard request. `BadRequestError`
accepts an optional Nest exception-options object so the explicit-instance
`NOT_FOUND` branch retains the same cause without changing its public response.

## Alternatives considered

| Alternative                                 | Decision                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grant Filestore read manually in each stage | Reject as the primary mechanism: the runtime and deployment would continue to drift. Keep a manual grant only as an emergency recovery action.           |
| Grant `roles/file.editor` or project Viewer | Reject: both are broader than discovery requires. `roles/file.viewer` is the predefined read-only Filestore role.                                        |
| Grant only in the stage project             | Reject: configured entries can name other projects. Derive grants from the effective project list.                                                       |
| Import the API parser into infrastructure   | Reject: it couples deployment to the API application's internal configuration module. Use deployment-local parsing with shared contract fixtures.        |
| Return the full GCP client context          | Reject: it risks credentials and request metadata. Return only the status and original message, with full detail in logs and `cause`.                  |
| Add resolver retries or a startup probe     | Reject for this change: retries already belong to the Google client, and a startup probe would make unrelated API availability depend on instance state. |

## Implementation outline

1. Extend deployment environment parsing and stack inputs with effective
   `filestoreProjects`; add unset, empty, malformed, duplicate-project,
   multi-project, and AWS rejection tests.
2. Append the API capability and implement GCP `roles/file.viewer` bindings;
   verify stable resource names, project selection, API identity, and no grant
   when Filestore is disabled.
3. Add `file.googleapis.com` to bootstrap and test both fresh and
   already-enabled reconciliation.
4. Update the Filestore discovery operational rollout and infrastructure runbook
   with same-project automation and external-project onboarding.

## Verification and rollout

Run focused tests first, then the owning suites:

```bash
make test:apps:infra
make test:apps:api TEST_FILES='filestore-instance.resolver.spec.ts'
```

Infrastructure tests must prove that enabling an existing service is a no-op,
every unique configured project receives exactly one viewer binding, the runner
identity receives none, and inserting this capability does not rename existing
grants.

API tests must cover allowed and denied lookup outcomes at the resolver
interface. Defect proof runs each new regression test with production changes
reverted: IAM/service assertions fail against the undeclared resources, and
logging/cause assertions fail against the discarded error. Restoring the
implementation must make the same tests pass without weakening their assertions.

For the resolver diagnostic slice, reverting both production files while keeping
the tests produced two failures: the generic lookup exception and the
`NOT_FOUND` exception had no `cause`. Restoring the implementation produced 9/9
passing resolver tests, and `make build:apps:api` passed. No live GCP request
was run for this slice.

For the deployment-prerequisite slice, reverting all infrastructure production
changes while retaining the tests produced seven failures: Filestore service
enablement, default and configured project derivation, viewer grants, and final
capability wiring. Restoring the implementation produced 105/105 focused tests,
23/23 bootstrap tests, and 614/614 mdeploy tests, plus a clean mdeploy typecheck.
No live GCP request was run for this slice either.

Roll out infrastructure before or with the API image, then verify against the
real stage:

1. Confirm `file.googleapis.com` is enabled in the stage project and the API
   runtime service account has `roles/file.viewer` in each configured project.
2. Create one Filestore volume with automatic instance selection and one with an
   explicit `instance`; both must pass discovery and persist the expected
   instance.
3. Run the existing Filestore E2E case with its normal deployment gate,
   including mount, data reuse, and cross-box sharing.
4. Confirm a denied test double leaves the public response unchanged while logs
   retain its GCP code and message. Do not revoke production IAM merely to
   produce a negative E2E result.
5. Confirm transient failure tests still perform a later lookup rather than
   caching the failure.

Completion requires a real successful create against the deployed API. Unit
tests alone do not prove cloud IAM, service enablement, ADC, or network
reachability.
