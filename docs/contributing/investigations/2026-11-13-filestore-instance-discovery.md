**Status:** Accepted

# GCP FileStore instance discovery

## API contract

`storageBackend` is the only field that selects the volume type. `instance` is only an
optional placement hint for Filestore; it never implies a backend.

| Request | Meaning |
| --- | --- |
| `{}` | Create an object-storage volume. |
| `{ "storageBackend": "object_storage" }` | Create an object-storage volume. |
| `{ "storageBackend": "filestore" }` | Create a Filestore volume and assign an instance by hashing the configured names. |
| `{ "storageBackend": "filestore", "instance": "boxlite-dev-shared" }` | Create a Filestore volume on that named instance. |
| `{ "instance": "boxlite-dev-shared" }` | Invalid: a Filestore placement cannot select the backend. |

The accepted values are `object_storage` and `filestore`; `object_storage` is the
default. If `storageBackend` is `object_storage`, `instance` must be absent. If it is
`filestore`, `instance` is optional and must name a real GCP Filestore instance in the
deployment's configured project and location.

## Goal

The API needs only the set of usable Filestore instance names from the environment.
It then discovers the current IP address and NFS export from GCP instead of receiving
those connection details through configuration.

This removes the requirement to duplicate deployment connection data into API
configuration and lets Filestore tests ask for automatic assignment without knowing
which instances a stage has provisioned. The explicit backend also keeps the public
meaning of every request independent of optional-field presence.

## Non-goals

- The API does not create, resize, or delete Filestore instances. Operators provision
  them.
- The API does not create or delete the volume's NFS directory. The runner continues to
  create it under the volume ID at first mount.
- This is not capacity-aware or latency-aware load balancing. It is a deterministic
  early-stage distribution.
- Existing volumes are not moved when the configured instance set changes.

## Decision rationale

The deliberate boundary is **simple enough for the current need**, not "the cheapest
version of a future balancer".

- The current requirement is to spread new Filestore volumes across a small,
  operator-provisioned set and to let tests or operators pin an instance when necessary.
  There is no current workload showing uneven distribution, exhausted shares, or a need
  to compare instances with different capacities.
- Capacity-aware placement would need a definition of which signal governs the decision:
  provisioned size, observed used bytes, inode pressure, throughput, or runner-to-instance
  proximity. It would also need normalizing instances with different tiers and capacities.
  None of those signals, policies, or thresholds is part of the current product need.
- A health-aware or least-loaded selector would be hard to test honestly at this stage.
  It would introduce simulated telemetry that may not match GCP behavior, or extra
  infrastructure whose benefit cannot be measured while there is no observed imbalance.
- A deterministic hash is chosen because it needs no shared state, no coordination between
  API replicas, no background refresh, and no new request-time dependency beyond the
  configured name list. It is easy to test and easy to explain. Its known limitation is
  accepted: it balances new creates, not live demand.
- Existing volumes keep their assigned instance because moving data is a materially larger
  system: it needs copy/cutover semantics, quiescing writers, rollback, and observable
  progress. Inventing that now would not solve a current request.

Revisit this only when there is concrete evidence or a new product requirement: measured
hot spots, instances with materially different capacity or tier, saturation alerts, usage
telemetry that supports a placement policy, or a need to move volumes without operator-run
data copies.
## Runtime flow

`apps/api/src/config/filestore-instances.ts` parses `FILESTORE_INSTANCES` as instance objects.
`VolumeService.enqueueCreation` selects an explicit name or hashes the sorted list, then
uses `FilestoreInstanceResolver` to verify the name and discover its current GCP mount
target. `BoxService.create` calls the same resolver before dispatching a box mount.

The runner receives the resolved `FilestoreRef` and mounts `server:export` with the
pinned NFSv4.1 and hard options.

## Configuration

The design changes the variable in place instead of adding another compatibility form:

```bash
FILESTORE_INSTANCES='[{"instance":"boxlite-dev-shared","project_id":"boxlite-dev-project","zone":"us-east5-a"}]'
```

`FILESTORE_INSTANCES` is a JSON list. Each entry carries `instance`, `project_id`, and
`zone`, so instances can live in different projects or zones without changing the API
contract again. The instance name satisfies the existing runner path-safety pattern:

```text
^[a-z0-9][a-z0-9-]{0,62}$
```

Instances are sorted by name before hashing so every API replica makes the same choice.
Each instance carries its own GCP placement, so hash assignment currently balances
instances without considering capacity, region locality, or current utilization.

The API validates each instance, project ID, and zone at startup, but does not call GCP at
startup. An explicit empty `FILESTORE_INSTANCES` remains valid; it only means the deployment
cannot accept a Filestore create. Until the temporary stage rollout is removed, an unset
variable defaults to `boxlite-dev-shared` in `boxlite-dev-project`, zone `us-east5-a`.

The old comma-separated list plus deployment-wide project/location variables is removed.
Keeping both shapes would make the variable's meaning depend on its first byte, create two
deployment paths, and preserve a form this branch has not shipped. If a deployed stage
already uses the old form, its environment is updated in the same rollout as the API image.

## Instance selection

For `storageBackend: "filestore"`:

1. If the request explicitly supplies `instance`, validate it against the configured
   names and use it.
2. Otherwise parse the configured names, sort them, and hash the request-independent
   value to select one.
3. Store only the selected name in `Volume.instance`.

The initial implementation uses the first 32 bits of the volume ID's SHA-256 digest and
selects `digest % instanceCount`. This uses an ID created for the request, spreads new
creates evenly enough for current use, and is stable across API replicas. It deliberately
does not consider current capacity, available share space, region proximity, or instance
health; the reasons and later triggers are in **Decision rationale**.

If the configured list is empty and no explicit name is supplied, the request fails
before a Volume row is written. If the selected or explicit instance cannot be found in
GCP, the create also fails before a Volume row is written. The response distinguishes:

| Failure | Public status |
| --- | --- |
| No Filestore instance is configured | 503 |
| Explicit instance does not exist | 400 |
| Hash-selected configured instance does not exist | 503 |
| Filestore API authentication or access fails | 503 |
| Filestore API is unavailable | 503 |

An existing Volume keeps its instance name forever in this design. Changing the
environment affects only creates made after that change; it never rebalances existing
data.

## GCP discovery

The API calls the Google Cloud Filestore API directly. It does not shell out to the
`gcloud` CLI. The implementation uses Application Default Credentials, matching the API's
existing Google Cloud access model, and the deployment's service account needs the
Filestore read permission.

For each selected name, the API reads:

```text
projects/{project_id}/locations/{zone}/instances/{instance}
```

The resolver accepts the returned instance only when it can derive exactly one usable
mount target:

- `networks[].ipAddresses` contains exactly one IPv4 address.
- `fileShares[]` contains exactly one share. The export becomes `/${share.name}`.

A zero-share instance fails. An instance with multiple shares or usable addresses also
fails for now. That avoids guessing which share a caller meant. If multi-share instances
become a real requirement, the follow-up should either extend the request with a share
selector or allow the logical instance name to include a share suffix; this design does
not invent that syntax yet.

The mount options stay pinned in the runner: NFSv4.1 and hard. The new name-only
configuration cannot express arbitrary options. If another option is later required, it
should be a separate reviewed contract, not hidden inside an instance-name list.

## Dispatch

`VolumeService.create` stores the assigned or explicit instance name and marks the
Filestore volume `READY` immediately, exactly as the current implementation does. No IP
or export is persisted in the public Volume row or database record.

`BoxService.create` resolves every referenced volume's instance through the new resolver
before dispatching. It then produces the same internal `filestore` reference that the
runner already consumes. A failed lookup fails the box create loudly rather than allowing
the runner to discover an invalid mount.

The resolver keeps successful responses in memory for 60 seconds, keyed by the full GCP
resource name. This removes duplicate reads while one box create resolves multiple
volumes on the same instance without introducing a shared cache service. Failed lookups
are not cached. The cache is an implementation detail; the database and runner still
store or receive only the name and resolved mount reference respectively.

## Code shape

The expected focused changes are:

- Replace `apps/api/src/config/filestore-instances.ts` with name-list parsing.
- Add a Filestore resolver around the official `@google-cloud/filestore` client.
- Extend `CreateVolumeDto` and the OpenAPI schema with optional `storageBackend`.
- Return the derived `storageBackend` and Filestore-only `instance` in `VolumeDto`.
- Expose `object_storage_enabled` and `filestore_enabled` from `/v1/config`.
- Give the Dashboard a storage-backend selector, list display, and immediate-ready copy for Filestore.
- Use the selector and resolver in `VolumeService.enqueueCreation`.
- Replace direct configuration-array lookups in `BoxService.create` with resolver calls.
- Update focused unit tests, the generated API clients, and `test_filestore.py`.

Runner code, the runner DTO, and the `Volume` database migration do not change.

## Test outline

Focused tests cover:

- Name-list parsing, duplicate rejection, and startup validation.
- Deterministic hash assignment across a sorted name list.
- Explicit instance selection, automatic selection, and empty-list errors.
- Mapping of a Filestore API response to a server address and export.
- Rejection of multiple shares, zero shares, and ambiguous addresses.
- Volume create and box dispatch error mapping, including no persisted row on failure.
- `/v1/config` advertising each volume backend only when its configuration is present.
- Dashboard defaulting, disabled options, payload shape, and list rendering.

The Filestore E2E case keeps `FILESTORE_E2E_INSTANCE` as an optional way to pin a named
instance. When omitted, it creates with `storageBackend: "filestore"` and therefore does
not need the API deployment to pre-share its instance list with the test runner.
Whether that default probe should run on a stage is still controlled by the existing E2E
gate, because an available API deployment does not by itself prove that a Filestore
instance was provisioned.

## Operational rollout

Deploy the API with the JSON instance-object configuration after provisioning the named
instances and granting its service account read access. Verify one explicit-instance
create and one automatic-selection create before opening the endpoint more broadly.

No database migration is required because `Volume.instance` already exists. Volumes
created by the current branch contain instance names that this resolver can continue to
look up, provided those names are real GCP instance IDs. If a stored name was only a
local alias and not a GCP instance ID, that row must be corrected before the new dispatch
path ships.

## Dashboard behavior

The Dashboard reads `/v1/config` and keeps backend availability as an operator-visible
capability, not an inferred convention. It offers **ObjectStorage** and **FileStore**,
defaults to object storage, and never asks the user for an instance, NFS server, export,
or mount option.

When Filestore is not configured, its option stays visible but disabled with a concise
configuration note. When object storage is unavailable and Filestore is available, the
Dashboard starts on Filestore. When neither backend is configured, creation is disabled.
Submitting FileStore sends only `{ "name": "...", "storageBackend": "filestore" }`; the
server assigns and resolves the instance. The success copy says the volume was created,
because FileStore volumes are `READY` immediately. The list shows only the backend name,
not the assigned instance; operators can inspect that fact through the API if needed.
