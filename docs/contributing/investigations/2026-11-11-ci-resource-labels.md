**Status:** Implemented

## TL;DR

CI resource labels select actual Box CPU, memory and disk through the shared listener, preserving existing authorization and recovery.

## Contract

`runs-on: boxlite` uses configured CPU and memory with 10 GiB disk.
`runs-on: boxlite-2vcpu-4gbmem-10gbdisk` requests 2 vCPU, 4096 MiB RAM and 10 GiB disk.
The shared parser enforces whole positive quantities, runtime bounds and exactly one routing label.
The complete contract lives in the [Listener README](../../../apps/libs/ci-listener/README.md#resource-labels).

## Design and evidence

The [design](https://www.notion.so/4158d8d9717981af9daefa13c512f6c5) compares static resource pools, persistent specifications and original-job rereads.
It received an independent PASS before implementation; advice favored one immutable selection and lazy recovery reads.

GitHub labels provide routing and the [JIT endpoint](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
accepts explicit labels. Neither allocates Box resources; the host request must carry the parsed quantities.
GitLab's [bounded per-job resource overrides](https://docs.gitlab.com/runner/executors/kubernetes/#overwrite-the-containers-resources)
support retaining administrator ceilings on job-selected resources.

## Mechanism

```text
Webhook / compensation → original GitHub job → shared resource and label selection
  → WorkerLaunch → native BoxService / authenticated REST → actual Box
  → GitHub JIT registration with the same selected routing label
```

The native adapter converts MiB to the platform's GiB memory field and forwards disk explicitly.
The REST adapter forwards `memory_mib` and `disk_size_gb`.
BoxService resolves organization resource ceilings; Commerce quota still fences actual Box persistence.
A typed pre-persistence resource denial uses the existing original-operation rejection ledger and releases capacity.
Other errors retain their existing uncertainty rules.

No resource fields are added to durable allocations.
A reservation without a create attempt rereads its original job before launching.
An uncertain create recovers the original Box ID before any optional job read; it never repeats POST.
A running worker with pending registration rereads the original job for its JIT label.
New jobs and reruns make a new selection; existing delivered workers retain their original lifecycle.

Runner-group names, internal modules and query keys retain their separate identities.
The Dashboard keeps its compact capacity summary, shared filter, disk quantities and Applications navigation.

## Verification

This is a new resource-label contract: the base only supported a fixed routing label and global CPU/memory settings.
Full-revert defect proof is not applicable to the new grammar and per-label allocation.
Tests cover parser boundaries and rejection, signed webhook validation, compensation publication,
native DTO and REST requests, actual JIT labels, organization and Commerce denials, and original-ID recovery.
PostgreSQL tests use the same `DB_*` settings and isolated-schema fixtures as other API modules.

| Check | Observed result |
| --- | --- |
| `make test:apps:ci-listener` with standard local `DB_*` settings | 689 tests passed, including both database adapters. |
| `make test:apps:github-ci-runner` | 152 tests passed. |
| `make test:apps:api TEST_FILES='ci/\|1793700000000-add-ci-listener-state-migration.spec\|1793664000000-add-ci-connect-migration.spec\|box.service.quota.spec'` | 354 tests passed on Node 24 with real local PostgreSQL. |
| `make test:apps:dashboard` on Node 24 | 1044 tests passed. |
| `make test:apps:ci-listener FILTER='CI shared state'` without `DB_HOST` | 28 SQLite tests passed; PostgreSQL cases skipped. |
| `make test:unit:cli NEXTEST_PROFILE_FLAG=commands::ci::` with dependency stubs | 3 CI command tests passed. |
| `make build:apps:ci-listener`, `make build:apps:github-ci-runner`, `make build:apps:api` | All builds passed. |
| `make fmt:apps FILES=…`, `make fmt:check:rust`, `git diff --check` | Passed for the changed files. |

The native resource-refusal correction also has full-revert defect proof.
With every resource-feature production change restored to its base state, the test reached its rejection assertion and failed:
expected `ConfirmedWorkerCreationRejected`, received `BadRequestException`.
A temporary test-only adapter allowed skipped new-label tests to compile; it changed no defect assertion or production code.
After removing that adapter and restoring all production changes, the same test passed.

Unresolved validation outside this change: full app lint reports three module-boundary errors in the unchanged infra release-audit tests.
The full CLI unit suite retains an unrelated SSH configure test returning HTTP 503; CI command tests pass independently.
The default Node 26 environment failed Dashboard localStorage setup; Node 24 passed the complete suite.
No live GitHub Actions job or VM provisioning acceptance run was performed.
