# REST Test Utilities

Utilities in this directory support the reusable REST API test workflow.

## Inventory

Run:

```bash
make test:rest:inventory
```

This parses `openapi/box.openapi.yaml`, scans candidate REST/E2E/CLI test files,
and writes:

- `target/rest-test-report/rest-inventory.md`
- `target/rest-test-report/rest-inventory.json`

The report is intentionally conservative. `candidate` means matching test text
exists; it does not claim the operation is fully asserted.

## CLI matrix

Run against a deployed or local REST API:

```bash
make test:rest:cli AUTH=api-key SCOPE=smoke
make test:rest:cli AUTH=oidc SCOPE=full
```

See `scripts/test/rest/cli-matrix.md` for the command matrix, required
environment, skip policy, and artifacts.

## E2E auth matrix

Run the existing REST SDK -> API -> Runner -> VM suite with an explicit auth
mode:

```bash
make test:rest:e2e AUTH=api-key
BOXLITE_E2E_PROFILE=oidc make test:rest:e2e AUTH=oidc
```

`AUTH=oidc` uses `BOXLITE_E2E_OIDC_TOKEN` or a stored OIDC profile
`access_token`. Stored OIDC profiles are refreshed through `boxlite auth
whoami` before the Python SDK runtime is built. Both modes discover
`path_prefix` from `/v1/me` unless `BOXLITE_E2E_PREFIX` is set.

Local preparation, Dex login and CLI matrix commands using the same isolated
environment are in [the E2E runbook](../../../apps/e2e/README.md#running-against-local-stack).

## Aggregate report

```bash
make test:rest:report
```

This writes `target/rest-test-report/rest-report.md` from existing inventory,
CLI matrix and `target/e2e/runs/<id>/` artifacts. Each recorded E2E run gets a
`summary.md` reconciling pytest phase events with JUnit. Failures, skips, xfails,
unexpected passes and incomplete evidence remain separate; offline harness
guards do not count as VM coverage. A complete report can describe failed tests.
Missing or damaged evidence is marked incomplete, and later success never
rewrites an earlier run's verdict. `BOXLITE_E2E_STATE_DIR` selects another state.
