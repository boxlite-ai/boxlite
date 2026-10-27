## TL;DR

Raise sandbox limits and support independently sized runners with drain-safe retirement.

## Scope

Support a GCP replacement from two existing small runners to one new large runner
with a 2 TiB data disk. Large remains `n4-standard-16` (16 vCPU, 64 GiB).
The new host retains a 100 GiB boot disk; its 2048 GiB Hyperdisk mounts at
`/var/lib/boxlite` using the existing boot hook.

Acceptance:

- Adding slot 3 preserves slots 1 and 2, their disks, resource names and tokens.
- Removing slots 1 and 2 preserves slot 3, including its registration identity.
- Existing count-based configurations retain their current resource mapping.
- Administrators can request drain and inspect outstanding work.
- Migration cleanup and pending runner jobs prevent retirement and registration deletion.
- No deployment, publication or cloud deletion is part of local implementation.

The same PR also raises default sandbox quotas as described in the extension below.
Non-goals: live VM migration, in-place resizing, a background cloud-resource
deleter, or implementing resource reservation in the scheduler. Capacity and
migration staging space remain rollout prerequisites.

## Related work and lessons

Repository observations below were checked against
`b9ae581f728b1be17e0d00ef25b9be038553a83c` on 2026-10-27.

| Evidence | Mechanism and decision |
| --- | --- |
| [Current fleet generation](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/infra/mdeploy/src/stack-env.ts#L71) and [runner contract](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/infra/mdeploy/stack/runners.ts#L103) | Count generates consecutive slots with one shared size. Reducing the count cannot preserve the newest slot. Add explicit stable slots with per-host sizing. |
| [Pulumi resource identity](https://www.pulumi.com/docs/iac/concepts/resources/names/#logical-names) | Logical names identify resources across updates; renaming normally replaces resources. Preserve the existing slot-to-resource mapping instead of deriving names from array positions. |
| [GCP disk and instance resources](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/infra/mdeploy/stack/providers/gcp/runners.ts#L439) and [Pulumi ignoreChanges](https://www.pulumi.com/docs/iac/concepts/resources/options/ignorechanges/#how-ignorechanges-works) | Ignored attachments retain recorded state on updates. Keep this protection; create the new host with its data disk rather than trying to attach disks to existing hosts through this change. |
| [Hyperdisk size limits](https://docs.cloud.google.com/compute/docs/disks/modify-hyperdisks#size_limits) | Hyperdisk Balanced supports 4 GiB–64 TiB. A new 2048 GiB disk fits; existing disks continue to require the separate online growth procedure. |
| [Bootstrap token selection](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/infra/mdeploy/stack/index.ts#L350) and [default registration](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/api/src/app.service.ts#L91) | The first fleet member supplies the token, but the name comes from environment. Resolve the selected primary's name and token together so retirement does not recreate an obsolete registration. |
| [Migration commit](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/api/src/box/services/box-migration-job-receiver.service.ts#L222) and [decommission checks](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/api/src/box/services/runner.service.ts#L641) | Ownership changes before the source copy is discarded. Zero Box assignments alone does not establish completion. Reuse the existing migration state machine and include its outstanding work in retirement checks. |
| [Pulumi protection](https://www.pulumi.com/docs/iac/concepts/resources/options/protect/) | Engine protection and cloud deletion protection are independent. Keep both enabled by default; document a targeted operator retirement after drain verification. |

Alternatives considered:

- Change global size and count: rejected because it changes existing hosts and removes the wrong survivor.
- Manually create an unmanaged VM: rejected because registration, upgrades and future deployment ownership would diverge.
- Rewrite migration or automate deletion now: rejected because existing migration handles stopped boxes; explicit retirement is sufficient for this rollout.
- Automatically attach the currently unused disks: rejected because existing state must not be hidden by a new mount.

## How it works

### Fleet configuration and identity

Extend `deploy.runners` with optional `instances`, `primary`, and `dataDiskGb`.
Keep the existing `size` and `rootDiskGb` defaults for backwards compatibility.
Each instance has a stable numeric `slot`, a control-plane `name`, and optional
size/disk overrides. Validate unique slots and names, positive bounded disk sizes,
known sizes, a nonempty fleet, and a primary naming a declared instance.

Example of the proposed new configuration:

```json
{
  "size": "small",
  "rootDiskGb": 100,
  "primary": "default",
  "instances": [
    { "slot": 1, "name": "default" },
    { "slot": 2, "name": "runner-2" },
    { "slot": 3, "name": "runner-3", "size": "large", "dataDiskGb": 2048 }
  ]
}
```

Slot 1 keeps logical name `Runner` and the bare host prefix. Slot N keeps
`Runner-runner-N` and the `-N` host suffix. Tokens remain keyed by control-plane
name. Selecting another primary may change iteration order, never these identities.
The API receives the selected primary's name and token together.

Explicit instances become the fleet source of truth; legacy `RUNNERS` applies only
when instances are absent. Explicit mode requires `primary`; legacy mode retains
`DEFAULT_RUNNER_NAME`. After drain, keep only slot 3 and set primary to `runner-3`.

Both providers consume resolved per-host CPU and boot-disk sizes. GCP consumes
`dataDiskGb`, defaulting to the existing 200 GiB. AWS rejects an explicitly requested
data disk because its current storage contract uses the boot volume.

### Drain and retirement

Add administrator PATCH and GET operations for drain using the existing admin
authentication and audit conventions. Validate the PATCH boolean. The GET reports
draining state, assigned boxes, outstanding migrations and pending/running jobs;
it exposes no credentials and is an observation, not authorization to delete.

Share the outstanding-work check between progress reporting, the periodic
decommission transition, and registration deletion. Check both migration sides:
the current Box owner and `box_migration.runnerId`, which becomes the source after
ownership transfers. Pending/running jobs also block retirement. Repeat the check
inside the final runner transaction; retain the existing three clean checks.

The replacement remains an operator-controlled sequence:

1. Add and verify the new host, its actual mount, health and an end-to-end migration.
2. Drain the two old hosts; wait for stopped boxes to migrate and cleanup to finish.
3. Switch primary, remove only retired slots, handle their deletion protections,
   and apply the reviewed removal. Retain the new host's identities throughout.

Running boxes are not forcibly stopped. A user restarting a migrating box can
cause rollback. Failed or unfinished work keeps its host available for completion.
Existing reservations and admission races are not solved by a progress snapshot;
the operator rechecks workload state before the separately reviewed cloud removal.

## Validation

| Claim or risk | Planned check |
| --- | --- |
| Explicit configuration is safe and backwards compatible | Parser tests for inheritance, duplicates, invalid primary, disk bounds and unchanged legacy inputs. |
| The survivor is never renumbered | Drive production fleet resolution and stack composition before/after removing slots 1 and 2; compare host/disk names and token pairing. |
| Requested sizes reach resources | Provider tests observe large plus 2048 GiB for the new slot, unchanged old slots, and rejection of unsupported AWS data-disk requests. |
| Cleanup blocks retirement | Reproduce source ownership cleared while migration cleanup or jobs remain; require the old implementation to fail the assertion, then the full fix to pass. Cover final transactional recheck and deletion. |
| Drain stays administrative | Controller tests for validated input, role/audit metadata, status reporting and secret-free responses. |
| Deployment matches the plan | Preview and live mount/migration verification are separate operator steps; local tests do not establish live readiness. |

Run the applicable `make test:apps:infra`, `make test:apps:infra-config`, and API
targets. Add meaningful updates to configuration and runner operations docs.

## Delivery slices

Keep publication separate from implementation. Proposed reviewable slices:

- [ ] Explicit fleet configuration and stable slot resolution: about 150–200 production lines, with parser/identity tests.
- [ ] Per-host provider sizing and consistent primary registration: about 80–120 production lines, with wiring tests.
- [ ] Administrator drain progress and completion-aware retirement: about 150–200 production lines, with regression tests.
- [ ] Rollout examples, retirement procedure and integration validation.

Infrastructure `*.test.ts` files count toward the repository's 400-line PR cap;
split test-heavy slices further if measurement requires it. No PR or issue is
published without separate authorization.

## CI extension: request drain only

Add a manual `runner-drain.yml` workflow to set `draining=true` for explicitly named runners. Completion means that the API accepted the state changes. Polling, stopping boxes, changing primary, editing fleet declarations, deleting registrations, and cloud retirement remain outside this workflow.

### Evidence and choices

- The existing [deployment workflow](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/.github/workflows/mdeploy-all.yml#L369) already restores the stage declaration, selects AWS/GCP federation, and binds the stage Environment. Reuse these steps and its `mdeploy-all-<stage>` concurrency group; invoking deployment would have unrelated infrastructure effects.
- The [runner update command](https://github.com/boxlite-ai/boxlite/blob/b9ae581f728b1be17e0d00ef25b9be038553a83c/apps/infra/mdeploy/src/runner-update.ts#L219) supplies the local CLI pattern: resolve stage, respect protected-stage confirmation, check login, and use `resolveHome`. Read the encrypted stage store once using `readEnvironment`; consume only `STACK_DOMAIN`, `ADMIN_API_KEY`, and `DEFAULT_REGION_ID` (default `us`). Avoid a second copy of the admin key in GitHub.
- The working-tree drain controller from this design adds administrator-only `PATCH /api/admin/runners/:id/draining`, returning 204. The existing list endpoint exposes names, UUIDs, regions and lifecycle states, but its DTO does not expose `draining`. Resolve targets from one list call; send true explicitly rather than infer current drain state. Repeating true can reset the backend's clean-check counter. Reject already decommissioned targets before writes.
- [GitHub script-injection guidance](https://docs.github.com/en/actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks) recommends intermediate environment variables. Pass inputs through quoted environment variables, never interpolate free text into shell source.
- [GitHub concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency#using-concurrency-in-different-scenarios) allow shared groups across workflows. Use `cancel-in-progress: false` to keep an active deployment or drain request running; this is mutual exclusion, not a guarantee to preserve every pending dispatch.

### Operation and failure behavior

Inputs are stage (`dev`/`prod`), comma-separated control-plane runner names, and confirmation required only by a protected stage. Preserve the existing main-only production gate and GitHub Environment protections. The new CLI validates the complete input and resolves every name uniquely within the configured API region before any PATCH. Deduplicate names and reject empty, wildcard, malformed, unknown, ambiguous or terminal targets.

Derive the HTTPS API origin using the existing `publicHostsFor` rule, validate the configured domain, and refuse redirects. Keep credentials in memory, mask the admin key in GitHub logs, bound each API request, and omit API bodies and transport details from errors. Sequential PATCH calls log each accepted runner. An error exits nonzero and leaves earlier accepted changes intact; there is no automatic rollback or retry. Reconcile API state after uncertain transport failures.

The CLI never queries drain counters or waits for migration. It neither creates nor removes any cloud resource. Prerequisite: the target API already serves the drain PATCH endpoint.

### Validation

Exercise the CLI across its fetch boundary: exact target UUIDs and true payloads; region filtering; invalid or ambiguous targets cause zero writes; terminal targets, authorization failures, malformed responses, redirects and transport failures stop execution; partial success remains visible without further writes. Verify protected-stage refusal before cloud access. Workflow checks cover dispatch-only triggers, safe input wiring, shared concurrency, stage/branch gates and no deployment step. Run `make test:apps:infra`, mdeploy typechecking, and workflow lint locally; do not dispatch against live runners for validation.

## Sandbox resource limits extension

Default organizations allow 16 vCPU, 32 GiB memory and 100 GiB disk per box.
The console already defines Small as 1/1/10, Medium as 2/4/20 and Large as 4/8/50;
raising organization quotas makes the existing presets usable without new UI caps.
Custom continues to read the organization response, and API admission uses the
existing shared quota validator. Memory remains binary: 32 GiB is 32768 MiB.

PostgreSQL [column defaults](https://www.postgresql.org/docs/current/ddl-alter.html#DDL-ALTER-COLUMN-DEFAULT)
affect future inserts. A new pre-deploy migration therefore changes both defaults
and existing organizations whose complete quota tuple is still 4/8/10. All other
tuples remain unchanged, including partial overrides and unlimited values. There
is no provenance marker to distinguish an explicit 4/8/10 override from the old
default. Existing boxes retain their resources. Rollback restores future defaults
only, preserving existing quotas because later customizations cannot be recovered.

Real PostgreSQL tests cover default inserts, backfill, exceptions, repeat execution,
rollback, serialization and REST admission. Console tests cover preset payloads,
Custom boundaries and over-limit hints. A real maximum-size guest still requires
validation on a runner with sufficient capacity; local tests do not establish it.
